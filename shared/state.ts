/** 领域状态与工具执行：金额一律整数分。 */

import { BILL_ANOMALY, classifyMerchant } from "./bills.ts";
import { installmentQuote } from "./finance.ts";
import { AML_WINDOW_DAYS, collectEvidence } from "./aml.ts";

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

/**
 * AA 收款单：我先垫付了一笔，其余人各还我一份。
 *
 * 两个金额口径必须分清楚，否则对不上账：
 * - `perPersonCents` 是「除我以外」每个人还多少，金额取整；除不尽的零头由发起人（我）承担；
 * - `collectCents` 是我实际要收回的合计，等于 perPersonCents ×（headcount − 1），
 *   而 `myShareCents` = 总额 − collectCents。三者相加恒等于总额，这是硬约束。
 */
export interface Collection {
  id: string;
  title: string;
  /** 我先垫付的总额，整数分。 */
  totalCents: number;
  /** 参与人数，含我。 */
  headcount: number;
  /** 除我之外每人应付，金额整齐（零头由我承担）。 */
  perPersonCents: number;
  /** 我实际承担。 */
  myShareCents: number;
  /** 需要收回的合计。 */
  collectCents: number;
  /** 需要付款给我的其他人。 */
  payers: string[];
  createdAt: number;
  status: "collecting" | "cancelled";
}

/**
 * 生日礼遇订单：先锁资金，到生日前 leadDays 天才由调度器真正下单。
 * 「登记」与「下单」是两件事 —— 登记不改余额，下单才扣款，这样中途取消不会有退款流程。
 */
export interface BirthdayGift {
  id: string;
  /** 生日，MM-DD。 */
  birthday: string;
  /** 提前几天下单。 */
  leadDays: number;
  /** 计划下单时刻（生日当天 09:00 往前推 leadDays 天）。 */
  orderAt: number;
  /** 预算上限，不得超过已预锁额度。 */
  budgetCents: number;
  items: Array<{ name: string; amountCents: number }>;
  totalCents: number;
  status: "scheduled" | "ordered" | "cancelled";
  /** 关联的预锁资金；没有它就不许下单。 */
  lockId?: string;
  orderedAt?: number;
  /** 取消或跳过的原因，如实写给人看。 */
  note?: string;
}

export interface Subscription {
  id: string;
  name: string;
  amountCents: number;
  nextChargeAt: string;
  autoRenew: boolean;
}

/**
 * 一笔持仓。
 *
 * 本金与收益分开记：`amountCents` 永远只是本金，收益单独累计。混在一起记的后果是
 * 赎回时算不清「退的是本金还是收益」，也说不清持仓成本 —— 成本一旦被收益污染，
 * 再谈收益率就没有基准了。
 *
 * 收益用「毫分」（0.001 分）累计而不是直接存分：按日计提时一笔 1200 元的货币基金
 * 一天只赚 0.06 分，若每天都四舍五入到分，零头天天被抹掉，持有一年就是系统性少算。
 * 毫分只影响中间记账，对外展示与结算一律向下取整到分。
 */
export interface Holding {
  id: string;
  productId: string;
  /** 本金（分）。 */
  amountCents: number;
  /** 买入时间（毫秒），计息起算点。 */
  boughtAt: number;
  /** 已落账收益，单位毫分（1 分 = 1000 毫分）。 */
  accruedMilliCents: number;
  /** 上次结息时间。与当前时间的差决定这次还能计提多少。 */
  lastAccruedAt: number;
}

/** 一天毫秒数。计息口径按自然日折算，不足一天按比例。 */
const DAY_MS = 86400000;
/** 年化折算基准天数。零售理财报价的通行惯例是 365 天，不用 360。 */
export const DAYS_PER_YEAR = 365;

