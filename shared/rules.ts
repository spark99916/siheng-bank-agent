import { createHash, randomUUID } from "node:crypto";
import type { BankState } from "./state.ts";

/** 意图：解析结果，缺槽位时由编排层追问。 */
export interface Intent {
  scene: string;
  tool: string;
  slots: Record<string, unknown>;
  missing: string[];
  confidence: number;
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
const SPECS: Record<string, { scene: string; label: string; level: "green" | "yellow" | "red"; reversible: boolean; irreversible?: boolean }> = {
  query_balance: { scene: "bills", label: "查询余额", level: "green", reversible: true },
  analyze_bills: { scene: "bills", label: "账单分析", level: "green", reversible: true },
  list_subscriptions: { scene: "subscription", label: "查询订阅", level: "green", reversible: true },
  cancel_subscription: { scene: "subscription", label: "取消订阅", level: "yellow", reversible: true },
  lock_card: { scene: "card", label: "锁定卡片", level: "yellow", reversible: true },
  report_loss: { scene: "card", label: "卡片挂失", level: "red", reversible: false, irreversible: true },
  transfer: { scene: "transfer", label: "转账", level: "yellow", reversible: false },
  birthday_lock: { scene: "cross", label: "生日资金预锁", level: "yellow", reversible: true },
  wealth_redeem: { scene: "wealth", label: "赎回理财", level: "red", reversible: false, irreversible: true },
  fx_convert: { scene: "fx", label: "汇率换算", level: "green", reversible: true },
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

/** 当日零点，用于日累计口径。 */
function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
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
  return match === null ? null : match[1];
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
    // 时间口径：说「上个月」就查上月，说「近三个月」就查三个月，默认本月。
    const period = /(上个月|上月|上一个月)/.test(text)
      ? "last-month"
      : /(近三个月|最近三个月|三个月|近三月)/.test(text)
        ? "3-months"
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
  // 挂失优先于锁卡：挂失不可撤销，锁卡可解锁。
  if (/(挂失|丢了|丢卡|遗失)/.test(text)) {
    return { scene: "card", tool: "report_loss", slots: { cardId: "card-002" }, missing: [], confidence: 0.9 };
  }
  // 卡片只认明确说法，裸「锁定」不抢生日场景的语义。
  if (/(锁卡|锁定卡片|解锁)/.test(text)) {
    return { scene: "card", tool: "lock_card", slots: { cardId: "card-002" }, missing: [], confidence: 0.9 };
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
  // 生日放在转账之前：避免「帮我准备生日，锁定一千」被当成转账。
  if (/(生日|纪念日)/.test(text)) {
    return {
      scene: "cross",
      tool: "birthday_lock",
      slots: amount === null ? {} : { amountCents: amount },
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
    const missing: string[] = [];
    if (payee === null) missing.push("payee");
    if (amount === null) missing.push("amountCents");
    return { scene: "transfer", tool: "transfer", slots, missing, confidence: missing.length === 0 ? 0.95 : 0.8 };
  }
  return { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence: 0 };
}

/**
 * 三色判定：基础等级 + 金额（单笔、日累计）+ 收款人（是否首次）+ 可逆性 + 频次。
 * 只读 state，不写任何字段；每条命中都带独立 rule 名与含具体数字的 detail。
 */
export function evaluate(intent: Intent, state: BankState, policy: Partial<RiskPolicy> = {}): Decision {
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
  const rules: RiskPolicy = { ...DEFAULT_RISK_POLICY, ...policy };
  const hits: Array<{ rule: string; detail: string }> = [
    { rule: "base-level", detail: `${spec.label}基础等级为${LEVEL_LABEL[spec.level]}（${spec.reversible ? "可撤销" : "不可撤销"}，${spec.irreversible === true ? "必须柜面" : "可线上办理"}）` },
  ];
  let level: "green" | "yellow" | "red" = spec.level;
  let blocked = false;

  const amount = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : 0;
  const payee = typeof intent.slots.payee === "string" ? (intent.slots.payee as string) : "";
  const isTransfer = spec.scene === "transfer";
  const now = Date.now();

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

  // 三、金额：单笔限额。
  if (isTransfer && amount > rules.singleLimitCents) {
    hits.push({
      rule: "single-limit",
      detail: `本次 ${yuan(amount)} 元，超过单笔限额 ${yuan(rules.singleLimitCents)} 元，超出 ${yuan(amount - rules.singleLimitCents)} 元`,
    });
    level = "red";
    blocked = true;
  }

  // 四、金额：日累计限额。
  if (isTransfer) {
    const since = startOfToday(now);
    const todayTotal = state.transferLog.filter((record) => record.at >= since).reduce((sum, record) => sum + record.amountCents, 0);
    if (todayTotal + amount > rules.dailyLimitCents) {
      hits.push({
        rule: "daily-limit",
        detail: `今日已转 ${yuan(todayTotal)} 元，本次 ${yuan(amount)} 元，合计 ${yuan(todayTotal + amount)} 元超过日累计限额 ${yuan(rules.dailyLimitCents)} 元`,
      });
      level = "red";
      blocked = true;
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

/** 审计记录与哈希链。 */
export interface AuditRecord {
  seq: number;
  ts: string;
  sessionId: string;
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
  private readonly records: AuditRecord[] = [];

  append(input: Omit<AuditRecord, "seq" | "ts" | "prevHash" | "hash">): AuditRecord {
    const seq = this.records.length + 1;
    const prevHash = this.records.at(-1)?.hash ?? "GENESIS";
    const payload = JSON.stringify({
      seq,
      sessionId: input.sessionId,
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
      prevHash,
      hash: createHash("sha256").update(`${prevHash}|${payload}`).digest("hex"),
    };
    this.records.push(record);
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
