/**
 * 转人工工单：把「已转人工核对」从一句文案变成一张可追踪、可结案的工单。
 *
 * 为什么需要它 —— 在此之前，系统崩在执行中间只能说一句「已转人工核对」，
 * 后面没有任何东西：谁接了、查到哪一步、结论是什么、用户的钱最后怎么着。
 * 那句文案安抚了用户，却没有把责任落下来。
 *
 * 这个模块只做三件事，每件都做成**开单时的硬校验**而不是事后统计 ——
 * 指标写在 PPT 上没人监督，写成卡口才会被遵守：
 *
 *   ① 交接包完整率 100%
 *      十四个字段缺一个就开不出单，抛 HandoffRejected。不是警告，是拒绝。
 *      理由很实在：缺幂等编号的工单，人工会在后台办一次、用户在前端再点一次。
 *      缺审计序号的工单，人工查不到这件事在链上的位置，等于从头问一遍。
 *
 *   ② 处置结果回写率 100%
 *      open 与 close 一一对应：关闭必须能找到开单记录，重复关闭拒绝；
 *      超时未处置的由 sweep 结案，resolution 记 no-action 并写明「未处置」，
 *      不假装办完了。没结案的工单永不淘汰 —— 结案的可以清，悬着的不能删。
 *
 *   ③ 误转率
 *      这条必须诚实：系统**算不出**误转率，那要人工标注「这单到底该不该转」。
 *      系统能做的是准入条件 —— 每条转人工原因绑定一个必须成立的前提，
 *      不成立就开不出单。于是「不该转的路径根本产生不了工单」，
 *      剩下的误转（该转的判断本身错了）只能靠抽样复核。
 */

export type HandoffReason =
  /** 钱可能已经动了：执行中断、状态未知。P0，按分钟计。 */
  | "suspended-funds"
  /** 钱没动，但线上办不了：不可撤销、必须柜面。 */
  | "manual-only"
  /** 钱没动，材料不足：补了材料重走一遍规则，不是特批放行。 */
  | "evidence-gap"
  /** 钱没动，能力不足：意图没听懂、多步计划失败。可以降级重问，不必转。 */
  | "capability";

export type HandoffState = "open" | "claimed" | "closed";

/** 处置结论。no-action 专给超时自动结案用，含义是「没人处置过」。 */
export type HandoffResolution = "released" | "confirmed" | "rejected" | "no-action";

export interface HandoffPacket {
  /** 工单号：H-日期-序号。单实例顺序号；多副本要换全局发号器，见文档边界。 */
  id: string;
  createdAt: number;
  reason: HandoffReason;
  sessionId: string;
  actor: string;
  /** 用户原话，一字不改 —— 人工要判断有没有误解，就得看原话。 */
  rawText: string;
  intent: { tool: string; slots: Record<string, unknown>; slotOrigin: Record<string, string> };
  decision: { level: string; rules: string[]; summary: string };
  executed: { done: boolean; action: string };
  /** 幂等编号。suspended-funds 必备：没有它，人工和用户会各办一次。 */
  requestId: string | null;
  /** 审计位置，人工据此在链上定位。 */
  audit: { seq: number; hash: string };
  /** 悬着多少钱。null 表示不知道 —— 崩溃场景里这是常态，不许写成 0。 */
  suspendedCents: number | null;
  /** 给人工的建议动作：不是让他重想，是让他确认这几项。 */
  advice: string;
  /** 会话入口，能点进去接着聊。 */
  entry: string;
}

export interface HandoffTicket {
  packet: HandoffPacket;
  state: HandoffState;
  claimedBy?: string;
  closedAt?: number;
  resolution?: HandoffResolution;
  note?: string;
}

export interface HandoffSink {
  readHandoffs(): unknown;
  /** 写工单簿。merge 给了就先与盘上那份合并再写，返回合并后的快照。 */
  saveHandoffs(snapshot: unknown, merge?: (disk: unknown, mine: unknown) => unknown): unknown;
}

