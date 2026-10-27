import { createHash, randomUUID } from "node:crypto";
import type { BankState } from "./state.ts";
import { BIRTHDAY_GIFT_ITEMS, BIRTHDAY_LEAD_DAYS, nextBirthdayAt, RISK_LABEL, splitShares } from "./state.ts";
import type { AuditSink } from "./persist.ts";

/** 意图：解析结果，缺槽位时由编排层追问。 */
export interface Intent {
  scene: string;
  tool: string;
  slots: Record<string, unknown>;
  missing: string[];
  confidence: number;
  /** 溯源结论：模型给的参数能不能在原文/通讯录里找到依据。规则解析天然为真，不填。 */
  grounded?: boolean;
  /** 没通过溯源时的具体原因，进判定 detail，给人看。 */
  grounding?: string;
  /** 这个意图是规则解析出来的还是模型给的，审计要区分。 */
  source?: "rule" | "model";
  /**
   * 这一步来自计划编排，而不是单步请求。
   * 用途只有一个：告诉判定「前面还有一步会先建好我依赖的东西」——
   * 生日下单依赖预锁额度，单步执行时没有额度就必须拦，
   * 但它作为计划第二步时，额度由第一步当场创建，不能在预演阶段判死。
   */
  inPlan?: boolean;
}

/** 判定：必须带命中规则，便于解释与测试。 */
export interface Decision {
  level: "green" | "yellow" | "red";
  blocked: boolean;
  requiresConfirm: boolean;
  hits: Array<{ rule: string; detail: string }>;
  summary: string;
}

/**
 * 工具画像：基础等级、是否可撤销、是否需要柜面。
 * reversible 表示事后能否撤销；irreversible 表示连用户确认都不允许，必须走柜面。
 */
const SPECS: Record<string, { scene: string; label: string; level: "green" | "yellow" | "red"; reversible: boolean; irreversible?: boolean; minTier?: Tier }> = {
  query_balance: { scene: "bills", label: "查询余额", level: "green", reversible: true },
  analyze_bills: { scene: "bills", label: "账单分析", level: "green", reversible: true },
  list_subscriptions: { scene: "subscription", label: "查询订阅", level: "green", reversible: true },
  cancel_subscription: { scene: "subscription", label: "取消订阅", level: "yellow", reversible: true },
  lock_card: { scene: "card", label: "锁定卡片", level: "yellow", reversible: true },
  report_loss: { scene: "card", label: "卡片挂失", level: "red", reversible: false, irreversible: true },
  transfer: { scene: "transfer", label: "转账", level: "yellow", reversible: false },
  split_collect: { scene: "split", label: "拆分 AA 收款", level: "green", reversible: true },
  birthday_lock: { scene: "cross", label: "生日资金预锁", level: "yellow", reversible: true },
  birthday_order: { scene: "cross", label: "生日礼遇下单", level: "yellow", reversible: true },
  wealth_redeem: { scene: "wealth", label: "赎回理财", level: "red", reversible: false, irreversible: true, minTier: "gold" },
  wealth_products: { scene: "wealth", label: "理财货架", level: "green", reversible: true },
  wealth_buy: { scene: "wealth", label: "申购理财", level: "yellow", reversible: true },
  adjust_limit: { scene: "card", label: "额度调整", level: "red", reversible: false, irreversible: true },
  freeze_account: { scene: "card", label: "账户冻结", level: "red", reversible: false, irreversible: true },
  fx_convert: { scene: "fx", label: "汇率换算", level: "green", reversible: true },
  schedule_transfer: { scene: "transfer", label: "预约转账", level: "yellow", reversible: true },
  list_scheduled: { scene: "transfer", label: "预约查询", level: "green", reversible: true },
  apply_card: { scene: "card", label: "办卡申请", level: "yellow", reversible: true },
};

/** 币种中文名，拼回执文案用。 */
export const CURRENCY_LABEL: Record<string, string> = {
  USD: "美元",
  EUR: "欧元",
  JPY: "日元",
  HKD: "港币",
  GBP: "英镑",
};

/** 口语里的币种说法映射到 ISO 代码。 */
const CURRENCY_BY_WORD: Record<string, string> = {
  美元: "USD",
  美金: "USD",
  欧元: "EUR",
  日元: "JPY",
  港币: "HKD",
  英镑: "GBP",
};

export function specOf(tool: string) {
  return SPECS[tool];
}

/** 风控策略：四项额度与频次阈值集中在这里，判定只读不写。 */
export interface RiskPolicy {
  /** 单笔限额，分。 */
  singleLimitCents: number;
  /** 当日累计限额，分。 */
  dailyLimitCents: number;
  /** 首次收款人金额达到此值即判红，分。 */
  newPayeeRedCents: number;
  /** 频次统计窗口，分钟。 */
  frequencyWindowMinutes: number;
  /** 窗口内同一收款人允许的笔数。 */
  frequencyMaxCount: number;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  singleLimitCents: 100000,
  dailyLimitCents: 300000,
  newPayeeRedCents: 50000,
  frequencyWindowMinutes: 10,
  frequencyMaxCount: 2,
};

/**
 * 权限分级的主体维度：先看「谁在操作」，再看「操作本身多危险」。
 * 两个维度正交——同一笔 800 元转账，普通客户判红、金卡客户判黄。
 */
export type Tier = "standard" | "gold" | "private";

export const TIER_LABEL: Record<Tier, string> = {
  standard: "普通客户",
  gold: "金卡客户",
  private: "私行客户",
};

const TIER_RANK: Record<Tier, number> = { standard: 0, gold: 1, private: 2 };

/** 请求主体：谁在操作。判定靠它选档位，审计记它，越权拦截也靠它。 */
export interface Actor {
  userId: string;
  tier: Tier;
}

export const DEFAULT_ACTOR: Actor = { userId: "u-1001", tier: "standard" };

/** 档位额度矩阵：每档一套阈值，改这里等于改权限，不需要动判定逻辑。 */
export const TIER_POLICY: Record<Tier, RiskPolicy> = {
  standard: { singleLimitCents: 100000, dailyLimitCents: 300000, newPayeeRedCents: 50000, frequencyWindowMinutes: 10, frequencyMaxCount: 2 },
  gold: { singleLimitCents: 500000, dailyLimitCents: 2000000, newPayeeRedCents: 100000, frequencyWindowMinutes: 10, frequencyMaxCount: 3 },
  private: { singleLimitCents: 5000000, dailyLimitCents: 20000000, newPayeeRedCents: 500000, frequencyWindowMinutes: 10, frequencyMaxCount: 5 },
};

const POLICY_KEYS: Array<keyof RiskPolicy> = [
  "singleLimitCents",
  "dailyLimitCents",
  "newPayeeRedCents",
  "frequencyWindowMinutes",
  "frequencyMaxCount",
];

