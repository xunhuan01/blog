// Service Worker v5：零抢跑策略
// 策略：
//  1. 新访客打开首页：什么都不预载、不预热
//  2. 他点文章：全力加载那一篇（预热必须让路），页面立刻切"正在加载"骨架屏
//  3. 他开始阅读后（页面加载成功 +3 秒）：后台静默把全站文章逐篇备好
//     （梯队：缓存里没有的才拉；严格串行 + 间隔，随时可被点击掐断/暂停 6 秒）
//  4. 中途点别的文章：同 2，掐断预热全力加载目标；读完继续预热剩下的
//  5. 回到首页时：补预热新发布的文章（限流：两次预热至少间隔 60 秒）
const CACHE = "jiaoyu-v5";
const WARM_DELAY_MS = 700;
const WARM_START_DELAY_MS = 3000;   // 阅读开始后等多久才开跑
const WARM_THROTTLE_MS = 60000;     // 两次预热之间最小间隔

let currentCtrl = null;
let warmPausedUntil = 0;
let rewarmRunning = false;
let lastWarmAt = 0;
let warmTimer = null;

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
    // ⚠️ 不在这里预热：新访客打开首页时不加载任何多余东西
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // 不缓存跨域（chat.waiwei.top 等）

  const isWarm = request.headers.get("x-warm") === "1";

  // 不带 x-warm 且缓存未命中 = 用户此刻真的要内容（点文章/切页面）→
  // 立即掐掉预热在跑的请求 + 暂停 6 秒，整条线路让给他
  if (!isWarm) {
    caches.match(request).then((hit) => {
      if (!hit) pauseWarm(6000);
    });
  }

  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
            // 用户成功打开了一个页面（开始阅读）→ 稍后开始/继续后台预热
            if (!isWarm) scheduleWarm();
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------- 点击优先 ----------
function pauseWarm(ms) {
  if (currentCtrl) {
    try { currentCtrl.abort(); } catch (_) {}
    currentCtrl = null;
  }
  warmPausedUntil = Date.now() + ms;
}

async function waitIfPaused() {
  while (Date.now() < warmPausedUntil) await sleep(500);
}

// 预热请求：打 x-warm 标记（不触发让路逻辑），一次一个，可被掐断
function fetchWarm(path) {
  currentCtrl = new AbortController();
  return fetch(path, { signal: currentCtrl.signal, headers: { "x-warm": "1" } }).finally(() => {
    if (currentCtrl && currentCtrl.signal.aborted) currentCtrl = null;
  });
}

// ---------- 阅读后触发预热 ----------
function scheduleWarm() {
  if (rewarmRunning) return;
  const since = Date.now() - lastWarmAt;
  const wait = since < WARM_THROTTLE_MS ? WARM_THROTTLE_MS - since : WARM_START_DELAY_MS;
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    const cacheReady = caches.open(CACHE).then((c) => c.match("/__warmed__"));
    cacheReady.then((warmed) => (warmed ? warmNewLinks() : warmSite()));
  }, wait);
}

// ---------- 解析首页卡片（共用）----------
// <li class="article-item" data-tags="..."> 紧跟 <a href="/posts/x/">；顺序 = 显示顺序（置顶优先）
function parseCards(html) {
  const cards = [];
  const re = /<li class="article-item" data-tags="([^"]*)"[^>]*>\s*<a href="(\/posts\/[^"\/]+\/)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const slug = m[2].replace("/posts/", "").replace(/\//g, "");
    if (!/^\d+$/.test(slug)) cards.push({ tags: m[1], href: m[2] });
  }
  return cards;
}

// ---------- 全量预热（首次阅读后跑一次）----------
async function warmSite() {
  if (rewarmRunning) return;
  rewarmRunning = true;
  lastWarmAt = Date.now();
  try {
    const cache = await caches.open(CACHE);

    const res = await fetch("/", { headers: { "x-warm": "1" } });
    if (!res || !res.ok) return;
    const html = await res.text();
    const cards = parseCards(html);

    // 皮条往事栏目（默认视图）排前，其余跟上；全部备好
    const ordered = [
      ...cards.filter((c) => c.tags.includes("皮条往事")).map((c) => c.href),
      ...cards.filter((c) => !c.tags.includes("皮条往事")).map((c) => c.href),
      "/about/",
      "/purchase/",
      "/avatar.png",
    ];

    for (const p of ordered) {
      await waitIfPaused();
      await sleep(WARM_DELAY_MS);
      if (await cache.match(p)) continue;
      try {
        const r = await fetchWarm(p);
        if (r && r.status === 200) await cache.put(p, r);
      } catch (_) {
        /* 被掐断/单篇失败都跳过 */
      }
    }

    await cache.put("/__warmed__", new Response("ok"));
  } catch (_) {
    /* 静默 */
  } finally {
    rewarmRunning = false;
  }
}

// ---------- 补预热新文章（每次阅读后触发，60 秒限流）----------
async function warmNewLinks() {
  if (rewarmRunning) return;
  rewarmRunning = true;
  lastWarmAt = Date.now();
  try {
    const cache = await caches.open(CACHE);
    if (!(await cache.match("/__warmed__"))) return; // 还没全量预热过，交给 warmSite

    const res = await fetch("/", { headers: { "x-warm": "1" } });
    if (!res || !res.ok) return;
    const html = await res.text();
    const hrefs = parseCards(html).map((c) => c.href);

    for (const path of hrefs) {
      await waitIfPaused();
      await sleep(WARM_DELAY_MS);
      if (await cache.match(path)) continue;
      try {
        const r = await fetchWarm(path);
        if (r && r.status === 200) await cache.put(path, r);
      } catch (_) {}
    }
  } catch (_) {
    /* 静默 */
  } finally {
    rewarmRunning = false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
