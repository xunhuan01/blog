// Service Worker v3：缓存优先 + 后台预热全站文章
// 策略：
//  1. fetch = 缓存优先（秒回）+ 后台静默更新（stale-while-revalidate）
//  2. 安装后后台把首页列出的全部文章逐篇预热进缓存（严格串行 + 700ms 间隔让路，
//     用户点击的请求永远有空闲连接，不会被预热抢线）
const CACHE = "jiaoyu-v3";
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

// ---------- 后台预热 ----------
async function warmSite() {
  try {
    const cache = await caches.open(CACHE);
    // 已预热过就不再拉首页解析（首页 HTML 里做个标记）
    if (await cache.match("/__warmed__")) return;

    const res = await fetch("/");
    if (!res || !res.ok) return;
    const html = await res.text();

    // 从首页 HTML 抓文章链接（/posts/<slug>/，排除分页 /posts/2/ 这类纯数字）
    const slugs = new Set();
    const re = /href="(\/posts\/[^"\/]+\/)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1].replace("/posts/", "").replace(/\//g, "");
      if (!/^\d+$/.test(slug)) slugs.add(m[1]);
    }

    // 串行逐篇：每篇之间歇 700ms，给用户点击让路；已在缓存的跳过
    for (const path of slugs) {
      await sleep(WARM_DELAY_MS);
      if (await cache.match(path)) continue;
      try {
        const r = await fetch(path);
        if (r && r.status === 200) await cache.put(path, r);
      } catch (_) {
        /* 单篇失败不影响后续 */
      }
    }

    // 顺手把核心页也补进缓存
    for (const p of ["/about/", "/purchase/", "/avatar.png"]) {
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
