/**
 * 账单口径：商户名归一 + MCC 分类 + 退款冲正。
 *
 * 三件事分开做，是因为它们解决的是三个不同的问题：
 * 归一解决「同一家店在不同分支、不同写法下算几个商户」；
 * MCC 解决「分类不该由商户名里的关键词硬编码决定，行业内是有标准码的」；
 * 冲正解决「退回来的钱要从支出里扣掉，而不是当成一笔负的收入」。
 */

/** 商户名归一：全角折半角、去括号备注、去分支后缀、去空白、英文统一大写。 */
export function normalizeMerchant(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\([^)]*\)/g, "")
    .replace(/[-—–_·•]\s*[^-—–_·•]*$/u, "")
    .replace(/(官方旗舰店|旗舰店|专卖店|分店|门店|店)$/u, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
}

export interface MccRule {
  /** 行业标准码，真实系统里来自 MCC 表。 */
  mcc: string;
  category: string;
  /** 命中任一关键词即归到该类。 */
  keywords: string[];
}

/**
 * MCC 规则表：只收演示会用到的几类，顺序即优先级。
 * 「订阅代扣」放在「数码」之前，否则「云盘 2T」会被当成卖硬盘的。
 */
export const MCC_RULES: MccRule[] = [
  { mcc: "5818", category: "订阅代扣", keywords: ["会员", "订阅", "云幕", "云端", "云笔记", "云盘", "续费"] },
  { mcc: "5812", category: "餐饮", keywords: ["面馆", "餐厅", "聚餐", "咖啡", "星巴克", "火锅", "快餐", "奶茶", "食堂"] },
  { mcc: "5732", category: "数码", keywords: ["数码", "电器", "家电", "手机", "电脑", "极光", "相机"] },
  { mcc: "4111", category: "交通", keywords: ["地铁", "出行", "机票", "打车", "高铁", "旅游", "航空"] },
  { mcc: "5311", category: "购物", keywords: ["超市", "生鲜", "服饰", "网购", "百货", "商城", "便利"] },
  { mcc: "4900", category: "生活缴费", keywords: ["水电", "燃气", "缴费", "物业", "健身"] },
];

export interface MerchantClass {
  /** 归一后的商户名，账单一律按它分组。 */
  normalized: string;
  mcc: string;
  category: string;
  /** 命中的关键词；没命中就是空串，分类落到「其他」。 */
  matched: string;
}

/** 分类：先归一，再按关键词表匹配，匹配不到归「其他」而不是猜一个。 */
export function classifyMerchant(raw: string): MerchantClass {
  const normalized = normalizeMerchant(raw);
  for (const rule of MCC_RULES) {
    const matched = rule.keywords.find((keyword) => normalized.includes(keyword.toUpperCase()));
    if (matched !== undefined) return { normalized, mcc: rule.mcc, category: rule.category, matched };
  }
  return { normalized, mcc: "0000", category: "其他", matched: "" };
}

/**
 * 异常口径：不再写死「3000 元以上」这种绝对值。
 * 单笔明显偏离同类均值（3 倍且不低于 300 元）才算异常 —— 这样买一台电脑不会天天报警，
 * 而一笔远高于日常餐饮的餐厅消费会被看见。凌晨的小额也单列，因为那是盗刷的典型时段。
 */
export const BILL_ANOMALY = {
  categoryMultiplier: 3,
  minimumCents: 30000,
  lateNightStartHour: 0,
  lateNightEndHour: 6,
  lateNightMinCents: 20000,
};