/**
 * 一段持有期内的应计收益，单位毫分。
 *
 * 纯函数：只依赖入参，不读时钟、不读状态。所以「同样的本金、同样的区间」算出来必然
 * 同一个数，收益是可复算的事实，而不是一个随实现漂移的观测量。
 */
export function accruedMilli(principalCents: number, annualRate: number, fromMs: number, toMs: number): number {
  if (principalCents <= 0 || annualRate <= 0 || toMs <= fromMs) return 0;
  const days = (toMs - fromMs) / DAY_MS;
  return Math.round((principalCents * 1000 * annualRate * days) / DAYS_PER_YEAR);
}

/** 持仓的对外读数：本金、已计收益、市值。只读，不写状态。 */
export interface HoldingValue {
  id: string;
  productId: string;
  productName: string;
  annualRate: number;
  principalCents: number;
  /** 已落账 + 应计未落账，向下取整到分。 */
  interestCents: number;
  marketValueCents: number;
  heldDays: number;
}

/**
 * 算所有持仓的市值。
 *
 * 含「应计未落账」那一段 —— 结息是记账动作，不该影响用户看到的钱。所以查询能看见
 * 收益，但状态里 `accruedMilliCents` 不会被这次查询改动；查询不改账，这是只读的底线。
 */
export function holdingValues(state: BankState, now = Date.now()): HoldingValue[] {
  return state.holdings.map((holding) => {
    const product = state.wealthProducts.find((item) => item.id === holding.productId);
    const rate = product?.annualRate ?? 0;
    const milli = holding.accruedMilliCents + accruedMilli(holding.amountCents, rate, holding.lastAccruedAt, now);
    const interestCents = Math.floor(milli / 1000);
    return {
      id: holding.id,
      productId: holding.productId,
      productName: product?.name ?? holding.productId,
      annualRate: rate,
      principalCents: holding.amountCents,
      interestCents,
      marketValueCents: holding.amountCents + interestCents,
      heldDays: Math.max(0, Math.floor((now - holding.boughtAt) / DAY_MS)),
    };
  });
}

/**
 * 把应计收益落账：把「从上次结息到现在」这段算进 `accruedMilliCents`，并推进时间点。
 *
 * 只在执行体里调（申购、赎回），不在判定与查询里调 —— 判定必须只读，否则同一句话
 * 判两次、账变两次。返回落账后的收益合计（毫分），供调用方对账。
 */
