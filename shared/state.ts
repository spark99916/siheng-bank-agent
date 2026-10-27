/** 领域状态与工具执行：金额一律整数分。 */

import { BILL_ANOMALY, classifyMerchant } from "./bills.ts";

export interface Account {
  holder: string;
  balance: number;
  available: number;
}

export interface Card {
  id: string;
  label: string;
  status: "active" | "locked" | "lost" | "pending";
  limitCents: number;
}

/** 预约转账：只登记，到期不自动扣款 —— 用户不在场时钱不能自己走。 */
export interface ScheduledTransfer {
  id: string;
  payee: string;
  amountCents: number;
  dueAt: string;
  status: "scheduled" | "cancelled";
}

export interface Subscription {
  id: string;
  name: string;
  amountCents: number;
  nextChargeAt: string;
  autoRenew: boolean;
}

export interface Holding {
  id: string;
  productId: string;
  amountCents: number;
}

export interface LockedFund {
  id: string;
  purpose: string;
  amountCents: number;
  lockUntil: string;
  status: "locked" | "spent";
}

/** 通讯录：手机号要能映射成可信姓名，判定里的「是否首次」也从这里对。 */
export interface Contact {
  name: string;
  phone: string;
}

/** 转账流水：判定只读它算日累计与频次，执行时写入。 */
export interface TransferRecord {
  payee: string;
  amountCents: number;
  at: number;
}

/**
 * 账单流水：只读数据，账单分析按时间窗口聚合。
 * 不存分类，分类在分析时由商户名经 MCC 表推出 —— 存下来就会和商户名对不上。
 * 退款单独记一条 kind=refund 并用 refundOf 指向原交易，冲正才做得准。
 */
export interface BillRecord {
  id: string;
  at: number;
  merchant: string;
  amountCents: number;
  channel: string;
  kind: "purchase" | "refund";
  /** 退款对应的原交易 id。 */
  refundOf?: string;
}

/** 理财产品的本地副本：判定要用它做适当性校验，不能依赖外部服务在线。 */
export interface WealthProduct {
  id: string;
  name: string;
  riskLevel: number;
  annualRate: number;
  minAmountCents: number;
  feeRate: number;
}

/** 客户风险承受等级：1 保守 到 5 进取，高于本级的产品不予申购。 */
export interface CustomerProfile {
  riskLevel: number;
  assessedAt: string;
}

export interface BankState {
  account: Account;
  cards: Card[];
  subscriptions: Subscription[];
  holdings: Holding[];
  lockedFunds: LockedFund[];
  contacts: Contact[];
  transferLog: TransferRecord[];
  bills: BillRecord[];
  wealthProducts: WealthProduct[];
  customer: CustomerProfile;
  scheduledTransfers: ScheduledTransfer[];
}

export const RISK_LABEL: Record<number, string> = {
  1: "保守型",
  2: "稳健型",
  3: "平衡型",
  4: "成长型",
  5: "进取型",
};

/** 产品目录：与 mcp/catalog-server.mjs 的演示数据保持一致，判定只读本地这份。 */
export const WEALTH_PRODUCTS: WealthProduct[] = [
  { id: "p-001", name: "稳盈货币 A", riskLevel: 1, annualRate: 0.018, minAmountCents: 100, feeRate: 0 },
  { id: "p-002", name: "安享固收 90 天", riskLevel: 2, annualRate: 0.029, minAmountCents: 100000, feeRate: 0.001 },
  { id: "p-003", name: "平衡配置混合", riskLevel: 3, annualRate: 0.045, minAmountCents: 100000, feeRate: 0.006 },
  { id: "p-004", name: "进取成长股票", riskLevel: 4, annualRate: 0.072, minAmountCents: 500000, feeRate: 0.012 },
  { id: "p-005", name: "科技主题精选", riskLevel: 5, annualRate: 0.095, minAmountCents: 500000, feeRate: 0.015 },
];

/**
 * 账单样本：按当前时间回推生成，保证「本月/上月/近三月」三个口径都有数据。
 * 商户名故意写脏：带分支括号、带「-旗舰店」后缀、中英文混排 —— 归一化没做好，分类就会散。
 * 另有两笔退款：一笔部分冲正、一笔全额冲正，用来验冲正口径。
 */
