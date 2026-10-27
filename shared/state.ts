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

export interface BankState {
  account: Account;
  cards: Card[];
  subscriptions: Subscription[];
  holdings: Holding[];
  lockedFunds: LockedFund[];
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

/** 账单分析：用固定分类聚合，不依赖外部数据。 */
export function analyzeBills(state: BankState): ToolResult {
  const categories = [
    { name: "数码", cents: 740700 },
    { name: "购物", cents: 67200 },
    { name: "生活缴费", cents: 65600 },
    { name: "餐饮", cents: 43300 },
  ];
  const total = categories.reduce((sum, item) => sum + item.cents, 0);
  const detail = categories
    .map((item) => `${item.name} ${yuanText(item.cents)} 元（${Math.round((item.cents / total) * 100)}%）`)
    .join("，");
  return ok("analyze_bills", `本期账单合计 ${yuanText(total)} 元。分类占比：${detail}。异常：极光数码 6880 元，凌晨 2 点发生大额交易`, {
    totalCents: total,
    categories,
    anomalies: [{ merchant: "极光数码", cents: 688000, reason: "凌晨大额交易" }],
    subscriptions: state.subscriptions.length,
  });
}

export function transfer(state: BankState, payee: string, amountCents: number): ToolResult {
  if (payee === "") return fail("transfer", "缺少收款人");
  if (amountCents <= 0) return fail("transfer", "金额必须大于零");
  if (amountCents > state.account.available) return fail("transfer", "可用余额不足");
  state.account.balance -= amountCents;
  state.account.available -= amountCents;
  return ok("transfer", `已向 ${payee} 转账 ${yuanText(amountCents)} 元`, { payee, amountCents });
}

/** 订阅清单：只读，列出名称、金额与下次扣费日。 */
export function listSubscriptions(state: BankState): ToolResult {
  const items = state.subscriptions.map((item) => ({
    name: item.name,
    amountCents: item.amountCents,
    nextChargeAt: item.nextChargeAt,
    autoRenew: item.autoRenew,
  }));
  const total = items.filter((item) => item.autoRenew).reduce((sum, item) => sum + item.amountCents, 0);
  const detail = items.map((item) => `${item.name} ${yuanText(item.amountCents)} 元`).join("、");
  return ok("list_subscriptions", `共 ${items.length} 项订阅：${detail}。自动续费合计每月 ${yuanText(total)} 元`, {
    items,
    monthlyTotalCents: total,
  });
}

export function cancelSubscription(state: BankState, name: string): ToolResult {
  if (name === "") return fail("cancel_subscription", "缺少订阅名称");
  const index = state.subscriptions.findIndex((item) => item.name === name);
  if (index < 0) return fail("cancel_subscription", `没有这个订阅：${name}`);
  state.subscriptions.splice(index, 1);
  return ok("cancel_subscription", `已取消订阅 ${name}，后续不再扣费`, { name });
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
      return analyzeBills(state);
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
    case "birthday_lock":
      return lockBirthdayFunds(state, amount === 0 ? 100000 : amount);
    default:
      return fail(tool, `工具不在白名单：${tool}`);
  }
}
