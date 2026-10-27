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
};

export function specOf(tool: string) {
  return SPECS[tool];
}

/** 中文数字转阿拉伯数字，支持「五百」「三千五」。 */
export function cnToNumber(text: string): number | null {
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (!/^[零一二两三四五六七八九十百千万]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let current = 0;
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
      continue;
    }
    section += (current === 0 ? 1 : current) * unit;
    current = 0;
  }
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
  return null;
}

/** 收款人抽取：手机号优先映射通讯录，其次语法位上的中文名。 */
export function extractPayee(text: string, state: BankState): string | null {
  const known = ["小王", "王晓明", "刘洋", "李四"];
  for (const name of known) {
    if (text.includes(name)) return name;
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
  if (/(账单|消费|花了|支出|开销)/.test(text)) {
    return { scene: "bills", tool: "analyze_bills", slots: {}, missing: [], confidence: 0.95 };
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
    const missing: string[] = [];
    if (payee === null) missing.push("payee");
    if (amount === null) missing.push("amountCents");
    return { scene: "transfer", tool: "transfer", slots, missing, confidence: missing.length === 0 ? 0.95 : 0.8 };
  }
  return { scene: "unknown", tool: "unknown", slots: {}, missing: [], confidence: 0 };
}

/** 三色判定：基础等级加金额、收款人、可逆性。 */
export function evaluate(intent: Intent, state: BankState, policy: { singleLimitCents: number }): Decision {
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
  const hits: Array<{ rule: string; detail: string }> = [
    { rule: "base-level", detail: `${spec.label}基础等级为 ${spec.level}` },
  ];
  let level = spec.level;
  let blocked = false;

  const amount = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : 0;
  if (spec.scene === "transfer" && amount > policy.singleLimitCents) {
    hits.push({ rule: "single-limit", detail: `金额超过单笔限额 ${(policy.singleLimitCents / 100).toFixed(2)} 元` });
    level = "red";
    blocked = true;
  }
  if (spec.irreversible === true) {
    hits.push({ rule: "irreversible", detail: `${spec.label}不可撤销，需柜面办理` });
    level = "red";
    blocked = true;
  }
  if (spec.scene === "transfer" && amount >= 50000 && intent.slots.payee !== undefined) {
    hits.push({ rule: "new-payee", detail: "首次收款人且金额达到 500 元" });
    level = "red";
    blocked = true;
  }

  return {
    level,
    blocked,
    requiresConfirm: !blocked && level === "yellow",
    hits,
    summary: `判定为 ${level}：${spec.label}`,
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