/**
 * 账单样本的基准时刻：固定到「当天 14:00」，不跟当前时钟走。
 *
 * 原来写的是 `now - ago * day`，等于把此刻的「时:分」复制到每一笔账单上。
 * 后果是判定随跑测试的时刻变化：凌晨 0—6 点跑，所有账单都落进深夜时段，
 * 被深夜口径整批吃掉，中位数口径一笔都命不中 —— 白天绿、夜里红的测试最难查。
 * 固定在 14:00 后，样本与运行时刻解耦；若 14:00 还没到（凌晨跑），基准退到昨天 14:00，
 * 保证不出现「未来时间的交易」。
 */
function billBaseTime(now: number): number {
  const base = new Date(now);
  base.setHours(14, 0, 0, 0);
  const ms = base.getTime();
  return ms > now ? ms - 86400000 : ms;
}

function seedBills(now: number): BillRecord[] {
  const day = 86400000;
  const base = billBaseTime(now);
  const rows: Array<[number, string, number, string]> = [
    [0, "云幕视频会员", 2500, "代扣"],
    [1, "楼下面馆(国贸店)", 3800, "扫码"],
    [2, "极光数码-旗舰店", 688000, "线上"],
    [3, "地铁出行", 1200, "扫码"],
    [5, "云端音乐", 1500, "代扣"],
    [6, "极光数码-旗舰店", 12800, "线上"],
    [7, "生鲜超市（望京店）", 21600, "刷卡"],
    [8, "优衣库网购服饰", 45600, "线上"],
    [9, "水电燃气缴费", 32600, "代扣"],
    [12, "瑞幸咖啡（望京SOHO店）", 3200, "扫码"],
    [18, "云笔记专业版", 3000, "代扣"],
    [31, "京东家电旗舰店", 268000, "线上"],
    [34, "超级猩猩健身", 19900, "刷卡"],
    [38, "海底捞火锅（三里屯店）", 26800, "刷卡"],
    [45, "百度云盘 2T", 1200, "代扣"],
    [52, "沃尔玛超市（朝阳店）", 28800, "线上"],
    [70, "携程旅游机票", 128000, "线上"],
  ];
  const bills: BillRecord[] = rows.map(([ago, merchant, amountCents, channel], index) => ({
    id: `bill-${String(index + 1).padStart(3, "0")}`,
    // 每笔错开几分钟，避免同一毫秒的排序不稳定。
    at: base - ago * day + index * 7 * 60000,
    merchant,
    amountCents,
    channel,
    kind: "purchase",
  }));
  // 两笔退款：极光数码部分退 1880 元，优衣库全额退 456 元。
  bills.push({
    id: `bill-${String(bills.length + 1).padStart(3, "0")}`,
    at: base - 1 * day,
    merchant: "极光数码-旗舰店 退款",
    amountCents: 188000,
    channel: "线上",
    kind: "refund",
    refundOf: "bill-003",
  });
  bills.push({
    id: `bill-${String(bills.length + 1).padStart(3, "0")}`,
    at: base - 4 * day,
    merchant: "优衣库网购服饰 退款",
    amountCents: 45600,
    channel: "线上",
    kind: "refund",
    refundOf: "bill-008",
  });

  // 故意留一笔深夜交易：凌晨 2 点、456 元的服饰。
  // 深夜小额是盗刷的典型形态，样本里必须有，否则「凌晨 0—6 点」这条口径永远是空跑。
  // 固定写死 2 点，既保住样本，又不让样本随运行时刻漂移。
  const night = bills.find((item) => item.merchant === "优衣库网购服饰");
  if (night !== undefined) {
    const at = new Date(night.at);
    at.setHours(2, 10, 0, 0);
    night.at = at.getTime();
  }
  return bills;
}

export interface ToolResult {
  ok: boolean;
  tool: string;
  message: string;
  data?: unknown;
  error?: string;
}

