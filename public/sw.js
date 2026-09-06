// Service Worker v4：缓存优先 + 两梯队预热 + 点击优先
// 策略：
//  1. fetch = 缓存优先（秒回）+ 后台静默更新（stale-while-revalidate）
//  2. 安装后后台预热：梯队一 = 默认视图（皮条往事）下前 6 篇（含置顶，动态取，非固定），
//     200ms 间隔快跑；梯队二 = 其余文章/核心页，700ms 间隔慢跑
//  3. 用户点击导航瞬间：掐掉预热正在进行的请求 + 暂停全部预热 6 秒，整条线路让给点击
//  4. 访客回到首页时自动补预热新发布的文章（无需升级 SW）
const CACHE = "jiaoyu-v4";
const WARM_DELAY_MS = 700;
const PRIORITY_COUNT = 6;
const FAST_DELAY_MS = 200;

let currentCtrl = null;      // 预热正在进行的那一个请求的控制器
let warmPausedUntil = 0;     // 预热暂停到什么时候（用户点击时设置）
let rewarmRunning = false;   // 防止补预热重入

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => warmSite())
  );
});

// fetch：缓存优先 + 后台更新；任何"用户在等"的未命中请求 → 预热让路 6 秒；首页更新后 → 补预热新文章
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // 不缓存跨域（chat.waiwei.top 等）

  const isWarm = request.headers.get("x-warm") === "1";

  // 不带 x-warm 且缓存未命中 = 用户此刻真的要内容（点文章/预载卡片）→
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
            // 回到首页（含 SPA 切回）→ 稍后补预热新发布的文章
            if (url.pathname === "/" && !isWarm) {
              setTimeout(warmNewLinks, 4000);
            }
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

// 带可掐断控制的预热请求（一次一个，打 x-warm 标记，避免触发自己的让路逻辑）
function fetchWarm(path) {
  currentCtrl = new AbortController();
  return fetch(path, { signal: currentCtrl.signal, headers: { "x-warm": "1" } }).finally(() => {
    if (currentCtrl && currentCtrl.signal.aborted) currentCtrl = null;
  });
}

// ---------- 解析首页卡片（warmSite / warmNewLinks 共用）----------
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

// ---------- 后台预热（首次安装，全量两梯队）----------
async function warmSite() {
  try {
    const cache = await caches.open(CACHE);
    // 已预热过就不再全量跑（新文章由 warmNewLinks 补）
    if (await cache.match("/__warmed__")) return;

    const res = await fetch("/", { headers: { "x-warm": "1" } });
    if (!res || !res.ok) return;
    const html = await res.text();
    const cards = parseCards(html);

    // 梯队一：默认视图（皮条往事）下最新的前 6 篇（置顶自动排第一，动态非固定）
    const tier1 = cards
      .filter((c) => c.tags.includes("皮条往事"))
      .slice(0, PRIORITY_COUNT)
      .map((c) => c.href);
    const t1set = new Set(tier1);

    for (const path of tier1) {
      await waitIfPaused();
      await sleep(FAST_DELAY_MS);
      if (await cache.match(path)) continue;
      try {
        const r = await fetchWarm(path);
        if (r && r.status === 200) await cache.put(path, r);
      } catch (_) {
        /* 被掐断/单篇失败都跳过 */
      }
    }

    // 梯队二：其余文章 + 核心页，慢跑让路
    const rest = [
      ...cards.filter((c) => !t1set.has(c.href)).map((c) => c.href),
      "/about/",
      "/purchase/",
      "/avatar.png",
    ];
    for (const p of rest) {
      await waitIfPaused();
      await sleep(WARM_DELAY_MS);
      if (await cache.match(p)) continue;
      try {
        const r = await fetchWarm(p);
        if (r && r.status === 200) await cache.put(p, r);
      } catch (_) {}
    }

    await cache.put("/__warmed__", new Response("ok"));
  } catch (_) {
    /* 预热失败静默，下次 activate 再试 */
  }
}

// ---------- 补预热新文章（访客回到首页触发；只补缓存里没有的）----------
async function warmNewLinks() {
  if (rewarmRunning) return;
  rewarmRunning = true;
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
