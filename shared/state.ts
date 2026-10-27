/** 领域状态与工具执行：金额一律整数分。 */

export interface Account {
  holder: string;
  balance: number;
  available: number;
}

export interface Card {
  id: string;
  label: string;
  status: "active" | "locked" | "lost";
  limitCents: number;
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

/** 账单流水：只读数据，账单分析按时间窗口聚合。 */
export interface BillRecord {
  id: string;
  at: number;
  merchant: string;
  category: string;
  amountCents: number;
  channel: string;
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
}

/** 账单样本：按当前时间回推生成，保证「本月/上月/近三月」三个口径都有数据。 */
function seedBills(now: number): BillRecord[] {
  const day = 86400000;
  const rows: Array<[number, string, string, number, string]> = [
    [0, "云幕视频会员", "订阅代扣", 2500, "代扣"],
    [1, "楼下面馆", "餐饮", 3800, "扫码"],
    [2, "极光数码", "数码", 688000, "线上"],
    [3, "地铁出行", "交通", 1200, "扫码"],
    [5, "云端音乐", "订阅代扣", 1500, "代扣"],
    [7, "生鲜超市", "购物", 21600, "刷卡"],
    [9, "水电燃气", "生活缴费", 32600, "代扣"],
    [12, "咖啡店", "餐饮", 3200, "扫码"],
    [18, "云笔记专业版", "订阅代扣", 3000, "代扣"],
    [31, "家用电器", "数码", 268000, "线上"],
    [34, "健身房", "生活缴费", 19900, "刷卡"],
    [38, "餐厅聚餐", "餐饮", 26800, "刷卡"],
    [45, "云盘 2T", "订阅代扣", 1200, "代扣"],
    [52, "网购服饰", "购物", 45600, "线上"],
    [70, "旅游机票", "交通", 128000, "线上"],
  ];
  return rows.map(([ago, merchant, category, amountCents, channel], index) => ({
    id: `bill-${String(index + 1).padStart(3, "0")}`,
    at: now - ago * day,
    merchant,
    category,
    amountCents,
    channel,
  }));
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
export type BillPeriod = "this-month" | "last-month" | "3-months";

const PERIOD_LABEL: Record<BillPeriod, string> = {
  "this-month": "本月",
  "last-month": "上月",
  "3-months": "近三个月",
};

/** 半开区间 [from, to)。 */
function periodRange(period: BillPeriod, now: number): { from: number; to: number } {
  const today = new Date(now);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  if (period === "this-month") return { from: monthStart, to: now + 1 };
  if (period === "last-month") {
    return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime(), to: monthStart };
  }
  return { from: new Date(today.getFullYear(), today.getMonth() - 2, 1).getTime(), to: now + 1 };
}

/** 账单分析：按时间窗口聚合分类占比，标出异常笔与订阅代扣，数字全部来自账单流水。 */
export function analyzeBills(state: BankState, period: BillPeriod = "this-month"): ToolResult {
  const now = Date.now();
  const { from, to } = periodRange(period, now);
  const rows = state.bills.filter((bill) => bill.at >= from && bill.at < to);
  const label = PERIOD_LABEL[period];
  if (rows.length === 0) {
    return ok("analyze_bills", `${label}没有账单记录`, { period, totalCents: 0, count: 0, categories: [] });
  }

  const total = rows.reduce((sum, bill) => sum + bill.amountCents, 0);
  const byCategory = new Map<string, number>();
  for (const bill of rows) byCategory.set(bill.category, (byCategory.get(bill.category) ?? 0) + bill.amountCents);
  const categories = [...byCategory.entries()]
    .map(([name, cents]) => ({ name, cents, share: Math.round((cents / total) * 100) }))
    .sort((a, b) => b.cents - a.cents);

  // 异常口径写死两条：单笔 3000 元以上，或凌晨 0 到 6 点之间 1000 元以上。
  const anomalies = rows
    .filter((bill) => bill.amountCents >= 300000 || (new Date(bill.at).getHours() < 6 && bill.amountCents >= 100000))
    .map((bill) => ({
      merchant: bill.merchant,
      cents: bill.amountCents,
      reason: bill.amountCents >= 300000 ? "单笔大额" : "凌晨交易",
      at: new Date(bill.at).toISOString(),
    }));

  const subs = rows.filter((bill) => bill.category === "订阅代扣");
  const subsTotal = subs.reduce((sum, bill) => sum + bill.amountCents, 0);

  const detail = categories.map((item) => `${item.name} ${yuanText(item.cents)} 元（${item.share}%）`).join("，");
  const anomalyText =
    anomalies.length === 0
      ? "未发现异常交易。"
      : `异常 ${anomalies.length} 笔：${anomalies.map((item) => `${item.merchant} ${yuanText(item.cents)} 元（${item.reason}）`).join("，")}。`;

  return ok(
    "analyze_bills",
    `${label}账单合计 ${yuanText(total)} 元，共 ${rows.length} 笔。分类：${detail}。订阅代扣 ${subs.length} 笔合计 ${yuanText(subsTotal)} 元。${anomalyText}`,
    { period, totalCents: total, count: rows.length, categories, anomalies, subscriptionCents: subsTotal },
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