/** 初始状态：合成数据，金额与比赛演示一致。 */
export function initialState(): BankState {
  const now = Date.now();
  const day = 86400000;
  return {
    account: { holder: "林知远", balance: 3864250, available: 3864250 },
    cards: [
      { id: "card-001", label: "信用卡 1234", status: "active", limitCents: 2000000 },
      { id: "card-002", label: "借记卡 5678", status: "active", limitCents: 1000000 },
    ],
    subscriptions: [
      { id: "sub-001", name: "云幕视频会员", amountCents: 2500, nextChargeAt: new Date(now + 3 * day).toISOString(), autoRenew: true },
      { id: "sub-002", name: "云端音乐", amountCents: 1500, nextChargeAt: new Date(now + 8 * day).toISOString(), autoRenew: true },
      { id: "sub-003", name: "云笔记专业版", amountCents: 3000, nextChargeAt: new Date(now + 15 * day).toISOString(), autoRenew: true },
      { id: "sub-004", name: "云盘 2T", amountCents: 1200, nextChargeAt: new Date(now + 22 * day).toISOString(), autoRenew: false },
    ],
    holdings: [
      { id: "h-001", productId: "p-002", amountCents: 500000 },
      { id: "h-002", productId: "p-001", amountCents: 120000 },
    ],
    lockedFunds: [],
    contacts: [
      { name: "小王", phone: "13800138000" },
      { name: "刘洋", phone: "13900139000" },
      { name: "李四", phone: "13700137000" },
    ],
    transferLog: [],
    bills: seedBills(now),
    wealthProducts: WEALTH_PRODUCTS.map((item) => ({ ...item })),
    customer: { riskLevel: 2, assessedAt: new Date(now - 30 * day).toISOString() },
    scheduledTransfers: [],
  };
}

export function yuanText(cents: number): string {
  return (cents / 100).toFixed(2);
}

function ok(tool: string, message: string, data?: unknown): ToolResult {
  return { ok: true, tool, message, ...(data === undefined ? {} : { data }) };
}

function fail(tool: string, error: string): ToolResult {
  return { ok: false, tool, message: "", error };
}

export function queryBalance(state: BankState): ToolResult {
  return ok("query_balance", `可用余额 ${yuanText(state.account.available)} 元，总余额 ${yuanText(state.account.balance)} 元`, {
    availableCents: state.account.available,
    balanceCents: state.account.balance,
  });
}

/** 账单时间口径。 */
export type BillPeriod = "this-month" | "last-month" | "3-months" | "this-year";

const PERIOD_LABEL: Record<BillPeriod, string> = {
  "this-month": "本月",
  "last-month": "上月",
  "3-months": "近三个月",
  "this-year": "今年",
};

/** 半开区间 [from, to)。 */
function periodRange(period: BillPeriod, now: number): { from: number; to: number } {
  const today = new Date(now);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  if (period === "this-month") return { from: monthStart, to: now + 1 };
  if (period === "last-month") {
    return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime(), to: monthStart };
  }
  if (period === "this-year") {
    return { from: new Date(today.getFullYear(), 0, 1).getTime(), to: now + 1 };
  }
  return { from: new Date(today.getFullYear(), today.getMonth() - 2, 1).getTime(), to: now + 1 };
}

/**
 * 账单分析：按时间窗口聚合，分类走 MCC 表，退款冲正，异常按同类中位数判定。
 * 三个口径都要能解释：净额怎么算出来的、这一笔为什么算异常、订阅代扣占多少。
 */
