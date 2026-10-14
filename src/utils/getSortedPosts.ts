import type { CollectionEntry } from "astro:content";
import { postFilter } from "./postFilter";

/** 标题里的中文序号（一~十）。 */
const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/**
 * 从标题里认出「（一）」「(2)」这种序号 —— 系列文章靠它自动排 1、2、3、4…
 * （2026-10-21 作者要求：皮条生涯 1/2/3/4 选中「皮条往事」标签时按序置顶，
 *   但**不许出现「置顶」标记**，所以只在排序里用，不渲染任何东西。）
 * frontmatter 里的 order 字段优先级更高（想手排时用它）。
 */
function seriesOrder(title: string): number | null {
  const m = /[（(]\s*(\d{1,2}|[一二三四五六七八九十])\s*[)）]/.exec(title || "");
  if (!m) return null;
  const raw = m[1];
  return /^\d+$/.test(raw) ? Number(raw) : (CN_NUM[raw] ?? null);
}

/**
 * Returns posts that are eligible to be shown to users, sorted by “last updated”
 * descending (uses `modDatetime` when present, otherwise `pubDatetime`).
 *
 * Note: filtering respects drafts and scheduled posts via `postFilter()`.
 */
export function getSortedPosts(posts: CollectionEntry<"posts">[]) {
  const when = (p: CollectionEntry<"posts">) =>
    Math.floor(new Date(p.data.modDatetime ?? p.data.pubDatetime).getTime() / 1000);
  const orderOf = (p: CollectionEntry<"posts">) => {
    if (typeof p.data.order === "number") return p.data.order;
    return seriesOrder(String(p.data.title || ""));
  };

  return posts.filter(postFilter).sort((a, b) => {
    // 带 order 的系列文章排最前、按 order 升序（皮条往事（一）(二)(三)…）；
    // 其余按「最后更新」倒序。2026-10-21 作者要求：只改顺序，**不显示任何置顶标记**。
    const orderA = orderOf(a);
    const orderB = orderOf(b);
    if (orderA !== null || orderB !== null) {
      if (orderA === null) return 1;
      if (orderB === null) return -1;
      if (orderA !== orderB) return orderA - orderB;
    }
    return when(b) - when(a);
  });
}
