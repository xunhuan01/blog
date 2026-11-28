// 会员三档 · 单一数据源（2026-11-28）
//
// 背景：付费文章密码遮罩里的「购买会员 · ¥199 起」原先硬编码成快发卡
// (w.kami.vip/s/4eQNQ28G)，而会员组件用的是酷发卡 (kufaka.com/item/gx7eky)，
// 两个 199 指向两个不同的发卡平台。现在全站只从这里取链接：
//   · src/components/PurchaseTiers.astro   —— 会员三档清单
//   · src/pages/posts/[...slug]/index.astro —— 付费文章遮罩的购买入口
// 以后换发卡平台 / 改价格，只改这个文件，不要再往组件里硬编码。
//
// 发卡平台：酷发卡 https://www.kufaka.com （2026-10-18 起三档商品都建在这里）

export type MembershipTier = {
  id: string;
  name: string;
  price: string;
  desc: string[];
  href: string;
  cta: string;
  gold: boolean;
  limit: string;
};

export const membershipTiers: MembershipTier[] = [
  {
    id: "bronze",
    name: "青铜会员",
    price: "199",
    desc: ["解锁资源墙 · 会员群 · 付费文章"],
    href: "https://www.kufaka.com/item/gx7eky",
    cta: "开通",
    gold: false,
    limit: "",
  },
  {
    id: "gold",
    name: "黄金会员",
    price: "499",
    desc: ["含青铜会员全部权益", "定金，安排外围找客服私聊"],
    href: "https://www.kufaka.com/item/dczf9x",
    cta: "开通",
    gold: false,
    limit: "",
  },
  {
    id: "diamond",
    name: "钻石会员",
    price: "6999",
    desc: ["含黄金会员全部权益", "《通往性自由之路》"],
    href: "/通往性自由之路",
    cta: "服务介绍",
    gold: true,
    limit: "限购 500 份",
  },
];

/** 青铜档（¥199）：付费文章遮罩的购买入口指向它 */
export const bronzeTier = membershipTiers[0];