export function analyzeBills(state: BankState, period: BillPeriod = "this-month"): ToolResult {
  const now = Date.now();
  const { from, to } = periodRange(period, now);
  const label = PERIOD_LABEL[period];
  const rows = state.bills.filter((bill) => bill.at >= from && bill.at < to).map((bill) => ({ ...bill, ...classifyMerchant(bill.merchant) }));
  if (rows.length === 0) {
    return ok("analyze_bills", `${label}没有账单记录`, { period, totalCents: 0, count: 0, categories: [] });
  }

  const purchases = rows.filter((row) => row.kind !== "refund");
  const refunds = rows.filter((row) => row.kind === "refund");
  const gross = purchases.reduce((sum, row) => sum + row.amountCents, 0);
  const refunded = refunds.reduce((sum, row) => sum + row.amountCents, 0);
  const net = gross - refunded;

  // 分类净额：退款按它原本所属的分类扣回去。
  const byCategory = new Map<string, { mcc: string; cents: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.category) ?? { mcc: row.mcc, cents: 0 };
    entry.cents += row.kind === "refund" ? -row.amountCents : row.amountCents;
    byCategory.set(row.category, entry);
  }
  const categories = [...byCategory.entries()]
    .map(([name, item]) => ({
      name,
      mcc: item.mcc,
      cents: item.cents,
      share: net > 0 ? Math.round((Math.max(0, item.cents) / net) * 100) : 0,
    }))
    .sort((a, b) => b.cents - a.cents);

  /**
   * 中位数：比均值抗离群。更关键的是算基准时把「被判断的这一笔」排除掉，
   * 否则同类只有两笔时，中位数就等于两笔的平均，大额那笔永远判不出异常。
   */
  const medianOf = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  };

  /** 同类其他交易：存的是「这笔支出在 purchases 里的下标」，算基准时按它把自己摘掉。 */
  const peersOf = new Map<string, Array<{ index: number; cents: number }>>();
  for (const [index, row] of purchases.entries()) {
    const list = peersOf.get(row.category) ?? [];
    list.push({ index, cents: row.amountCents });
    peersOf.set(row.category, list);
  }

  const anomalies: Array<{ merchant: string; cents: number; reason: string; at: string }> = [];
  for (const [rowIndex, row] of purchases.entries()) {
    const hour = new Date(row.at).getHours();
    if (hour >= BILL_ANOMALY.lateNightStartHour && hour < BILL_ANOMALY.lateNightEndHour && row.amountCents >= BILL_ANOMALY.lateNightMinCents) {
      anomalies.push({ merchant: row.merchant, cents: row.amountCents, reason: `凌晨 ${String(hour).padStart(2, "0")} 点交易，超过 ${yuanText(BILL_ANOMALY.lateNightMinCents)} 元`, at: new Date(row.at).toISOString() });
      continue;
    }
    // 基准只算「同类其他交易」：同类只有两笔时，带上自己算中位数就永远判不出异常。
    const others = (peersOf.get(row.category) ?? []).filter((item) => item.index !== rowIndex).map((item) => item.cents);
    if (others.length === 0) continue;
    const median = medianOf(others);
    if (median <= 0) continue;
    const threshold = Math.max(Math.round(median * BILL_ANOMALY.categoryMultiplier), BILL_ANOMALY.minimumCents);
    if (row.amountCents >= threshold) {
      anomalies.push({
        merchant: row.merchant,
        cents: row.amountCents,
        reason: `是该类（${row.category}）其他交易中位数 ${yuanText(median)} 元的 ${(row.amountCents / median).toFixed(1)} 倍`,
        at: new Date(row.at).toISOString(),
      });
    }
  }

  // 全额冲正：原交易的退款金额不小于原交易金额。
  const refundedByOriginal = new Map<string, number>();
  for (const row of refunds) {
    if (typeof row.refundOf !== "string") continue;
    refundedByOriginal.set(row.refundOf, (refundedByOriginal.get(row.refundOf) ?? 0) + row.amountCents);
  }
  const fullyReversed = purchases.filter((row) => (refundedByOriginal.get(row.id) ?? 0) >= row.amountCents).length;

  const subsNet = byCategory.get("订阅代扣")?.cents ?? 0;
  const subsCount = purchases.filter((row) => row.category === "订阅代扣").length;

  const detail = categories.map((item) => `${item.name}(MCC ${item.mcc}) ${yuanText(item.cents)} 元（${item.share}%）`).join("，");
  const reverseText = fullyReversed === 0 ? "" : `其中 ${fullyReversed} 笔已全额冲正。`;
  const anomalyText =
    anomalies.length === 0
      ? "未发现异常交易。"
      : `异常 ${anomalies.length} 笔：${anomalies.map((item) => `${item.merchant} ${yuanText(item.cents)} 元（${item.reason}）`).join("，")}。`;

  return ok(
    "analyze_bills",
    `${label}账单合计 ${yuanText(net)} 元（支出 ${yuanText(gross)} 元，退款冲正 ${yuanText(refunded)} 元），共 ${purchases.length} 笔支出、${refunds.length} 笔退款。` +
      `分类：${detail}。订阅代扣 ${subsCount} 笔净额 ${yuanText(subsNet)} 元。${reverseText}${anomalyText}`,
    {
      period,
      netCents: net,
      grossCents: gross,
      refundedCents: refunded,
      count: purchases.length,
      refundCount: refunds.length,
      categories,
      anomalies,
      subscriptionCents: subsNet,
      fullyReversed,
    },
  );
}