/** 开单被拒：不是异常路径，是设计路径。调用方必须把拒绝原因落到审计里。 */
export class HandoffRejected extends Error {
  readonly missing: string[];
  readonly reason: HandoffReason | "unknown";
  constructor(message: string, missing: string[] = [], reason: HandoffReason | "unknown" = "unknown") {
    super(message);
    this.name = "HandoffRejected";
    this.missing = missing;
    this.reason = reason;
  }
}

/**
 * 交接包必填项。约定：字符串非空、对象存在、数值可是 0 但不能是 NaN。
 *
 * id 与 createdAt 不在这里 —— 它们是系统开的单号和开单时刻，不该由调用方编。
 * 校验的是「接单的人能不能不问你一句话就把事办下去」这件事需要的字段。
 */
const TEXT_FIELDS: Array<keyof HandoffPacket> = ["sessionId", "actor", "rawText", "advice", "entry"];

/**
 * 缺字段检查。requestId 与 suspendedCents 允许为 null，但必须有这个键 ——
 * 「没填」和「明确写了不知道」是两件事，后者是允许的，前者是事故。
 */
export function missingPacketFields(packet: Partial<HandoffPacket>): string[] {
  const missing: string[] = [];
  for (const key of TEXT_FIELDS) {
    const value = packet[key];
    if (typeof value !== "string" || value.trim() === "") missing.push(String(key));
  }
  if (!(packet.requestId === null || typeof packet.requestId === "string")) missing.push("requestId");
  if (!(packet.suspendedCents === null || typeof packet.suspendedCents === "number")) missing.push("suspendedCents");
  const intent = packet.intent;
  if (intent === undefined || typeof intent.tool !== "string" || intent.tool === "") missing.push("intent.tool");
  if (intent?.slots === undefined || typeof intent.slots !== "object") missing.push("intent.slots");
  if (intent?.slotOrigin === undefined || typeof intent.slotOrigin !== "object") missing.push("intent.slotOrigin");
  const decision = packet.decision;
  if (decision === undefined || typeof decision.level !== "string" || !Array.isArray(decision.rules)) missing.push("decision");
  if (packet.executed === undefined || typeof packet.executed.action !== "string") missing.push("executed");
  const audit = packet.audit;
  if (audit === undefined || typeof audit.seq !== "number" || typeof audit.hash !== "string") missing.push("audit");
  return missing;
}

/** 准入上下文：用来判断这条「转人工」是不是真该转。 */
export interface OpenContext {
  /** 幂等记录状态。inflight = 上次办到一半断了，钱可能已经动过。 */
  idemState?: "inflight" | "done" | "failed";
  /** 工具画像里的不可撤销标记（必须柜面那类）。 */
  irreversible?: boolean;
  /** 本次判定命中的规则名。 */
  rules: string[];
  /** 判定等级。 */
  level: string;
}

const REASONS: HandoffReason[] = ["suspended-funds", "manual-only", "evidence-gap", "capability"];

/**
 * 准入条件：每种原因都必须有一个前提成立，否则开不出单。
 *
 * 这张表就是「防误转」的机器表达 —— 把「不该转」的路径挡在开单之前，
 * 而不是等运营事后统计误转率。表里每条都可被单测逐条打脸。
 */
export function admitReason(reason: HandoffReason, packet: Partial<HandoffPacket>, ctx: OpenContext): string | null {
  switch (reason) {
    case "suspended-funds":
      if (ctx.idemState !== "inflight") return "只有幂等记录停在 inflight 时才算「钱可能已经动了」";
      if (typeof packet.requestId !== "string") return "执行中断必须有幂等编号，否则人工与用户会各办一次";
      return null;
    case "manual-only":
      if (ctx.irreversible !== true) return "工具并非不可撤销，线上可办，不该占用人工";
      return null;
    case "evidence-gap":
      if (!ctx.rules.some((rule) => rule.includes("evidence"))) return "没有命中证据不足类规则，不属于补材料场景";
      if (ctx.idemState === "inflight") return "钱可能已经动了，先对账再谈材料";
      return null;
    case "capability":
      if (ctx.idemState === "inflight") return "有悬空资金时不允许按能力不足转出，必须先对账";
      return null;
    default:
      return "未知的转人工原因";
  }
}

/** 工单状态推进表：只允许往前走，跳过或回退都拒。 */
const NEXT: Record<HandoffState, HandoffState[]> = {
  open: ["claimed", "closed"],
  claimed: ["closed"],
  closed: [],
};