export function settleHoldings(state: BankState, now: number): number {
  let totalMilli = 0;
  for (const holding of state.holdings) {
    const product = state.wealthProducts.find((item) => item.id === holding.productId);
    const rate = product?.annualRate ?? 0;
    holding.accruedMilliCents += accruedMilli(holding.amountCents, rate, holding.lastAccruedAt, now);
    holding.lastAccruedAt = now;
    totalMilli += holding.accruedMilliCents;
  }
  return totalMilli;
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
  /** 爱人生日，MM-DD。用户没说日期时用它，不靠猜。 */
  spouseBirthday: string;
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
  collections: Collection[];
  birthdayGifts: BirthdayGift[];
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
    // 两笔持仓分别买了 30 天、45 天，买入时间作为计息起点。给具体日期而不是「现在」，
    // 是为了让收益一开始就是可观测的 —— 否则要等到第 2 天才看得出这套账在动。
    holdings: [
      { id: "h-001", productId: "p-002", amountCents: 500000, boughtAt: now - 30 * day, accruedMilliCents: 0, lastAccruedAt: now - 30 * day },
      { id: "h-002", productId: "p-001", amountCents: 120000, boughtAt: now - 45 * day, accruedMilliCents: 0, lastAccruedAt: now - 45 * day },
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
    customer: { riskLevel: 2, assessedAt: new Date(now - 30 * day).toISOString(), spouseBirthday: "11-15" },
    scheduledTransfers: [],
    collections: [],
    birthdayGifts: [],
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
  const values = holdingValues(state);
  const principalCents = values.reduce((sum, item) => sum + item.principalCents, 0);
  const interestCents = values.reduce((sum, item) => sum + item.interestCents, 0);
  const marketCents = principalCents + interestCents;
  // 活期与理财分开报，再给一个合计：这三者是不同的钱，混成一句「你有多少」最难审计。
  const holdingsText =
    marketCents === 0
      ? ""
      : `，理财持仓 ${yuanText(marketCents)} 元（本金 ${yuanText(principalCents)} 元，已计收益 ${yuanText(interestCents)} 元）`;
  return ok(
    "query_balance",
    `可用余额 ${yuanText(state.account.available)} 元，总余额 ${yuanText(state.account.balance)} 元${holdingsText}`,
    {
      availableCents: state.account.available,
      balanceCents: state.account.balance,
      holdingPrincipalCents: principalCents,
      holdingInterestCents: interestCents,
      holdingMarketCents: marketCents,
      // 净资产 = 活期 + 理财市值。预锁的钱本来就在 balance 里（只占可用额度），不能重复加。
      netWorthCents: state.account.balance + marketCents,
      holdings: values,
    },
  );
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

export function redeemWealth(state: BankState, amountCents: number, now = Date.now()): ToolResult {
  const total = state.holdings.reduce((sum, item) => sum + item.amountCents, 0);
  if (total === 0) return fail("wealth_redeem", "当前没有持仓");
  // 先结息，再动本金：赎回那一刻的账必须已经算到当前，否则用户拿到的钱会停留在
  // 上一次结息时点，中间那几天白放 —— 而且这个差错不会有人报错，只会被慢慢发现。
  settleHoldings(state, now);
  const amount = Math.min(amountCents <= 0 ? total : amountCents, total);
  // 逐笔扣到够为止。原来只扣 holdings[0]：持仓 5000 + 1200、全额赎回 6200 时，
  // 第一笔被扣成 -1200 后整条删掉，第二笔 1200 还留着，现金却进账 6200 ——
  // 净资产凭空多出 1200。钱不能只从一笔里出，除非那一笔真的够。
  let left = amount;
  let interestCents = 0;
  /** 不足 1 分的舍入残值（毫分）。不假装它不存在，单独记出来，对账才有得对。 */
  let roundingMilliCents = 0;
  const kept: Holding[] = [];
  for (const holding of state.holdings) {
    if (left <= 0 || holding.amountCents <= 0) {
      kept.push(holding);
      continue;
    }
    const take = Math.min(holding.amountCents, left);
    // 收益按本金比例结清：take 恰好等于本金时比例就是 1，整笔赎回不需要靠四舍五入碰巧相等。
    const releasedCents = Math.floor(Math.round((holding.accruedMilliCents * take) / holding.amountCents) / 1000);
    holding.accruedMilliCents -= releasedCents * 1000;
    holding.amountCents -= take;
    left -= take;
    interestCents += releasedCents;
    if (holding.amountCents > 0) {
      kept.push(holding);
    } else {
      // 整笔退出：剩下的零头不足 1 分，付不出去，也不能扔得无声无息 —— 记进舍入残值。
      roundingMilliCents += holding.accruedMilliCents;
      holding.accruedMilliCents = 0;
    }
  }
  state.holdings = kept;
  const creditedCents = amount + interestCents;
  state.account.balance += creditedCents;
  state.account.available += creditedCents;
  const message =
    interestCents > 0
      ? `已赎回 ${yuanText(amount)} 元，结息 ${yuanText(interestCents)} 元，共 ${yuanText(creditedCents)} 元回到活期`
      : `已赎回 ${yuanText(amount)} 元，资金回到活期`;
  return ok("wealth_redeem", message, { amountCents: amount, interestCents, creditedCents, roundingMilliCents });
}

/** 卡片挂失：不可撤销，属于必须拦红后走柜面的操作。 */
export function reportLoss(state: BankState, cardId: string): ToolResult {
  const card = state.cards.find((item) => item.id === cardId);
  if (card === undefined) return fail("report_loss", `卡片不存在：${cardId}`);
  if (card.status === "lost") return fail("report_loss", `${card.label} 已经挂失`);
  card.status = "lost";
  return ok("report_loss", `${card.label} 已挂失，需换卡后才能使用`, { cardId, status: "lost" });
}

/**
 * 生日资金预锁：锁定可用额度，不动总余额，可撤销。
 * 锁定期必须覆盖到生日当天 —— 原来写死 14 天，生日若在 20 天后就出现
 * 「锁到 11-10、11-13 才下单」这种自相矛盾的回执，所以改成按生日推算。
 */
export function lockBirthdayFunds(state: BankState, amountCents: number, birthday = ""): ToolResult {
  if (amountCents <= 0) return fail("birthday_lock", "锁定金额必须大于零");
  if (amountCents > state.account.available) return fail("birthday_lock", "可用余额不足");
  const now = Date.now();
  const birthdayAt = birthday === "" ? null : nextBirthdayAt(birthday, now);
  const lockUntil = new Date(birthdayAt ?? now + 14 * 86400000).toISOString();
  state.account.available -= amountCents;
  state.lockedFunds.unshift({
    id: `lf-${String(state.lockedFunds.length + 1).padStart(3, "0")}`,
    purpose: "生日礼遇",
    amountCents,
    lockUntil,
    status: "locked",
  });
  const untilText = lockUntil.slice(0, 10);
  const tail = birthdayAt === null ? `${BIRTHDAY_LEAD_DAYS} 天前` : `提前 ${BIRTHDAY_LEAD_DAYS} 天`;
  return ok("birthday_lock", `已锁定 ${yuanText(amountCents)} 元用于生日礼遇，锁定至 ${untilText}，${tail}下单鲜花与蛋糕`, {
    amountCents,
    lockUntil,
    birthday: birthday === "" ? null : birthday,
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
  // 货架后面接一句「你现在持有什么、赚了多少」。理财页只列可买的产品、不报已有持仓，
  // 等于把用户最想看的那个数字藏起来了 —— 问「我的理财收益怎么样」也只会得到一串产品名。
  const values = holdingValues(state);
  const holdingText =
    values.length === 0
      ? "你当前没有理财持仓。"
      : `你当前持有：${values
          .map(
            (item) =>
              `${item.productName} 本金 ${yuanText(item.principalCents)} 元，已计收益 ${yuanText(item.interestCents)} 元（持有 ${item.heldDays} 天）`,
          )
          .join("；")}。`;
  return ok(
    "wealth_products",
    `你的风险承受等级是 ${level}（${RISK_LABEL[level] ?? "未评级"}），下面 ${items.length} 款里 ${suitableCount} 款可申购：${detail}。${holdingText}`,
    { count: items.length, suitableCount, items, customerRiskLevel: level, holdings: values },
  );
}

/** 申购执行：起购金额与适当性由判定层先拦，这里只负责扣钱与记账。 */
export function buyWealth(state: BankState, productId: string, amountCents: number, now = Date.now()): ToolResult {
  const product =
    state.wealthProducts.find((item) => item.id === productId) ?? state.wealthProducts.find((item) => item.name === productId);
  if (product === undefined) return fail("wealth_buy", `没有这个产品：${productId}`);
  if (amountCents <= 0) return fail("wealth_buy", "申购金额必须大于零");
  if (amountCents < product.minAmountCents) return fail("wealth_buy", `${product.name} 起购 ${yuanText(product.minAmountCents)} 元`);
  if (amountCents > state.account.available) return fail("wealth_buy", "可用余额不足");
  // 这里刻意不结息：申购不动老持仓的本金，没有必要打断它们的计息区间。
  // 每多一次不必要的 settle，撤单要回滚的字段就多一处 —— 回滚面越小越可靠。
  const feeCents = Math.round(amountCents * product.feeRate);
  state.account.balance -= amountCents + feeCents;
  state.account.available -= amountCents + feeCents;
  state.holdings.unshift({
    id: `h-${String(state.holdings.length + 10).padStart(3, "0")}`,
    productId: product.id,
    amountCents,
    boughtAt: now,
    accruedMilliCents: 0,
    lastAccruedAt: now,
  });
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

/**
 * AA 分摊：把总额按人头拆成整数分，除不尽的零头**由发起人承担**。
 *
 * 为什么不用「前几个人各多 1 分」那种摊法：那样每个人金额都不一样，
 * 跟朋友报数时说不清「你为什么比我多一分」。统一口径 —— 别人拿整齐的数，
 * 零头我担 —— 一句「零头我出」就解释完了，而且合计恒等于总额，一分不差。
 */
export function splitShares(totalCents: number, headcount: number): { perPersonCents: number; myShareCents: number; collectCents: number } | null {
  if (!Number.isInteger(totalCents) || totalCents <= 0) return null;
  if (!Number.isInteger(headcount) || headcount < 2) return null;
  const perPersonCents = Math.floor(totalCents / headcount);
  if (perPersonCents <= 0) return null;
  const collectCents = perPersonCents * (headcount - 1);
  return { perPersonCents, myShareCents: totalCents - collectCents, collectCents };
}

/** AA 收款：只生成收款单，不扣任何人钱 —— 真正的资金流在别人付款时才发生。 */
export function splitCollect(
  state: BankState,
  options: { totalCents: number; headcount: number; title: string; payers: string[] },
): ToolResult {
  const { totalCents, headcount } = options;
  if (!Number.isInteger(totalCents) || totalCents <= 0) return fail("split_collect", "AA 收款总额必须是大于零的整数分");
  if (!Number.isInteger(headcount) || headcount < 2) return fail("split_collect", `AA 收款至少 2 人参与，当前是 ${headcount} 人`);
  const shares = splitShares(totalCents, headcount);
  if (shares === null) return fail("split_collect", `${yuanText(totalCents)} 元摊给 ${headcount} 人，每人不足 1 分，无法拆分`);
  const payers = options.payers.slice(0, headcount - 1);
  // 名单不足 headcount-1 个时补占位，不擅自替用户编人名。
  // 占位从「同行人1」开始编号，不用全局序号 —— 「同行人3」会让人误以为真有第三个人被点名。
  let placeholder = 0;
  while (payers.length < headcount - 1) {
    placeholder += 1;
    payers.push(`同行人${placeholder}`);
  }
  const title = options.title === "" ? "聚餐" : options.title;
  const record: Collection = {
    id: `col-${String(state.collections.length + 1).padStart(3, "0")}`,
    title,
    totalCents,
    headcount,
    perPersonCents: shares.perPersonCents,
    myShareCents: shares.myShareCents,
    collectCents: shares.collectCents,
    payers,
    createdAt: Date.now(),
    status: "collecting",
  };
  state.collections.unshift(record);
  const remainText =
    shares.myShareCents === shares.perPersonCents
      ? "没有零头"
      : `除不尽的 ${yuanText(shares.myShareCents - shares.perPersonCents)} 元零头由你承担`;
  return ok(
    "split_collect",
    `已按 ${headcount} 人拆分${title} ${yuanText(totalCents)} 元：${payers.join("、")} 各付 ${yuanText(shares.perPersonCents)} 元，` +
      `共收回 ${yuanText(shares.collectCents)} 元，你承担 ${yuanText(shares.myShareCents)} 元（${remainText}）`,
    {
      collectionId: record.id,
      totalCents,
      headcount,
      perPersonCents: shares.perPersonCents,
      myShareCents: shares.myShareCents,
      collectCents: shares.collectCents,
      payers,
    },
  );
}

/** 生日礼遇的固定选品：价格写死，不依赖外部商城在线，判定与对账都能复算。 */
export const BIRTHDAY_GIFT_ITEMS: Array<{ name: string; amountCents: number }> = [
  { name: "鲜花（11 枝玫瑰）", amountCents: 19900 },
  { name: "生日蛋糕（6 寸）", amountCents: 25900 },
];

/** 生日礼遇的默认提前量：生日前 2 天下单。 */
export const BIRTHDAY_LEAD_DAYS = 2;

/** 把 MM-DD 换算成「下一次生日」的时间戳，统一取当天 09:00 作为下单时点。 */
export function nextBirthdayAt(monthDay: string, now: number): number | null {
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (match === null) return null;
  const month = Number(match[1]);
  const date = Number(match[2]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const year = new Date(now).getFullYear();
  const build = (y: number): number => new Date(y, month - 1, date, 9, 0, 0, 0).getTime();
  const thisYear = build(year);
  return thisYear > now ? thisYear : build(year + 1);
}

/**
 * 生日下单登记：只登记，不动钱。
 * 下单资格来自预锁资金 —— 没有锁定额度就不许下单，避免「先买了再说」。
 */
export function createBirthdayGift(
  state: BankState,
  options: { birthday: string; budgetCents: number; now: number },
): ToolResult {
  const birthdayAt = nextBirthdayAt(options.birthday, options.now);
  if (birthdayAt === null) return fail("birthday_order", `生日日期「${options.birthday}」无法识别，需要 MM-DD 格式`);
  const totalCents = BIRTHDAY_GIFT_ITEMS.reduce((sum, item) => sum + item.amountCents, 0);
  const budgetCents = options.budgetCents > 0 ? options.budgetCents : totalCents;
  if (budgetCents < totalCents) {
    return fail("birthday_order", `预算 ${yuanText(budgetCents)} 元不够，鲜花与蛋糕合计 ${yuanText(totalCents)} 元`);
  }
  const lock = state.lockedFunds.find((item) => item.status === "locked" && item.purpose.includes("生日"));
  if (lock === undefined) return fail("birthday_order", "没有可用的生日预锁额度，需要先锁定资金再登记下单");
  if (budgetCents > lock.amountCents) {
    return fail("birthday_order", `预算 ${yuanText(budgetCents)} 元超过已预锁的 ${yuanText(lock.amountCents)} 元，请先补充锁定额度`);
  }
  // 不足提前量就立刻排期（orderAt 不早于现在），由调度器在下一个 tick 执行。
  const planned = birthdayAt - BIRTHDAY_LEAD_DAYS * 86400000;
  const orderAt = Math.max(planned, options.now);
  const gift: BirthdayGift = {
    id: `gift-${String(state.birthdayGifts.length + 1).padStart(3, "0")}`,
    birthday: options.birthday,
    leadDays: BIRTHDAY_LEAD_DAYS,
    orderAt,
    budgetCents,
    items: BIRTHDAY_GIFT_ITEMS.map((item) => ({ ...item })),
    totalCents,
    status: "scheduled",
    lockId: lock.id,
  };
  state.birthdayGifts.unshift(gift);
  const orderText = new Date(orderAt).toISOString().slice(0, 10);
  const rush = planned <= options.now ? "（已不足 2 天，排期在下一个调度周期立即执行）" : "";
  return ok(
    "birthday_order",
    `已登记生日礼遇：${options.birthday} 生日，${orderText} 09:00 下单鲜花 ${yuanText(19900)} 元 + 蛋糕 ${yuanText(25900)} 元，` +
      `合计 ${yuanText(totalCents)} 元，从预锁的 ${yuanText(lock.amountCents)} 元里扣${rush}`,
    { giftId: gift.id, birthday: options.birthday, orderAt, totalCents, lockId: lock.id },
  );
}

/**
 * 到期下单：由调度器按 tick 调用。
 * 「用户不在场时钱不能自己走」这条没破 —— 下单在登记时就拿到了明确授权，
 * 且扣款额必须落在已预锁额度内，额度对不上宁可不下单。
 */
export function runDueBirthdayGifts(state: BankState, now: number): Array<{ id: string; ok: boolean; message: string }> {
  const results: Array<{ id: string; ok: boolean; message: string }> = [];
  for (const gift of state.birthdayGifts) {
    if (gift.status !== "scheduled") continue;
    if (gift.orderAt > now) continue;
    const lock = state.lockedFunds.find((item) => item.id === gift.lockId && item.status === "locked");
    if (lock === undefined) {
      gift.status = "cancelled";
      gift.note = "预锁资金已释放，未下单";
      results.push({ id: gift.id, ok: false, message: `生日礼遇 ${gift.id} 取消：预锁资金已释放，未发生扣款` });
      continue;
    }
    // 锁过期就不再具备下单资格：过期还扣款，等于绕开用户当初那次授权的时间边界。
    if (new Date(lock.lockUntil).getTime() < now) {
      gift.status = "cancelled";
      gift.note = `预锁已于 ${lock.lockUntil.slice(0, 10)} 到期，未下单`;
      results.push({ id: gift.id, ok: false, message: `生日礼遇 ${gift.id} 取消：${gift.note}` });
      continue;
    }
    if (state.account.balance < gift.totalCents) {
      gift.status = "cancelled";
      gift.note = `余额 ${yuanText(state.account.balance)} 元不足 ${yuanText(gift.totalCents)} 元，未下单`;
      results.push({ id: gift.id, ok: false, message: `生日礼遇 ${gift.id} 取消：${gift.note}` });
      continue;
    }
    state.account.balance -= gift.totalCents;
    // 锁定期间可用额度已经减过一次，这里只把「没花掉的部分」释放回去，避免双重扣减。
    const release = lock.amountCents - gift.totalCents;
    if (release > 0) state.account.available += release;
    lock.status = "spent";
    gift.status = "ordered";
    gift.orderedAt = now;
    const items = gift.items.map((item) => `${item.name} ${yuanText(item.amountCents)} 元`).join("、");
    results.push({
      id: gift.id,
      ok: true,
      message: `生日礼遇已下单：${items}，合计 ${yuanText(gift.totalCents)} 元；释放未用完的预锁额度 ${yuanText(Math.max(release, 0))} 元`,
    });
  }
  return results;
}

/** 办卡申请：只登记申请，制卡与寄送在线下完成。 */
export function applyCard(state: BankState): ToolResult {
  const id = `card-${String(state.cards.length + 1).padStart(3, "0")}`;
  state.cards.push({ id, label: `新卡 ${id.slice(-4)}（待审核）`, status: "pending", limitCents: 500000 });
  return ok("apply_card", `已提交办卡申请，编号 ${id}，预计 3 个工作日内审核，结果送到预留手机号`, { cardId: id, status: "pending" });
}

/**
 * 分期成本测算：只读，不碰余额、不建单。
 *
 * 回执里三个数必须同时出现 —— 每期还多少、手续费合计多少、真实年化多少。
 * 只说「月费率 0.6%」等于替银行隐瞒成本，这正是消费者权益保护要治的。
 */
export function quoteInstallment(principalCents: number, periods: number, monthlyFeeRate: number): ToolResult {
  const quote = installmentQuote(principalCents, periods, monthlyFeeRate);
  if (quote === null) {
    return fail("installment_quote", "分期参数不合法：本金须为正数、期数 1—60、月费率 0—5%");
  }
  return ok(
    "installment_quote",
    `本金 ${yuanText(quote.principalCents)} 元分 ${quote.periods} 期，每期还款 ${yuanText(Math.round(quote.perPaymentCents))} 元，手续费合计 ${yuanText(Math.round(quote.totalFeeCents))} 元；名义年费率 ${quote.nominalAnnualPct.toFixed(2)}%，真实年化 ${quote.annualSimplePct.toFixed(2)}%（复利口径 ${quote.annualEffectivePct.toFixed(2)}%），真实年化是名义的 ${quote.multiplier.toFixed(2)} 倍`,
    { ...quote },
  );
}

/**
 * 拆分形态核查：只出读数与证据，不动任何资金，也不给结论。
 *
 * 结论（黄/红）在判定层，这里刻意不写 —— 回执里不出现「疑似洗钱」这种定性，
 * 只说「哪几项对上了、哪几项对不上」。定性的话由人说，系统负责把账摆清。
 */
export function checkSplitBatch(
  state: BankState,
  options: { perPaymentCents: number; payees: string[]; linkedCollectionId?: string },
): ToolResult {
  const payees = options.payees.filter((item) => item !== "");
  if (payees.length === 0) return fail("aml_check", "没有给出要核查的收款人");
  if (!Number.isInteger(options.perPaymentCents) || options.perPaymentCents <= 0) {
    return fail("aml_check", "每笔金额必须是大于零的整数分");
  }
  const totalCents = options.perPaymentCents * payees.length;
  const evidence = collectEvidence(
    state,
    { payees, perPaymentCents: options.perPaymentCents },
    {
      windowDays: AML_WINDOW_DAYS,
      ...(options.linkedCollectionId === undefined ? {} : { linkedCollectionId: options.linkedCollectionId }),
    },
  );
  const detail = evidence.items.map((item) => `【${item.label}】${item.detail}`).join("；");
  return ok(
    "aml_check",
    `核查 ${payees.length} 笔、每笔 ${yuanText(options.perPaymentCents)} 元、合计 ${yuanText(totalCents)} 元：${detail}。` +
      `本核查不动任何资金，是否放行由人工按规定裁量`,
    {
      perPaymentCents: options.perPaymentCents,
      totalCents,
      payees,
      support: evidence.support,
      evidence: evidence.items,
    },
  );
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
    case "installment_quote":
      return quoteInstallment(
        typeof slots.principalCents === "number" ? (slots.principalCents as number) : 0,
        typeof slots.periods === "number" ? (slots.periods as number) : 0,
        typeof slots.monthlyFeeRate === "number" ? (slots.monthlyFeeRate as number) : 0,
      );
    case "aml_check":
      return checkSplitBatch(state, {
        perPaymentCents: typeof slots.perPaymentCents === "number" ? (slots.perPaymentCents as number) : 0,
        payees: Array.isArray(slots.payees) ? (slots.payees as string[]).filter((item) => typeof item === "string") : [],
        ...(typeof slots.linkedCollectionId === "string" ? { linkedCollectionId: slots.linkedCollectionId } : {}),
      });
    case "adjust_limit":
      return fail("adjust_limit", "额度调整需柜面办理，线上不执行");
    case "freeze_account":
      return fail("freeze_account", "账户冻结需柜面办理，线上不执行");
    case "birthday_lock":
      return lockBirthdayFunds(state, amount === 0 ? 100000 : amount, text("birthday"));
    case "split_collect":
      return splitCollect(state, {
        totalCents: typeof slots.totalCents === "number" ? (slots.totalCents as number) : amount,
        headcount: typeof slots.headcount === "number" ? (slots.headcount as number) : 0,
        title: text("title"),
        payers: Array.isArray(slots.payers) ? (slots.payers as string[]).filter((item) => typeof item === "string") : [],
      });
    case "birthday_order":
      return createBirthdayGift(state, {
        birthday: text("birthday"),
        budgetCents: typeof slots.budgetCents === "number" ? (slots.budgetCents as number) : amount,
        now: Date.now(),
      });
    default:
      return fail(tool, `工具不在白名单：${tool}`);
  }
}