export function transfer(state: BankState, payee: string, amountCents: number): ToolResult {
  if (payee === "") return fail("transfer", "缺少收款人");
  if (amountCents <= 0) return fail("transfer", "金额必须大于零");
  if (amountCents > state.account.available) return fail("transfer", "可用余额不足");
  state.account.balance -= amountCents;
  state.account.available -= amountCents;
  // 只有执行成功才记流水：判定读它算日累计与频次，不能在判定里写。
  state.transferLog.push({ payee, amountCents, at: Date.now() });
  return ok("transfer", `已向 ${payee} 转账 ${yuanText(amountCents)} 元`, { payee, amountCents });
}

/** 订阅清单：列出名称、金额与下次扣费日，并把 7 天内要扣的单独点出来。 */
export function listSubscriptions(state: BankState): ToolResult {
  const now = Date.now();
  const day = 86400000;
  const items = state.subscriptions.map((item) => ({
    name: item.name,
    amountCents: item.amountCents,
    nextChargeAt: item.nextChargeAt,
    autoRenew: item.autoRenew,
    daysUntilCharge: Math.ceil((new Date(item.nextChargeAt).getTime() - now) / day),
  }));
  const total = items.filter((item) => item.autoRenew).reduce((sum, item) => sum + item.amountCents, 0);
  const detail = items.map((item) => `${item.name} ${yuanText(item.amountCents)} 元`).join("、");
  const soon = items.filter((item) => item.autoRenew && item.daysUntilCharge <= 7);
  const soonText =
    soon.length === 0
      ? "7 天内没有待扣项。"
      : `7 天内将扣费 ${soon.length} 项：${soon.map((item) => `${item.name} ${yuanText(item.amountCents)} 元（${item.daysUntilCharge} 天后）`).join("，")}。`;
  return ok("list_subscriptions", `共 ${items.length} 项订阅：${detail}。自动续费合计每月 ${yuanText(total)} 元。${soonText}`, {
    items,
    monthlyTotalCents: total,
    upcomingCents: soon.reduce((sum, item) => sum + item.amountCents, 0),
  });
}

export function cancelSubscription(state: BankState, name: string): ToolResult {
  if (name === "") return fail("cancel_subscription", "缺少订阅名称");
  const index = state.subscriptions.findIndex((item) => item.name === name);
  if (index < 0) return fail("cancel_subscription", `没有这个订阅：${name}`);
  const target = state.subscriptions[index];
  const daysLeft = Math.ceil((new Date(target.nextChargeAt).getTime() - Date.now()) / 86400000);
  state.subscriptions.splice(index, 1);
  const timing = daysLeft >= 0 ? `原定 ${target.nextChargeAt.slice(0, 10)} 扣费（还有 ${daysLeft} 天），本期不会再扣。` : "上一期已结束，后续不再扣费。";
  return ok("cancel_subscription", `已取消订阅 ${name}（每月 ${yuanText(target.amountCents)} 元）。${timing}`, {
    name,
    amountCents: target.amountCents,
    daysUntilCharge: daysLeft,
  });
}

export function lockCard(state: BankState, cardId: string): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("lock_card", `卡片不存在：${cardId}`);
  card.status = card.status === "active" ? "locked" : "active";
  return ok("lock_card", `${card.label} 已${card.status === "locked" ? "锁定" : "解锁"}`, { cardId, status: card.status });
}