/**
 * 状态优先级：工单状态机只往前走，合并时取更靠前的那个。
 * 别人已经结案的单，我手上那份「还开着」就该让位 —— 否则用户看到的是
 * 「还挂着」，而客服那边其实已经办完了，两边对不上。
 */
const STATE_RANK: Record<HandoffState, number> = { closed: 3, claimed: 2, open: 1 };

/**
 * 合并两份工单快照：按工单号取并集，**未结案的永不丢**。
 *
 * 丢一张未结工单，等于把一件没处理完的事从账上抹掉：用户等着，钱悬着，
 * 而系统里查不到这张单 —— 那正是「回写率 100%」这个承诺最怕的事。
 */
export function mergeHandoffSnapshot(disk: unknown, mine: unknown, options: { limit: number }): unknown {
  const merged = new Map<string, HandoffTicket>();
  const take = (source: unknown): void => {
    if (source === null || typeof source !== "object") return;
    const list = (source as { tickets?: unknown }).tickets;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const ticket = item as Partial<HandoffTicket>;
      const packet = ticket.packet;
      if (packet === undefined || missingPacketFields(packet).length > 0) continue;
      if (ticket.state !== "open" && ticket.state !== "claimed" && ticket.state !== "closed") continue;
      if (!REASONS.includes(packet.reason)) continue;
      const existing = merged.get(packet.id);
      if (existing === undefined) {
        merged.set(packet.id, ticket as HandoffTicket);
        continue;
      }
      const mineWins = STATE_RANK[ticket.state] > STATE_RANK[existing.state]
        || (STATE_RANK[ticket.state] === STATE_RANK[existing.state]
          && (ticket.closedAt ?? 0) >= (existing.closedAt ?? 0)
          && (ticket.packet.createdAt ?? 0) >= (existing.packet.createdAt ?? 0));
      if (mineWins) merged.set(packet.id, ticket as HandoffTicket);
    }
  };
  take(disk);
  take(mine);

  const all = [...merged.values()];
  const unclosed = all.filter((ticket) => ticket.state !== "closed");
  const closed = all
    .filter((ticket) => ticket.state === "closed")
    .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  const room = Math.max(0, options.limit - unclosed.length);
  // 已结案的按上限清，未结案的一张都不清。
  return { version: 1, tickets: [...unclosed, ...closed.slice(Math.max(0, closed.length - room))] };
}

export interface HandoffMetrics {
  opened: number;
  closed: number;
  autoClosed: number;
  pending: number;
  rejectedOpens: number;
  /** 完整率：开单尝试里通过必填校验的比例。卡口生效时应为 100%。 */
  packetCompleteRate: number;
  /** 回写率：已结案 / 已开单。卡口生效时应为 100%（含超时结案）。 */
  writeBackRate: number;
  /**
   * 误转率：**不在这里算**。系统不知道「这单该不该转」，那要人工标注。
   * 这里只报「按原因分布」，让抽样复核有的放矢。
   */
  byReason: Record<string, number>;
}

export class HandoffBoard {
  private readonly sink: HandoffSink | undefined;
  private readonly tickets = new Map<string, HandoffTicket>();
  private readonly limit: number;
  private readonly timeoutMs: number;
  private seq = 0;
  private rejectedOpens = 0;

  constructor(sink: HandoffSink | undefined, options: { limit?: number; timeoutSeconds?: number } = {}) {
    this.sink = sink;
    this.limit = Math.max(1, options.limit ?? 500);
    this.timeoutMs = Math.max(1, options.timeoutSeconds ?? 7200) * 1000;
    this.restore();
  }

  get size(): number {
    return this.tickets.size;
  }

  get pending(): number {
    return [...this.tickets.values()].filter((ticket) => ticket.state !== "closed").length;
  }