/** 只挑阈值字段：调用方传进来的对象可能还带着 actor、confirmTtlSeconds 之类的键。 */
function pickPolicy(source: Partial<RiskPolicy> | undefined): Partial<RiskPolicy> {
  const out: Partial<RiskPolicy> = {};
  if (source === undefined) return out;
  for (const key of POLICY_KEYS) {
    const value = source[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

/** 档位解析：主体给不了就按普通客户，显式覆盖优先于档位默认值。 */
export function resolvePolicy(actor?: Actor, override?: Partial<RiskPolicy>): RiskPolicy {
  const tier = actor?.tier ?? "standard";
  return { ...TIER_POLICY[tier], ...pickPolicy(override) };
}

/** 分转元，只用于拼 detail 文案，不参与计算。 */
function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 等级的中文写法，detail 是给人看的，不要出现 green/yellow/red。 */
const LEVEL_LABEL: Record<"green" | "yellow" | "red", string> = { green: "绿", yellow: "黄", red: "红" };

/** 槽位的中文名：追问时直接用它，不要让用户看到 amountCents 这种字段名。 */
const SLOT_LABEL: Record<string, string> = {
  payee: "收款人",
  amountCents: "金额",
  subscriptionName: "订阅名称",
  cardId: "卡片",
};

export function slotLabel(field: string): string {
  return SLOT_LABEL[field] ?? field;
}

/**
 * 账务日口径：两个参数必须显式给，不能靠服务器本地时区。
 * 服务器的时区是运维决定的，账务日是业务决定的 —— 两者一致只是巧合，不该写进代码。
 */
export interface AccountDayConfig {
  /** 业务时区偏移，分钟。东八区 = 480。 */
  tzOffsetMinutes: number;
  /** 账务日切分点，小时（0-23）。0 表示自然日零点切；银行常用 4 点，把夜间交易归到前一天。 */
  cutoffHour: number;
}

export const DEFAULT_ACCOUNT_DAY: AccountDayConfig = { tzOffsetMinutes: 480, cutoffHour: 0 };

/** 跨账务日连笔的观察窗口，分钟。日累计刚清零的那几分钟最容易出现拆单。 */
export const BURST_WINDOW_MINUTES = 30;

/** 把某个时刻按业务时区写成「YYYY-MM-DD HH:mm」，只用于 detail 文案。 */
function bizTime(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms + tzOffsetMinutes * 60000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * 账务日窗口：半开区间 [from, to)。
 * 算法：先平移到业务时区，再减去切分点，按整天取整，最后还原成 UTC 毫秒。
 * 切割点不是 0 时，凌晨那几笔会归到前一个账务日 —— 这正是银行对账要的效果。
 */
export function accountingDay(now: number, config: AccountDayConfig = DEFAULT_ACCOUNT_DAY): { from: number; to: number; label: string } {
  const day = 86400000;
  const offsetMs = config.tzOffsetMinutes * 60000;
  const cutoffMs = config.cutoffHour * 3600000;
  const shifted = now + offsetMs - cutoffMs;
  const from = Math.floor(shifted / day) * day - offsetMs + cutoffMs;
  return {
    from,
    to: from + day,
    label: `${bizTime(from, config.tzOffsetMinutes)} 至 ${bizTime(from + day, config.tzOffsetMinutes)}`,
  };
}

/** 中文数字转阿拉伯数字，支持「五百」「三千五」。 */
export function cnToNumber(text: string): number | null {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let current = 0;
  let lastUnit = 0;
  for (const char of text) {
    if (char in digits) {
      current = digits[char];
      continue;
    }
    const unit = units[char];
    if (unit === 10000) {
      section = (section + current) * unit;
      total += section;
      section = 0;
      current = 0;
      lastUnit = unit;
      continue;
    }
    section += (current === 0 ? 1 : current) * unit;
    current = 0;
    lastUnit = unit;
  }
  // 「三千五」是 3500 不是 3005：末位省略单位时，按上一级的十分之一折算。
  if (current !== 0 && lastUnit >= 100) return total + section + current * (lastUnit / 10);
  return total + section + current;
}

/** 金额抽取：先去掉手机号与长数字，再识别阿拉伯与中文数字，统一返回分。 */
export function extractAmount(text: string): number | null {
  const cleaned = text.replace(/1[3-9]\d{9}/g, " ").replace(/\d{12,}/g, " ");
  const wan = cleaned.match(/(\d+(?:\.\d+)?)\s*万/);
  if (wan !== null) return Math.round(Number(wan[1]) * 10000 * 100);
  const qian = cleaned.match(/(\d+(?:\.\d+)?)\s*千/);
  if (qian !== null) return Math.round(Number(qian[1]) * 1000 * 100);
  const arabic = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (arabic !== null) return Math.round(Number(arabic[1]) * 100);
  const cn = cleaned.match(/([零一二两三四五六七八九十百千万]+)\s*(?:元|块|钱)/);
  if (cn !== null) {
    const value = cnToNumber(cn[1]);
    return value === null ? null : value * 100;
  }
  // 「转给小王三千五」把「元」省了：句尾两位以上中文数字按金额处理，一位不收（避免把「王一」当 1 元）。
  const tail = cleaned.trimEnd().match(/([零一二两三四五六七八九十百千万]{2,})$/);
  if (tail !== null) {
    const value = cnToNumber(tail[1]);
    return value === null ? null : value * 100;
  }
  return null;
}

/**
 * 指代判定：抽出来的是「上次那个」「我妈」「对方」这类说法，不是可核验的户名。
 * 这类词能指很多人，当成收款人等于替用户猜账户 —— 宁可回问一句姓名。
 */
const VAGUE_REFERENT =
  /^(上次|上回|上个月|刚才|之前|那个|这个|这位|那位|他|她|它|对方|人家|我妈|我爸|我哥|我姐|我弟|我妹|我儿子|我女儿|家里人|朋友)/;

export function isVagueReferent(payee: string): boolean {
  if (payee === "") return true;
  return VAGUE_REFERENT.test(payee) || /(那个人|那位|对方)$/.test(payee);
}

/** 收款人抽取：手机号先映射通讯录，其次语法位上的中文名。取不到就返回 null，绝不猜。 */
export function extractPayee(text: string, state: BankState): string | null {
  const phone = text.match(/1[3-9]\d{9}/)?.[0];
  if (phone !== undefined) {
    const contact = state.contacts.find((item) => item.phone === phone);
    return contact?.name ?? null;
  }
  for (const contact of state.contacts) {
    if (text.includes(contact.name)) return contact.name;
  }
  const match = text.match(/(?:转给|给|向)\s*([\u4e00-\u9fa5]{2,4})/);
  if (match === null) return null;
  // 通讯录里真有「我妈」这种名字时，上面的精确匹配已经返回了，走不到这里。
  return isVagueReferent(match[1]) ? null : match[1];
}

/**
 * 生日日期抽取：只认明确的月日说法。
 * 「下个月 15 号」「11 月 15 日」都能解析，「她快过生日了」解析不出来 ——
 * 猜一个日期去下单比不猜危险得多，解析不到就回落到客户资料里的 spouseBirthday。
 */
export function extractBirthday(text: string, now: number): string | null {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const explicit = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (explicit !== null) {
    const month = Number(explicit[1]);
    const date = Number(explicit[2]);
    if (month >= 1 && month <= 12 && date >= 1 && date <= 31) return `${pad(month)}-${pad(date)}`;
  }
  const base = new Date(now);
  const nextMonth = text.match(/下个?月\s*(\d{1,2})\s*[日号]/);
  if (nextMonth !== null) {
    const date = Number(nextMonth[1]);
    if (date >= 1 && date <= 31) {
      const month = base.getMonth() + 2;
      return `${pad(month > 12 ? month - 12 : month)}-${pad(date)}`;
    }
  }
  const bare = text.match(/(\d{1,2})\s*[日号]/);
  if (bare !== null) {
    const date = Number(bare[1]);
    if (date >= 1 && date <= 31) {
      // 只说了几号：本月的这天已过就顺延到下月，这是「过生日」的常识口径。
      const thisMonth = new Date(base.getFullYear(), base.getMonth(), date, 9, 0, 0, 0).getTime();
      const month = thisMonth >= now ? base.getMonth() + 1 : base.getMonth() + 2;
      return `${pad(month > 12 ? month - 12 : month)}-${pad(date)}`;
    }
  }
  return null;
}

/**
 * 取金额前先剥掉日期片段。
 * 「11 月 15 号生日，锁定 1000 元」直接取第一个数字会拿到 11（=1100 元），
 * 这类误读在生日场景里必错，所以先把月日整段摘掉再取。
 */
export function stripDate(text: string): string {
  return text
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, " ")
    .replace(/下个?月\s*\d{1,2}\s*[日号]/g, " ")
    .replace(/(生日|纪念日)前\s*\d+\s*天/g, " ")
    .replace(/\d{1,2}\s*[日号]/g, " ");
}

/** AA 的说法：不出现这些词就不进 AA 分支，避免抢走普通转账。 */
const SPLIT_HINT = /(AA|aa|平摊|均摊|分摊|各付各|各付|拆账)/;

/** 参与人数：阿拉伯数字与中文数字都要认，「4 个人」「三个人」是同一件事。 */
export function extractHeadcount(text: string): number | null {
  const arabic = text.match(/(\d+)\s*(?:个)?人/);
  if (arabic !== null) {
    const value = Number(arabic[1]);
    if (value >= 2 && value <= 50) return value;
  }
  const cn = text.match(/([一二两三四五六七八九十]{1,3})\s*(?:个)?人/);
  if (cn !== null) {
    const value = cnToNumber(cn[1]);
    if (value !== null && value >= 2 && value <= 50) return value;
  }
  return null;
}

/** AA 的用途：只认几种常见场景，认不出来就叫「聚餐」，不硬编名字。 */
const SPLIT_TITLES: Array<[RegExp, string]> = [
  [/聚餐|吃饭|午饭|晚饭|夜宵|饭钱|请客/, "聚餐"],
  [/打车|车费|滴滴|出租车/, "打车"],
  [/房租/, "房租"],
  [/水电|物业费|燃气费/, "水电"],
  [/电影|观影/, "观影"],
  [/旅游|旅行|机票|酒店|民宿/, "旅游"],
];

export function extractSplitTitle(text: string): string {
  for (const [pattern, title] of SPLIT_TITLES) {
    if (pattern.test(text)) return title;
  }
  return "";
}

/** AA 的收款对象：原文点名了通讯录里的人就按点名来，没点名就留空由编排层补占位。 */
export function extractSplitPayers(text: string, state: BankState): string[] {
  return state.contacts.map((contact) => contact.name).filter((name) => text.includes(name));
}

/** 规则解析：先规则，判不出再交给模型。 */
export function parseIntent(text: string, state: BankState): Intent {
  const amount = extractAmount(text);
  if (/(余额|可用额度|还有多少钱)/.test(text)) {
    return { scene: "bills", tool: "query_balance", slots: {}, missing: [], confidence: 0.95 };
  }
  // 直接点名订阅的，不该再要求用户带「会员」两个字：「取消云端音乐」和「取消云幕视频会员」是同一件事。
  const namedSubscription = state.subscriptions.find((item) => text.includes(item.name));
  if (namedSubscription !== undefined && /(取消|退订|关掉|停掉|关闭)/.test(text)) {
    return {
      scene: "subscription",
      tool: "cancel_subscription",
      slots: { subscriptionName: namedSubscription.name },
      missing: [],
      confidence: 0.95,
    };
  }
  if (namedSubscription !== undefined && /(扣费|续费|什么时候扣|多少钱)/.test(text)) {
    return { scene: "subscription", tool: "list_subscriptions", slots: {}, missing: [], confidence: 0.9 };
  }
  if (/(账单|消费|花了|支出|开销)/.test(text)) {
    // 时间口径：说「上个月」就查上月，说「近三个月」就查三个月，说「今年」就查全年，默认本月。
    const period = /(上个月|上月|上一个月)/.test(text)
      ? "last-month"
      : /(近三个月|最近三个月|三个月|近三月)/.test(text)
        ? "3-months"
        : /(今年|年度|全年|这一年)/.test(text)
          ? "this-year"
          : "this-month";
    return { scene: "bills", tool: "analyze_bills", slots: { period }, missing: [], confidence: 0.95 };
  }
  // 汇率放在转账之前：带币种的说法一律先当换算，不猜成跨境转账。
  const currencyHit = /(美元|美金|欧元|日元|港币|英镑)/.exec(text) ?? /(usd|eur|jpy|hkd|gbp)/i.exec(text);
  if (currencyHit !== null) {
    const word = currencyHit[1];
    const currency = CURRENCY_BY_WORD[word] ?? word.toUpperCase();
    const slots: Record<string, unknown> = { currency };
    if (amount !== null) slots.amountCents = amount;
    return { scene: "fx", tool: "fx_convert", slots, missing: amount === null ? ["amountCents"] : [], confidence: 0.95 };
  }
  if (/(订阅|会员|续费|代扣)/.test(text)) {
    if (/(取消|退订|关掉|停掉|关闭)/.test(text)) {
      const name = state.subscriptions.find((item) => text.includes(item.name))?.name ?? "";
      return {
        scene: "subscription",
        tool: "cancel_subscription",
        slots: name === "" ? {} : { subscriptionName: name },
        missing: name === "" ? ["subscriptionName"] : [],
        confidence: name === "" ? 0.7 : 0.95,
      };
    }
    return { scene: "subscription", tool: "list_subscriptions", slots: {}, missing: [], confidence: 0.95 };
  }
  // 改额度与冻结账户：识别出来是为了给解释，不是为了执行。
  if (/(额度|限额).{0,6}(调|提|改|升)|(调|提|改|升).{0,4}额度/.test(text)) {
    return { scene: "card", tool: "adjust_limit", slots: {}, missing: [], confidence: 0.9 };
  }
  if (/(冻结|封卡|停用账户)/.test(text)) {
    return { scene: "card", tool: "freeze_account", slots: {}, missing: [], confidence: 0.9 };
  }
  // 预约查询放在预约登记之前：问「预约转账有哪些」不该被当成新登记。
  if (/(预约|定时).{0,6}(清单|有哪些|查|列表|多少)|查.{0,4}(预约|定时)/.test(text)) {
    return { scene: "transfer", tool: "list_scheduled", slots: {}, missing: [], confidence: 0.9 };
  }
  // 预约转账：带时间词就不是立即转账，登记到预约表，到期仍需确认。
  if (/(定时|预约|明天|后天|下周|下个月|每月)/.test(text) && /(转|汇|打款)/.test(text)) {
    const payee = extractPayee(text, state);
    const slots: Record<string, unknown> = {
      dueOffsetDays: /明天/.test(text) ? 1 : /后天/.test(text) ? 2 : /下周/.test(text) ? 7 : /下个月/.test(text) ? 30 : 1,
    };
    if (payee !== null) slots.payee = payee;
    if (amount !== null) slots.amountCents = amount;
    const missing: string[] = [];
    if (payee === null) missing.push("payee");
    if (amount === null) missing.push("amountCents");
    return { scene: "transfer", tool: "schedule_transfer", slots, missing, confidence: 0.9 };
  }
  // 办卡：只登记申请，制卡在线下完成。
  if (/(办|申请|开|要).{0,6}卡|新卡|信用卡/.test(text)) {
    return { scene: "card", tool: "apply_card", slots: {}, missing: [], confidence: 0.9 };
  }
  // 挂失优先于锁卡：挂失不可撤销，锁卡可解锁。
  if (/(挂失|丢了|丢卡|遗失)/.test(text)) {    return { scene: "card", tool: "report_loss", slots: { cardId: "card-002" }, missing: [], confidence: 0.9 };
  }
  // 卡片只认明确说法，裸「锁定」不抢生日场景的语义。
  if (/(锁卡|锁定卡片|解锁)/.test(text)) {
    return { scene: "card", tool: "lock_card", slots: { cardId: "card-002" }, missing: [], confidence: 0.9 };
  }
  // 理财申购：点名产品的直接下单；只说「推荐/有哪些」的先看货架。放在赎回之前，但排除赎回说法。
  const namedProduct = state.wealthProducts.find((item) => text.includes(item.name));
  if (namedProduct !== undefined && /(买|申购|购入|投|加仓)/.test(text) && !/(赎回|取出|卖出)/.test(text)) {
    const slots: Record<string, unknown> = { productId: namedProduct.id };
    if (amount !== null) slots.amountCents = amount;
    return { scene: "wealth", tool: "wealth_buy", slots, missing: amount === null ? ["amountCents"] : [], confidence: 0.95 };
  }
  if (/(理财|基金|产品).{0,8}(推荐|有哪些|对比|看看|收益|利率)|推荐.{0,6}(理财|基金|产品)/.test(text)) {
    return { scene: "wealth", tool: "wealth_products", slots: {}, missing: [], confidence: 0.9 };
  }
  if (/(赎回|取出)/.test(text)) {
    return {
      scene: "wealth",
      tool: "wealth_redeem",
      slots: amount === null ? {} : { amountCents: amount },
      missing: [],
      confidence: 0.95,
    };
  }
  // AA 收款：先剥掉「几个人」再取金额，否则「4 个人 AA 240 块」会把 4 当成 400 元。
  if (SPLIT_HINT.test(text)) {
    const withoutHeadcount = text.replace(/(\d+|[一二两三四五六七八九十]{1,3})\s*(?:个)?人/g, " ");
    const total = extractAmount(withoutHeadcount);
    const named = extractSplitPayers(text, state);
    const headcount = extractHeadcount(text) ?? (named.length > 0 ? named.length + 1 : null);
    const slots: Record<string, unknown> = { title: extractSplitTitle(text) };
    if (total !== null) slots.totalCents = total;
    if (headcount !== null) slots.headcount = headcount;
    if (named.length > 0) slots.payers = named;
    const missing: string[] = [];
    if (total === null) missing.push("totalCents");
    if (headcount === null) missing.push("headcount");
    return { scene: "split", tool: "split_collect", slots, missing, confidence: missing.length === 0 ? 0.95 : 0.8 };
  }
  // 生日放在转账之前：避免「帮我准备生日，锁定一千」被当成转账。
  if (/(生日|纪念日)/.test(text)) {
    // 先剥掉月日再取金额：「11 月 15 号生日，锁定 1000 元」不能读成 1100 元。
    const cleanAmount = extractAmount(stripDate(text));
    // 没说日期就用客户资料里登记过的，不猜。
    const birthday = extractBirthday(text, Date.now()) ?? state.customer.spouseBirthday ?? "";
    const wantsGift = /(鲜花|蛋糕|礼物)/.test(text);
    if (wantsGift && !/(锁定|锁住|预留|预锁|先存)/.test(text)) {
      const budgetCents = cleanAmount ?? 100000;
      return {
        scene: "cross",
        tool: "birthday_order",
        slots: { birthday, budgetCents },
        missing: birthday === "" ? ["birthday"] : [],
        confidence: 0.9,
      };
    }
    return {
      scene: "cross",
      tool: "birthday_lock",
      slots: cleanAmount === null ? { birthday } : { amountCents: cleanAmount, birthday },
      missing: [],
      confidence: 0.9,
    };
  }
  if (/(转|汇|打款)/.test(text)) {
    const payee = extractPayee(text, state);
    const slots: Record<string, unknown> = {};
    if (payee !== null) slots.payee = payee;
    if (amount !== null) slots.amountCents = amount;
    // 收款人来自备注/转发文本：来源不可信，不补问金额，直接交给判定拦红。
    if (/(按|照|根据|依照)\s*备注|备注(里|中|上)/.test(text)) {
      slots.payeeSource = "remark";
      return { scene: "transfer", tool: "transfer", slots, missing: [], confidence: 0.9 };
    }
    // 收款人填的是卡号/账号：户名核不了，不能当收款人用。卡号只留前四后四，不落全量。
    const accountNumber = text.match(/\d{12,19}/)?.[0];
    if (accountNumber !== undefined) {
      slots.payeeSource = "card-number";
      slots.payeeMasked = `${accountNumber.slice(0, 4)}****${accountNumber.slice(-4)}`;
      return { scene: "transfer", tool: "transfer", slots, missing: [], confidence: 0.9 };
    }
    const missing: string[] = [];
    if (payee === null) missing.push("payee");
    if (amount === null) missing.push("amountCents");
    return { scene: "transfer", tool: "transfer", slots, missing, confidence: missing.length === 0 ? 0.95 : 0.8 };
  }
  return { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence: 0 };
}

/**
 * 幻觉防护：模型给的参数必须能在原文或通讯录里找到依据。
 * 模型可以错，但不能编 —— 编出来的金额和收款人一旦放过去，就是真金白银的损失。
 * 规则解析不经过这里：它本来就只从原文里取，天然有据。
 */export function groundIntent(intent: Intent, text: string, state: BankState): Intent {
  if (intent.tool === "unknown") return intent;
  const problems: string[] = [];

  const amount = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : null;
  if (amount !== null && amount > 0) {
    const fromText = extractAmount(text);
    if (fromText === null) {
      problems.push(`模型给出金额 ${yuan(amount)} 元，但原文里没有任何金额`);
    } else if (fromText !== amount) {
      problems.push(`模型给出金额 ${yuan(amount)} 元，原文实际是 ${yuan(fromText)} 元`);
    }
  }

  const payee = typeof intent.slots.payee === "string" ? (intent.slots.payee as string) : null;
  if (payee !== null && payee !== "") {
    const inContacts = state.contacts.some((contact) => contact.name === payee);
    const inText = text.includes(payee);
    if (!inContacts && !inText) {
      problems.push(`模型给出收款人「${payee}」，不在 ${state.contacts.length} 位联系人里，原文也没出现过`);
    }
  }

  if (problems.length === 0) return { ...intent, grounded: true, source: "model" };
  return { ...intent, grounded: false, grounding: problems.join("；"), source: "model" };
}

/** 计划里的一步：一个意图，可以带前置条件。 */
export interface PlanStep {
  intent: Intent;
  /** 执行前的条件；不满足就跳过这一步并说明原因，不当成失败。 */
  guard?: "balance-sufficient";
}

/**
 * 计划：一句话里有多件事。
 * sequential 是「先做 A 再做 B」，conditional 是「先查够不够，够再做」。
 */
export interface Plan {
  kind: "sequential" | "conditional";
  steps: PlanStep[];
  text: string;
}

/** 顺序连接词：出现这些词才切句，避免把「分三笔各 900 元」误当成多步。 */
const PLAN_JOINER = /(?:，|,|；|;|。)?\s*(?:然后|紧接着|之后|接着|顺便|最后|再)\s*/;

/**
 * 计划解析：先看一眼余额够不够，再按连接词切句。
 * 切不出两步就返回 null，交给单步链路处理 —— 计划不是万能的，猜错不如不猜。
 */
export function parsePlan(text: string, state: BankState): Plan | null {
  // 一、条件式：「查一下余额够不够转给小王 500 元」。
  if (/(余额|账户|钱|额度).{0,6}(够|不够|足|不足)|(够|不够).{0,4}(转|汇|打款)/.test(text) && /(转|汇|打款)/.test(text)) {
    const payee = extractPayee(text, state);
    const amount = extractAmount(text);
    if (payee !== null && amount !== null) {
      return {
        kind: "conditional",
        text,
        steps: [
          { intent: { scene: "bills", tool: "query_balance", slots: {}, missing: [], confidence: 1 } },
          {
            intent: { scene: "transfer", tool: "transfer", slots: { payee, amountCents: amount }, missing: [], confidence: 0.9 },
            guard: "balance-sufficient",
          },
        ],
      };
    }
  }

  // 一之二、跨场景生日：一句话里包含「锁定资金」和「到时候订礼物」两件事。
  // 这两件事有先后依赖 —— 下单的额度来自上一步的预锁，所以拆成固定两步、按序执行，
  // 而不是靠连接词切句（用户经常一个连接词都不给）。
  // 必须显式说了「锁定/预留」才拆成两步：用户只说「订鲜花蛋糕」时，
  // 替他凭空锁定 1000 元是越权，那种请求应该走单步并被「没有预锁额度」拦下。
  if (/(生日|纪念日)/.test(text) && /(鲜花|蛋糕|礼物)/.test(text) && /(锁定|锁住|预留|预锁|先存)/.test(text)) {
    const birthday = extractBirthday(text, Date.now()) ?? state.customer.spouseBirthday ?? "";
    const budget = extractAmount(stripDate(text)) ?? 100000;
    if (birthday !== "" && budget > 0) {
      return {
        kind: "sequential",
        text,
        steps: [
          {
            intent: {
              scene: "cross",
              tool: "birthday_lock",
              slots: { amountCents: budget, birthday },
              missing: [],
              confidence: 0.9,
              inPlan: true,
            },
          },
          {
            intent: {
              scene: "cross",
              tool: "birthday_order",
              slots: { birthday, budgetCents: budget },
              missing: [],
              confidence: 0.9,
              inPlan: true,
            },
          },
        ],
      };
    }
  }

  // 二、顺序式：按连接词切句，每段各自解析，解析不出的段丢掉。
  const segments = text
    .split(PLAN_JOINER)
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (segments.length < 2) return null;

  const steps: PlanStep[] = [];
  for (const segment of segments) {
    const intent = parseIntent(segment, state);
    if (intent.tool === "unknown") continue;
    // 后一段省了金额或收款人时，从前一段和整句里补，补不上就留作缺槽由编排层追问。
    if (intent.tool === "transfer") {
      const amount = extractAmount(segment) ?? extractAmount(text);
      const payee = extractPayee(segment, state) ?? extractPayee(text, state);
      if (amount !== null) intent.slots.amountCents = amount;
      if (payee !== null) intent.slots.payee = payee;
      intent.missing = [];
      if (intent.slots.payee === undefined) intent.missing.push("payee");
      if (intent.slots.amountCents === undefined) intent.missing.push("amountCents");
    }
    steps.push({ intent });
  }

  // 只有「前面真有一步会建好预锁额度」时，才允许生日下单在预演阶段放过 ——
  // 不能因为「它写在计划里」就一律放过，那等于给计划开了个后门。
  for (const [index, step] of steps.entries()) {
    const hasEarlierLock = steps.slice(0, index).some((item) => item.intent.tool === "birthday_lock");
    if (step.intent.tool === "birthday_order" && hasEarlierLock) step.intent.inPlan = true;
  }

  if (steps.length < 2) return null;
  return { kind: "sequential", text, steps };
}

/**
 * 外部反欺诈结论：只当证据用，不替代本地判定。
 * 本地规则看的是「金额、频次、可逆性」，外部看的是「这个收款人本身有没有问题」——
 * 后者本地永远算不出来，所以要么信它、要么如实降级，不能装作没这回事。
 */
export interface RiskEvidence {
  level: "low" | "medium" | "high";
  /** 外部命中的具体条目，原样带进 detail，不做二次解释。 */
  hits: string[];
  advice?: string;
  source: "external" | "degraded";
  /** 降级原因：超时、不可用、返回缺字段。 */
  reason?: string;
}

/** 判定的入参：主体 + 可选的阈值覆盖 + 外部证据 + 时钟与账务日口径。 */
export interface EvaluateOptions extends Partial<RiskPolicy> {
  actor?: Actor;
  evidence?: RiskEvidence;
  /** 判定用的「现在」。只在测试与回放时传，生产一律取真实时间。 */
  now?: number;
  accountDay?: AccountDayConfig;
}

/**
 * 三色判定：权限档位 + 基础等级 + 金额（单笔、日累计）+ 收款人（是否首次）+ 可逆性 + 频次。
 * 只读 state，不写任何字段；每条命中都带独立 rule 名与含具体数字的 detail。
 */
export function evaluate(intent: Intent, state: BankState, options: EvaluateOptions = {}): Decision {
  const spec = specOf(intent.tool);
  if (spec === undefined) {
    return {
      level: "red",
      blocked: true,
      requiresConfirm: false,
      hits: [{ rule: "tool-whitelist", detail: `工具 ${intent.tool} 不在白名单` }],
      summary: "不在可执行范围内",
    };
  }
  const tier: Tier = options.actor?.tier ?? "standard";
  const rules: RiskPolicy = resolvePolicy(options.actor, options);
  const hits: Array<{ rule: string; detail: string }> = [
    { rule: "base-level", detail: `${spec.label}基础等级为${LEVEL_LABEL[spec.level]}（${spec.reversible ? "可撤销" : "不可撤销"}，${spec.irreversible === true ? "必须柜面" : "可线上办理"}）` },
    {
      rule: "actor-tier",
      // 转账才列金额阈值，别的业务列三级阈值只会干扰阅读。
      detail:
        spec.scene === "transfer"
          ? `${TIER_LABEL[tier]}（${options.actor?.userId ?? "未传主体"}）：单笔上限 ${yuan(rules.singleLimitCents)} 元、日累计上限 ${yuan(rules.dailyLimitCents)} 元、首次收款人红线 ${yuan(rules.newPayeeRedCents)} 元`
          : `${TIER_LABEL[tier]}（${options.actor?.userId ?? "未传主体"}）：按该档位校验${spec.label}的权限`,
    },
  ];
  let level: "green" | "yellow" | "red" = spec.level;
  let blocked = false;

  // 零、权限：档位不够的业务，连确认都不给。
  if (spec.minTier !== undefined && TIER_RANK[tier] < TIER_RANK[spec.minTier]) {
    hits.push({
      rule: "tier-insufficient",
      detail: `当前是${TIER_LABEL[tier]}（第 ${TIER_RANK[tier] + 1} 档），${spec.label}需要${TIER_LABEL[spec.minTier]}（第 ${TIER_RANK[spec.minTier] + 1} 档）及以上`,
    });
    level = "red";
    blocked = true;
  }

  const amount = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : 0;
  const payee = typeof intent.slots.payee === "string" ? (intent.slots.payee as string) : "";
  const isTransfer = spec.scene === "transfer";
  const now = options.now ?? Date.now();
  const accountDayConfig = options.accountDay ?? DEFAULT_ACCOUNT_DAY;
  const day = accountingDay(now, accountDayConfig);

  // 零点五、幻觉：模型给的参数在原文里找不到依据，直接红。这是「模型可以错，但不能编」的落点。
  if (intent.grounded === false) {
    hits.push({
      rule: "grounding",
      detail: `模型给出的参数无法溯源：${intent.grounding ?? "原文里没有对应依据"}`,
    });
    level = "red";
    blocked = true;
  }

  // 一、可逆性：连确认都不给的，直接红。
  if (spec.irreversible === true) {
    hits.push({
      rule: "irreversible",
      detail: amount > 0 ? `${spec.label}执行后不可撤销，涉及 ${yuan(amount)} 元只能柜面办理` : `${spec.label}执行后不可撤销，只能柜面办理`,
    });
    level = "red";
    blocked = true;
  }

  // 二、收款人来源：备注里的名字不算可信来源，补金额也没用。
  if (isTransfer && intent.slots.payeeSource === "remark") {
    hits.push({
      rule: "payee-from-remark",
      detail: `收款人「${payee === "" ? "未提取到" : payee}」来自备注文本，不是通讯录里 ${state.contacts.length} 位联系人之一`,
    });
    level = "red";
    blocked = true;
  }

  // 二之二、收款人是卡号：户名无法在线核验，不当作可信收款人。
  if (isTransfer && intent.slots.payeeSource === "card-number") {
    const masked = typeof intent.slots.payeeMasked === "string" ? (intent.slots.payeeMasked as string) : "未知卡号";
    hits.push({
      rule: "payee-from-card-number",
      detail: `收款人写的是卡号 ${masked}，无法在线核验户名，需要先选定通讯录联系人或到柜面办理`,
    });
    level = "red";
    blocked = true;
  }

  // 二之三、外部反欺诈证据：本地看不出来、只有外部知道的那部分。
  // 高：直接拦红；中：抬到需确认；低：只记一条不改颜色；外部不可用：统一降级为需确认。
  // 降级的方向很重要 —— 宁可多要一次确认，也不假装「没查到风险就等于没风险」。
  if (isTransfer && options.evidence !== undefined) {
    const evidence = options.evidence;
    if (evidence.source === "degraded") {
      hits.push({
        rule: "external-degraded",
        detail: `反欺诈服务不可用（${evidence.reason ?? "未知原因"}），收款人风险无法核验，按降级策略处理：需要你确认后才执行`,
      });
      if (level === "green") level = "yellow";
    } else if (evidence.level === "high") {
      hits.push({
        rule: "external-risk",
        detail: `反欺诈判定「${payee}」为高风险：${evidence.hits.join("、")}；外部建议：${evidence.advice ?? "人工复核"}，线上不执行`,
      });
      level = "red";
      blocked = true;
    } else if (evidence.level === "medium") {
      hits.push({
        rule: "external-risk",
        detail: `反欺诈判定「${payee}」为中风险：${evidence.hits.join("、")}；外部建议：${evidence.advice ?? "二次确认"}`,
      });
      if (level === "green") level = "yellow";
    } else {
      hits.push({ rule: "external-risk", detail: `反欺诈未命中风险特征（${payee}），可正常受理` });
    }
  }

  // 三、金额：单笔限额。
  if (isTransfer && amount > rules.singleLimitCents) {
    hits.push({
      rule: "single-limit",
      detail: `本次 ${yuan(amount)} 元，超过单笔限额 ${yuan(rules.singleLimitCents)} 元，超出 ${yuan(amount - rules.singleLimitCents)} 元`,
    });
    level = "red";
    blocked = true;
  }

  // 四、金额：日累计限额。口径是「账务日」，不是服务器本地自然日。
  if (isTransfer) {
    const todayTotal = state.transferLog
      .filter((record) => record.at >= day.from && record.at < day.to)
      .reduce((sum, record) => sum + record.amountCents, 0);
    if (todayTotal + amount > rules.dailyLimitCents) {
      hits.push({
        rule: "daily-limit",
        detail: `本账务日（${day.label}）已转 ${yuan(todayTotal)} 元，本次 ${yuan(amount)} 元，合计 ${yuan(todayTotal + amount)} 元超过日累计限额 ${yuan(rules.dailyLimitCents)} 元`,
      });
      level = "red";
      blocked = true;
    }
  }

  // 四之二、跨账务日连笔：日累计刚清零的那几分钟，是把一笔大额拆成两笔最省事的窗口。
  // 只在「新账务日刚开始」时看切换点之前那一段，避免白天正常转账被这条规则扫到。
  if (isTransfer && now - day.from <= BURST_WINDOW_MINUTES * 60000) {
    const burstStart = day.from - BURST_WINDOW_MINUTES * 60000;
    const crossing = state.transferLog.filter((record) => record.at >= burstStart && record.at < day.from);
    if (crossing.length >= 2) {
      const crossedTotal = crossing.reduce((sum, record) => sum + record.amountCents, 0);
      hits.push({
        rule: "midnight-burst",
        detail:
          `账务日刚在 ${bizTime(day.from, accountDayConfig.tzOffsetMinutes)} 切换：切换前 ${BURST_WINDOW_MINUTES} 分钟内已转 ` +
          `${crossing.length} 笔共 ${yuan(crossedTotal)} 元，本次 ${yuan(amount)} 元计入新账务日、日累计已从零重算，需要你确认一次`,
      });
      if (level === "green") level = "yellow";
    }
  }

  // 五、收款人：是否首次。没有金额时不做这条，避免「0.00 元」这种噪音。
  if (isTransfer && payee !== "" && amount > 0) {
    const paidBefore = state.transferLog.filter((record) => record.payee === payee).length;
    if (paidBefore === 0) {
      const inContacts = state.contacts.some((contact) => contact.name === payee);
      if (amount >= rules.newPayeeRedCents) {
        hits.push({
          rule: "new-payee",
          detail: `首次向 ${payee} 转账 ${yuan(amount)} 元，达到首次收款人红线 ${yuan(rules.newPayeeRedCents)} 元（${inContacts ? "在通讯录" : "不在通讯录"}）`,
        });
        level = "red";
        blocked = true;
      } else {
        hits.push({
          rule: "new-payee",
          detail: `首次向 ${payee} 转账 ${yuan(amount)} 元，未达红线 ${yuan(rules.newPayeeRedCents)} 元，需确认`,
        });
        if (level === "green") level = "yellow";
      }
    }
  }

  // 六、可逆性：不可撤销但允许确认的，抬到黄。
  if (!spec.reversible && spec.irreversible !== true) {
    hits.push({
      rule: "reversibility",
      detail: amount > 0 ? `${spec.label}执行后无法撤销，${yuan(amount)} 元只能确认后执行` : `${spec.label}执行后无法撤销，只能确认后执行`,
    });
    if (level === "green") level = "yellow";
  }

  // 七、频次：短窗口内反复向同一收款人转账。
  if (isTransfer && payee !== "") {
    const since = now - rules.frequencyWindowMinutes * 60000;
    const recent = state.transferLog.filter((record) => record.payee === payee && record.at >= since).length;
    if (recent >= rules.frequencyMaxCount) {
      hits.push({
        rule: "frequency",
        detail: `${rules.frequencyWindowMinutes} 分钟内已向 ${payee} 转账 ${recent} 笔，达到频次上限 ${rules.frequencyMaxCount} 笔`,
      });
      level = "red";
      blocked = true;
    }
  }

  // 八、理财适当性：产品风险高于客户承受等级，或低于起购金额，都不予申购。
  if (intent.tool === "wealth_buy") {
    const productId = typeof intent.slots.productId === "string" ? (intent.slots.productId as string) : "";
    const product = state.wealthProducts.find((item) => item.id === productId || item.name === productId);
    if (product !== undefined) {
      const customerLevel = state.customer.riskLevel;
      if (product.riskLevel > customerLevel) {
        hits.push({
          rule: "suitability",
          detail: `${product.name}风险等级 ${product.riskLevel}（${RISK_LABEL[product.riskLevel] ?? "未评级"}）高于你的承受等级 ${customerLevel}（${RISK_LABEL[customerLevel] ?? "未评级"}），不予申购`,
        });
        level = "red";
        blocked = true;
      }
      if (amount > 0 && amount < product.minAmountCents) {
        hits.push({
          rule: "min-amount",
          detail: `${product.name}起购 ${yuan(product.minAmountCents)} 元，本次 ${yuan(amount)} 元不足`,
        });
        level = "red";
        blocked = true;
      }
    }
  }

  // 九、AA 收款：本身不动钱，但「把一笔拆成多笔」正是规避限额的经典手法，
  // 所以额度一律按总额看，不看人均 —— 按人均看的话，拆成 20 人就能绕过所有限额。
  if (intent.tool === "split_collect") {
    const total = typeof intent.slots.totalCents === "number" ? (intent.slots.totalCents as number) : 0;
    const headcount = typeof intent.slots.headcount === "number" ? (intent.slots.headcount as number) : 0;
    const payers = Array.isArray(intent.slots.payers)
      ? (intent.slots.payers as unknown[]).filter((item): item is string => typeof item === "string")
      : [];
    const shares = splitShares(total, headcount);
    if (headcount < 2) {
      hits.push({ rule: "split-headcount", detail: `AA 收款需要至少 2 人参与，当前只有 ${headcount} 人` });
      level = "red";
      blocked = true;
    } else if (shares === null) {
      hits.push({ rule: "split-headcount", detail: `总额 ${yuan(total)} 元摊给 ${headcount} 人，每人不足 1 分，无法拆分` });
      level = "red";
      blocked = true;
    } else {
      hits.push({
        rule: "split-share",
        detail:
          `总额 ${yuan(total)} 元按 ${headcount} 人拆：其他人每人 ${yuan(shares.perPersonCents)} 元、共 ${headcount - 1} 人，` +
          `你承担 ${yuan(shares.myShareCents)} 元，三项相加恰好 ${yuan(total)} 元`,
      });
    }
    if (total > rules.singleLimitCents) {
      hits.push({
        rule: "split-limit",
        detail: `本次 AA 总额 ${yuan(total)} 元，超过单笔限额 ${yuan(rules.singleLimitCents)} 元，超出 ${yuan(total - rules.singleLimitCents)} 元`,
      });
      level = "red";
      blocked = true;
    }
    const todayCollections = state.collections.filter((item) => item.createdAt >= day.from && item.createdAt < day.to && item.status === "collecting");
    if (todayCollections.length > 0) {
      const todayTotal = todayCollections.reduce((sum, item) => sum + item.totalCents, 0);
      if (todayTotal + total > rules.dailyLimitCents) {
        hits.push({
          rule: "split-daily",
          detail: `本账务日（${day.label}）已发起 ${todayCollections.length} 笔 AA 收款共 ${yuan(todayTotal)} 元，加本次 ${yuan(total)} 元超过日累计上限 ${yuan(rules.dailyLimitCents)} 元`,
        });
        level = "red";
        blocked = true;
      }
    }
    const outsiders = payers.filter((name) => !state.contacts.some((contact) => contact.name === name));
    if (outsiders.length > 0) {
      hits.push({
        rule: "split-outsider",
        detail: `参与人 ${outsiders.join("、")} 不在通讯录的 ${state.contacts.length} 位联系人里，收款对象无法核验`,
      });
      if (level === "green") level = "yellow";
    }
  }

  // 十、生日礼遇下单：额度必须来自预锁资金，不允许「先买了再说」。
  if (intent.tool === "birthday_order") {
    const budget = typeof intent.slots.budgetCents === "number" ? (intent.slots.budgetCents as number) : 0;
    const birthday = typeof intent.slots.birthday === "string" ? (intent.slots.birthday as string) : "";
    const locked = state.lockedFunds
      .filter((item) => item.status === "locked" && item.purpose.includes("生日"))
      .reduce((sum, item) => sum + item.amountCents, 0);
    const cost = BIRTHDAY_GIFT_ITEMS.reduce((sum, item) => sum + item.amountCents, 0);
    if (birthday === "") {
      hits.push({ rule: "gift-no-date", detail: "没有可用的生日日期，无法推算下单时点" });
      level = "red";
      blocked = true;
    } else {
      const birthdayAt = nextBirthdayAt(birthday, now);
      if (birthdayAt !== null) {
        const planned = Math.max(birthdayAt - BIRTHDAY_LEAD_DAYS * 86400000, now);
        hits.push({
          rule: "gift-lead",
          detail: `生日 ${birthday}，计划在 ${new Date(planned).toISOString().slice(0, 10)} 09:00 下单，提前 ${BIRTHDAY_LEAD_DAYS} 天；下单前不动账`,
        });
      }
    }
    if (budget > 0 && budget < cost) {
      hits.push({ rule: "gift-items", detail: `预算 ${yuan(budget)} 元不够，鲜花与蛋糕合计 ${yuan(cost)} 元` });
      level = "red";
      blocked = true;
    }
    if (locked === 0 && intent.inPlan !== true) {
      hits.push({
        rule: "gift-no-lock",
        detail: `已预锁的生日额度是 ${yuan(0)} 元，本次要花 ${yuan(cost)} 元，需要先锁定资金再下单`,
      });
      level = "red";
      blocked = true;
    } else if (locked > 0 && budget > locked) {
      hits.push({
        rule: "gift-over-budget",
        detail: `本次预算 ${yuan(budget)} 元，超过已预锁的 ${yuan(locked)} 元，超出 ${yuan(budget - locked)} 元`,
      });
      level = "red";
      blocked = true;
    } else if (locked === 0) {
      hits.push({
        rule: "gift-lock-pending",
        detail: `预锁额度由本计划第 1 步当场创建，下单金额 ${yuan(cost)} 元必须在它之内`,
      });
    } else {
      hits.push({
        rule: "gift-budget",
        detail: `已预锁 ${yuan(locked)} 元，本次预算 ${yuan(budget)} 元，鲜花与蛋糕合计 ${yuan(cost)} 元，下单后释放未用完的 ${yuan(Math.max(locked - cost, 0))} 元`,
      });
    }
  }

  return {
    level,
    blocked,
    requiresConfirm: !blocked && level === "yellow",
    hits,
    summary: `${spec.label}（判定${LEVEL_LABEL[level]}）`,
  };
}

/** 确认令牌：绑定会话、工具、参数摘要与过期时间。 */
export interface Ticket {
  token: string;
  digest: string;
  expiresAt: number;
  tool: string;
  slots: Record<string, unknown>;
}

export function digestOf(tool: string, slots: Record<string, unknown>): string {
  const canonical = JSON.stringify({ tool, slots: Object.keys(slots).sort().map((key) => [key, slots[key]]) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function issueTicket(sessionId: string, tool: string, slots: Record<string, unknown>, ttlSeconds: number): Ticket & { sessionId: string } {
  return {
    token: randomUUID(),
    digest: digestOf(tool, slots),
    expiresAt: Date.now() + ttlSeconds * 1000,
    tool,
    slots,
    sessionId,
  };
}

export function verifyTicket(ticket: Ticket | undefined, sessionId: string, token: string): { ok: boolean; reason: string } {
  if (ticket === undefined) return { ok: false, reason: "没有待确认的操作" };
  if (ticket.token !== token) return { ok: false, reason: "令牌不匹配" };
  if (Date.now() > ticket.expiresAt) return { ok: false, reason: "令牌已过期" };
  return { ok: true, reason: "" };
}

/** 审计记录与哈希链。actor 记「谁在操作」，是权限分级的证据。 */
export interface AuditRecord {
  seq: number;
  ts: string;
  sessionId: string;
  actor: string;
  userText: string;
  tool: string;
  decision: string;
  level: string;
  rules: string[];
  result: string;
  prevHash: string;
  hash: string;
}

export class AuditChain {
  private readonly records: AuditRecord[];
  /** 落盘出口：每追加一条就写一行并 fsync。不传就是纯内存，单测与演示用。 */
  private readonly sink?: AuditSink;

  constructor(sink?: AuditSink, initial: AuditRecord[] = []) {
    this.sink = sink;
    this.records = [...initial];
  }

  append(input: Omit<AuditRecord, "seq" | "ts" | "prevHash" | "hash" | "actor"> & { actor?: string }): AuditRecord {
    const seq = this.records.length + 1;
    const prevHash = this.records.at(-1)?.hash ?? "GENESIS";
    const actor = input.actor ?? "system";
    const payload = JSON.stringify({
      seq,
      sessionId: input.sessionId,
      actor,
      userText: input.userText,
      tool: input.tool,
      decision: input.decision,
      level: input.level,
      rules: input.rules,
      result: input.result,
    });
    const record: AuditRecord = {
      seq,
      ts: new Date().toISOString(),
      ...input,
      actor,
      prevHash,
      hash: createHash("sha256").update(`${prevHash}|${payload}`).digest("hex"),
    };
    this.records.push(record);
    this.sink?.append(record);
    return record;
  }

  list(sessionId?: string, limit = 20): AuditRecord[] {
    const filtered = sessionId === undefined ? this.records : this.records.filter((item) => item.sessionId === sessionId);
    return filtered.slice(-limit);
  }

  verify(): { ok: boolean; total: number; brokenAt: number | null } {
    let prev = "GENESIS";
    for (const record of this.records) {
      const payload = JSON.stringify({
        seq: record.seq,
        sessionId: record.sessionId,
        actor: record.actor,
        userText: record.userText,
        tool: record.tool,
        decision: record.decision,
        level: record.level,
        rules: record.rules,
        result: record.result,
      });
      const expect = createHash("sha256").update(`${prev}|${payload}`).digest("hex");
      if (record.hash !== expect || record.prevHash !== prev) {
        return { ok: false, total: this.records.length, brokenAt: record.seq };
      }
      prev = record.hash;
    }
    return { ok: true, total: this.records.length, brokenAt: null };
  }

  /** 演示篡改检测用：直接改一条记录的结论。 */
  tamper(seq: number, result: string): void {
    const target = this.records.find((item) => item.seq === seq);
    if (target !== undefined) target.result = result;
  }
}

/** 脱敏：卡号与手机号在写入审计前替换。 */
export function redact(text: string): string {
  return text.replace(/1[3-9]\d{9}/g, (value) => `${value.slice(0, 3)}****${value.slice(-4)}`).replace(/\b\d{12,19}\b/g, (value) => `****${value.slice(-4)}`);
}