export function redeemWealth(state: BankState, amountCents: number): ToolResult {
  const total = state.holdings.reduce((sum, item) => sum + item.amountCents, 0);
  if (total === 0) return fail("wealth_redeem", "当前没有持仓");
  const amount = Math.min(amountCents <= 0 ? total : amountCents, total);
  state.holdings[0].amountCents -= amount;
  state.holdings = state.holdings.filter((item) => item.amountCents > 0);
  state.account.balance += amount;
  state.account.available += amount;
  return ok("wealth_redeem", `已赎回 ${yuanText(amount)} 元，资金回到活期`, { amountCents: amount });
}

/** 卡片挂失：不可撤销，属于必须拦红后走柜面的操作。 */
export function reportLoss(state: BankState, cardId: string): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("report_loss", `卡片不存在：${cardId}`);
  if (card.status === "lost") return fail("report_loss", `${card.label} 已经挂失`);
  card.status = "lost";
  return ok("report_loss", `${card.label} 已挂失，需换卡后才能使用`, { cardId, status: "lost" });
}

/** 生日资金预锁：锁定可用额度，不动总余额，可撤销。 */
export function lockBirthdayFunds(state: BankState, amountCents: number): ToolResult {
  if (amountCents <= 0) return fail("birthday_lock", "锁定金额必须大于零");
  if (amountCents > state.account.available) return fail("birthday_lock", "可用余额不足");
  const lockUntil = new Date(Date.now() + 14 * 86400000).toISOString();
  state.account.available -= amountCents;
  state.lockedFunds.unshift({
    id: `lf-${String(state.lockedFunds.length + 1).padStart(3, "0")}`,
    purpose: "生日礼遇",
    amountCents,
    lockUntil,
    status: "locked",
  });
  return ok("birthday_lock", `已锁定 ${yuanText(amountCents)} 元用于生日礼遇，锁定至 ${lockUntil.slice(0, 10)}，到期前两天下单鲜花与蛋糕`, {
    amountCents,
    lockUntil,
    availableCents: state.account.available,
  });
}

/** 理财货架：按客户风险等级标注哪几款能申购，数字全部来自本地目录，不依赖外部服务在线。 */
export function listWealthProducts(state: BankState): ToolResult {
  const level = state.customer.riskLevel;
  const items = state.wealthProducts.map((item) => ({
    ...item,
    riskLabel: RISK_LABEL[item.riskLevel] ?? `风险 ${item.riskLevel}`,
    annualRateText: `${(item.annualRate * 100).toFixed(1)}%`,
    suitable: item.riskLevel <= level,
  }));
  const detail = items
    .map(
      (item) =>
        `${item.name}（${item.riskLabel}，年化 ${item.annualRateText}，起购 ${yuanText(item.minAmountCents)} 元${item.suitable ? "" : "，超出你的承受等级"}）`,
    )
    .join("；");
  const suitableCount = items.filter((item) => item.suitable).length;
  return ok(
    "wealth_products",
    `你的风险承受等级是 ${level}（${RISK_LABEL[level] ?? "未评级"}），下面 ${items.length} 款里 ${suitableCount} 款可申购：${detail}。`,
    { count: items.length, suitableCount, items, customerRiskLevel: level },
  );
}

/** 申购执行：起购金额与适当性由判定层先拦，这里只负责扣钱与记账。 */
export function buyWealth(state: BankState, productId: string, amountCents: number): ToolResult {
  const product =
    state.wealthProducts.find((item) => item.id === productId) ?? state.wealthProducts.find((item) => item.name === productId);
  if (product === undefined) return fail("wealth_buy", `没有这个产品：${productId}`);
  if (amountCents <= 0) return fail("wealth_buy", "申购金额必须大于零");
  if (amountCents < product.minAmountCents) return fail("wealth_buy", `${product.name} 起购 ${yuanText(product.minAmountCents)} 元`);
  if (amountCents > state.account.available) return fail("wealth_buy", "可用余额不足");
  const feeCents = Math.round(amountCents * product.feeRate);
  state.account.balance -= amountCents + feeCents;
  state.account.available -= amountCents + feeCents;
  state.holdings.unshift({ id: `h-${String(state.holdings.length + 10).padStart(3, "0")}`, productId: product.id, amountCents });
  return ok(
    "wealth_buy",
    `已申购 ${product.name} ${yuanText(amountCents)} 元，年化 ${(product.annualRate * 100).toFixed(1)}%，申购费 ${yuanText(feeCents)} 元`,
    { productId: product.id, amountCents, feeCents },
  );
}