  /**
   * 复原：逐字段校验，坏记录整条丢。
   * 与幂等日志同一立场 —— 一条半坏的工单比没有更危险：它会让人以为已经有人接了。
   */
  private restore(): void {
    const raw = this.sink?.readHandoffs() ?? null;
    if (raw === null || typeof raw !== "object") return;
    const list = (raw as { tickets?: unknown }).tickets;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const candidate = item as Partial<HandoffTicket>;
      const packet = candidate.packet;
      if (packet === undefined || missingPacketFields(packet).length > 0) continue;
      if (candidate.state !== "open" && candidate.state !== "claimed" && candidate.state !== "closed") continue;
      if (!REASONS.includes(packet.reason)) continue;
      this.tickets.set(packet.id, candidate as HandoffTicket);
      const serial = Number(String(packet.id).split("-").at(-1));
      if (Number.isFinite(serial) && serial > this.seq) this.seq = serial;
    }
  }

  private save(): void {
    if (this.sink === undefined) return;
    this.prune();
    const snapshot = { version: 1, tickets: [...this.tickets.values()] };
    /**
     * 合并后接回内存：别的进程开的单、别的客服结的案，我这边都得知道。
     * 不接回的话，我下一次写会用自己那份覆盖掉刚合进去的 —— 未结工单就这么丢了。
     */
    const merged = this.sink.saveHandoffs(snapshot, (disk, mine) => mergeHandoffSnapshot(disk, mine, { limit: this.limit }));
    this.adopt(merged);
  }

  /** 接回合并后的工单：逐字段校验，坏单整条丢（和 restore 同一把尺子）。 */
  private adopt(merged: unknown): void {
    if (merged === null || typeof merged !== "object") return;
    const list = (merged as { tickets?: unknown }).tickets;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const ticket = item as Partial<HandoffTicket>;
      const packet = ticket.packet;
      if (packet === undefined || missingPacketFields(packet).length > 0) continue;
      if (ticket.state !== "open" && ticket.state !== "claimed" && ticket.state !== "closed") continue;
      if (!REASONS.includes(packet.reason)) continue;
      this.tickets.set(packet.id, ticket as HandoffTicket);
    }
    this.prune();
  }

  /**
   * 淘汰只看已结案的，按结案时间从旧到新。
   * 没结案的工单一律不删 —— 删掉一张未结工单，等于把一件没处理完的事从账上抹掉。
   */
  private prune(): void {
    if (this.tickets.size <= this.limit) return;
    const closed = [...this.tickets.values()]
      .filter((ticket) => ticket.state === "closed")
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
    for (const ticket of closed.slice(0, this.tickets.size - this.limit)) this.tickets.delete(ticket.packet.id);
  }

  private nextId(now: number): string {
    this.seq += 1;
    const day = new Date(now);
    const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, "0")}${String(day.getDate()).padStart(2, "0")}`;
    return `H-${stamp}-${String(this.seq).padStart(4, "0")}`;
  }

  /**
   * 开单。两步校验，任一不过就抛 HandoffRejected：
   *   ① 交接包完整（十四个字段）
   *   ② 这条原因的前提成立（准入条件）
   * 抛之前把 rejectedOpens 记上 —— 拒绝次数本身是「误转被挡住多少次」的读数。
   */
  open(packet: Partial<HandoffPacket>, ctx: OpenContext): HandoffTicket {
    const now = typeof packet.createdAt === "number" && Number.isFinite(packet.createdAt) ? packet.createdAt : Date.now();
    const prepared: Partial<HandoffPacket> = {
      ...packet,
      createdAt: now,
      id: typeof packet.id === "string" && packet.id !== "" ? packet.id : this.nextId(now),
    };

    const missing = missingPacketFields(prepared);
    if (missing.length > 0) {
      this.rejectedOpens += 1;
      throw new HandoffRejected(`交接包缺 ${missing.length} 项：${missing.join("、")}`, missing, packet.reason ?? "unknown");
    }

    const reason = prepared.reason as HandoffReason;
    const blocked = admitReason(reason, prepared, ctx);
    if (blocked !== null) {
      this.rejectedOpens += 1;
      throw new HandoffRejected(blocked, [], reason);
    }

    const filled = prepared as HandoffPacket;
    const ticket: HandoffTicket = { packet: filled, state: "open" };
    this.tickets.set(filled.id, ticket);
    this.save();
    return ticket;
  }

  claim(id: string, by: string): HandoffTicket {
    const ticket = this.require(id);
    if (!NEXT[ticket.state].includes("claimed")) {
      throw new HandoffRejected(`工单 ${id} 处于 ${ticket.state}，不能再认领`, [], ticket.packet.reason);
    }
    ticket.state = "claimed";
    ticket.claimedBy = by;
    this.save();
    return ticket;
  }

  /**
   * 结案 —— 「回写」的落点。三条硬校验：
   *   ① 工单必须存在（找不到就是没开过，不能凭空回写）
   *   ② 未结案才能结（重复结案会让回写率虚高）
   *   ③ 结论必须在白名单里（不写「已处理」这种含糊话）
   */
  close(id: string, resolution: HandoffResolution, note: string, by?: string): HandoffTicket {
    const ticket = this.require(id);
    if (!NEXT[ticket.state].includes("closed")) {
      throw new HandoffRejected(`工单 ${id} 已经结案（${ticket.resolution ?? "未知"}），不能重复回写`, [], ticket.packet.reason);
    }
    if (!["released", "confirmed", "rejected", "no-action"].includes(resolution)) {
      throw new HandoffRejected(`未知的处置结论：${String(resolution)}`, [], ticket.packet.reason);
    }
    ticket.state = "closed";
    ticket.closedAt = Date.now();
    ticket.resolution = resolution;
    ticket.note = note;
    if (by !== undefined) ticket.claimedBy = by;
    this.save();
    return ticket;
  }

  /**
   * 超时结案。跑在调度器里，把搁置太久的工单收掉。
   *
   * 为什么必须收：一张永远 open 的工单会让「回写率」永远是 60%，指标失去意义；
   * 但它不能被算成「已处置」—— 结论记 no-action，备注写明没人碰过。
   * 假装办完了比不办更坏。
   */
  sweep(now = Date.now()): HandoffTicket[] {
    const closed: HandoffTicket[] = [];
    for (const ticket of this.tickets.values()) {
      if (ticket.state === "closed") continue;
      if (now - ticket.packet.createdAt < this.timeoutMs) continue;
      ticket.state = "closed";
      ticket.closedAt = now;
      ticket.resolution = "no-action";
      ticket.note = `超过 ${Math.round(this.timeoutMs / 60000)} 分钟无人处置，超时自动结案；这笔业务仍需人工跟进`;
      closed.push(ticket);
    }
    if (closed.length > 0) this.save();
    return closed;
  }

  get(id: string): HandoffTicket | undefined {
    return this.tickets.get(id);
  }

  list(options: { state?: HandoffState; sessionId?: string; limit?: number } = {}): HandoffTicket[] {
    const rows = [...this.tickets.values()]
      .filter((ticket) => (options.state === undefined ? true : ticket.state === options.state))
      .filter((ticket) => (options.sessionId === undefined ? true : ticket.packet.sessionId === options.sessionId))
      .sort((a, b) => b.packet.createdAt - a.packet.createdAt);
    return rows.slice(0, options.limit ?? 20);
  }

  private require(id: string): HandoffTicket {
    const ticket = this.tickets.get(id);
    if (ticket === undefined) throw new HandoffRejected(`找不到工单 ${id}`, [], "unknown");
    return ticket;
  }

  /**
   * 读数。前两项是卡口自证的，第三项故意不给单一数字 ——
   * 系统算不出误转率，硬算一个出来就是自欺。
   */
  metrics(): HandoffMetrics {
    const all = [...this.tickets.values()];
    const closed = all.filter((ticket) => ticket.state === "closed");
    const autoClosed = closed.filter((ticket) => ticket.resolution === "no-action").length;
    const attempts = all.length + this.rejectedOpens;
    const byReason: Record<string, number> = {};
    for (const ticket of all) byReason[ticket.packet.reason] = (byReason[ticket.packet.reason] ?? 0) + 1;
    return {
      opened: all.length,
      closed: closed.length,
      autoClosed,
      pending: all.length - closed.length,
      rejectedOpens: this.rejectedOpens,
      packetCompleteRate: attempts === 0 ? 1 : Number((all.length / attempts).toFixed(4)),
      writeBackRate: all.length === 0 ? 1 : Number((closed.length / all.length).toFixed(4)),
      byReason,
    };
  }
}
