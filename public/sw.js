// Service Worker v3：缓存优先 + 后台预热全站文章
// 策略：
//  1. fetch = 缓存优先（秒回）+ 后台静默更新（stale-while-revalidate）
//  2. 安装后后台预热：两梯队——梯队一 = 默认视图（皮条往事）下前 6 篇，200ms 间隔快跑；
//     梯队二 = 其余文章/核心页，700ms 间隔慢跑让路。点击永远优先于预热。
const CACHE = "jiaoyu-v4";
const WARM_DELAY_MS = 700;

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

// fetch：缓存优先 + 后台更新；没缓存走网络（失败回退缓存）
self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // 不缓存跨域（chat.waiwei.top 等）

  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// ---------- 后台预热（两梯队：前6篇快跑优先，其余慢跑让路）----------
// 首页 HTML 里文章卡片的 DOM 顺序 = 置顶+最新优先（用户最可能点的），直接沿用
const PRIORITY_COUNT = 6;
const FAST_DELAY_MS = 200; // 第一梯队间隔：尽快备齐首屏文章

async function warmSite() {
  try {
    const cache = await caches.open(CACHE);
    // 已预热过就不再拉首页解析（首页 HTML 里做个标记）
    if (await cache.match("/__warmed__")) return;

    const res = await fetch("/");
    if (!res || !res.ok) return;
    const html = await res.text();

    // 解析首页卡片：<li class="article-item" data-tags="..."> 紧跟 <a href="/posts/x/">
    // 保留 tags，用于挑出"默认视图（皮条往事）下可见"的文章优先预热
    const cards = [];
    const re = /<li class="article-item" data-tags="([^"]*)"[^>]*>\s*<a href="(\/posts\/[^"\/]+\/)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const slug = m[2].replace("/posts/", "").replace(/\//g, "");
      if (!/^\d+$/.test(slug)) cards.push({ tags: m[1], href: m[2] });
    }

    // 梯队一：默认视图下前 6 篇可见文章（带皮条往事标签），200ms 间隔快速备齐
    const tier1 = cards.filter(c => c.tags.includes("皮条往事")).slice(0, PRIORITY_COUNT).map(c => c.href);
    const t1set = new Set(tier1);

    for (const path of tier1) {
      await sleep(FAST_DELAY_MS);
      if (await cache.match(path)) continue;
      try {
        const r = await fetch(path);
        if (r && r.status === 200) await cache.put(path, r);
      } catch (_) {
        /* 单篇失败不影响后续 */
      }
    }

    // 梯队二：其余文章（小说等）+ 核心页，700ms 间隔慢跑，随时给点击让路
    const rest = [
      ...cards.filter(c => !t1set.has(c.href)).map(c => c.href),
      "/about/", "/purchase/", "/avatar.png",
    ];
    for (const p of rest) {
      await sleep(WARM_DELAY_MS);
      if (await cache.match(p)) continue;
      try {
        const r = await fetch(p);
        if (r && r.status === 200) await cache.put(p, r);
      } catch (_) {}
    }

    await cache.put("/__warmed__", new Response("ok"));
  } catch (_) {
    /* 预热失败静默，下次 activate 再试 */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