/** 预约转账登记：只写预约表，不动余额。到期需用户再次确认才真正转账。 */
export function scheduleTransfer(state: BankState, payee: string, amountCents: number, dueOffsetDays: number): ToolResult {
  if (payee === "") return fail("schedule_transfer", "缺少收款人");
  if (amountCents <= 0) return fail("schedule_transfer", "金额必须大于零");
  const dueAt = new Date(Date.now() + Math.max(1, dueOffsetDays) * 86400000).toISOString();
  state.scheduledTransfers.push({
    id: `sf-${String(state.scheduledTransfers.length + 1).padStart(3, "0")}`,
    payee,
    amountCents,
    dueAt,
    status: "scheduled",
  });
  return ok(
    "schedule_transfer",
    `已登记预约转账：${dueAt.slice(0, 10)} 向 ${payee} 转 ${yuanText(amountCents)} 元。到期不会自动扣款，会在你确认后才执行`,
    { payee, amountCents, dueAt },
  );
}

/** 预约清单：到期日与状态。 */
export function listScheduled(state: BankState): ToolResult {
  const items = state.scheduledTransfers.filter((item) => item.status === "scheduled");
  if (items.length === 0) return ok("list_scheduled", "没有待执行的预约转账", { count: 0, items: [] });
  const detail = items
    .map((item) => `${item.dueAt.slice(0, 10)} 向 ${item.payee} 转 ${yuanText(item.amountCents)} 元`)
    .join("；");
  return ok("list_scheduled", `待执行的预约转账 ${items.length} 笔：${detail}`, { count: items.length, items });
}

/** 办卡申请：只登记申请，制卡与寄送在线下完成。 */
export function applyCard(state: BankState): ToolResult {
  const id = `card-${String(state.cards.length + 1).padStart(3, "0")}`;
  state.cards.push({ id, label: `新卡 ${id.slice(-4)}（待审核）`, status: "pending", limitCents: 500000 });
  return ok("apply_card", `已提交办卡申请，编号 ${id}，预计 3 个工作日内审核，结果送到预留手机号`, { cardId: id, status: "pending" });
}

/** 工具分派：只执行，不判定。 */
export function executeTool(tool: string, slots: Record<string, unknown>, state: BankState): ToolResult {
  const amount = typeof slots.amountCents === "number" ? slots.amountCents : 0;
  const text = (name: string): string => (typeof slots[name] === "string" ? (slots[name] as string) : "");
  switch (tool) {
    case "query_balance":
      return queryBalance(state);
    case "analyze_bills":
      return analyzeBills(state, typeof slots.period === "string" ? (slots.period as BillPeriod) : "this-month");
    case "transfer":
      return transfer(state, text("payee"), amount);
    case "list_subscriptions":
      return listSubscriptions(state);
    case "cancel_subscription":
      return cancelSubscription(state, text("subscriptionName"));
    case "lock_card":
      return lockCard(state, text("cardId") === "" ? "card-002" : text("cardId"));
    case "report_loss":
      return reportLoss(state, text("cardId") === "" ? "card-002" : text("cardId"));
    case "wealth_redeem":
      return redeemWealth(state, amount);
    case "wealth_products":
      return listWealthProducts(state);
    case "wealth_buy":
      return buyWealth(state, text("productId"), amount);
    case "schedule_transfer":
      return scheduleTransfer(state, text("payee"), amount, typeof slots.dueOffsetDays === "number" ? (slots.dueOffsetDays as number) : 1);
    case "list_scheduled":
      return listScheduled(state);
    case "apply_card":
      return applyCard(state);
    case "adjust_limit":
      return fail("adjust_limit", "额度调整需柜面办理，线上不执行");
    case "freeze_account":
      return fail("freeze_account", "账户冻结需柜面办理，线上不执行");
    case "birthday_lock":
      return lockBirthdayFunds(state, amount === 0 ? 100000 : amount);
    default:
      return fail(tool, `工具不在白名单：${tool}`);
  }
}
