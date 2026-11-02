import { createHash } from "node:crypto";

/**
 * 幂等日志：让「重试」变成「同一件事」，而不是「第二件事」。
 *
 * 令牌是一次性的，核销即废。这挡住了重放，但把重试的代价推给了用户：
 * 网络断了、他再点一次，系统只会说「没有待确认的操作」，答不出上一笔到底执行了没有。
 *
 * 这里补的是一条请求级记录：
 *   请求进门 → 先落一条 inflight（「我开始办了」）
 *              → 办完落 done（「办成了，结果在这里」）
 *              → 办炸了落 failed（「办砸了，原因在这里」）
 * 同一个 requestId 再来，按记录回放，绝不重做。
 *
 * 为什么 inflight 也要落盘：崩在执行中间时，这份记录是唯一能说明
 * 「这笔动过钱、但不知道动到哪一步」的东西。重启后看到 inflight，
 * 系统会说「结果未知，已转人工」，而不是闷头再执行一遍。
 */
export type IdemState = "inflight" | "done" | "failed";

export interface IdemRecord {
  key: string;
  method: string;
  sessionId: string;
  /** 参数指纹：同一个 key 换了内容，属于误用，必须拒绝而不是回放。 */
  fingerprint: string;
  state: IdemState;
  createdAt: number;
  updatedAt: number;
  reply?: unknown;
  error?: string;
}

export interface IdemSink {
  readIdempotency(): unknown;
  /**
   * 写幂等日志。merge 是可选的：给了就把「盘上已有的」与「我手上这份」合并后再写，
   * 返回合并后的快照（写方要拿它接回内存，否则下一次写又会把别人的记录抹掉）。
   */
  saveIdempotency(snapshot: unknown, merge?: (disk: unknown, mine: unknown) => unknown): unknown;
}

export type IdemLookup =
  | { kind: "miss" }
  | { kind: "replay"; reply: unknown; state: IdemState; record: IdemRecord }
  | { kind: "interrupted"; record: IdemRecord }
  | { kind: "conflict"; reason: string };

/** 请求编号：客户端生成，只允许 URL 安全字符，长度设下限防止「用 1、2、3 当键」。 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function validRequestId(raw: unknown): string | undefined {
  return typeof raw === "string" && KEY_PATTERN.test(raw) ? raw : undefined;
}

/** 指纹只取前 16 位：这里要判「是不是同一件事」，不承担防篡改职责。 */
export function fingerprintOf(method: string, sessionId: string, param: string): string {
  return createHash("sha256").update(JSON.stringify([method, sessionId, param])).digest("hex").slice(0, 16);
}

/**
 * 状态优先级：越靠前越「终」。合并时取更终的那个 ——
 * 另一个进程已经把同一笔办完了（done），我手上那条 inflight 就该让位，
 * 不然下次重试会被当成「还在办」，卡住用户的操作。
 */
const STATE_RANK: Record<IdemState, number> = { done: 3, failed: 2, inflight: 1 };

export interface IdemMergeOptions {
  ttlMs: number;
  maxEntries: number;
  now: number;
}

/**
 * 合并两份幂等快照：按请求编号取并集，**绝不丢记录**。
 *
 * 为什么这里丢一条的代价特别大：幂等记录是「这笔已经办过了」的唯一凭证。
 * 抹掉一条，同一个请求编号会被当成新请求再办一次 —— 钱扣两次，
 * 而且事后查不出来（文件好好的，只是少了一行）。
 *
 * 合并后仍按 TTL 与条数上限收拾：过期的记录留着也没用，还会让文件无限长。
 */
export function mergeIdempotencySnapshot(disk: unknown, mine: unknown, options: IdemMergeOptions): unknown {
  const merged = new Map<string, IdemRecord>();
  const take = (source: unknown): void => {
    if (source === null || typeof source !== "object") return;
    const list = (source as { records?: unknown }).records;
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Partial<IdemRecord>;
      if (typeof record.key !== "string" || record.key === "") continue;
      if (record.state !== "inflight" && record.state !== "done" && record.state !== "failed") continue;
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
      const existing = merged.get(record.key);
      if (existing === undefined) {
        merged.set(record.key, { ...(record as IdemRecord), updatedAt });
        continue;
      }
      // 同一个编号两边都有：取更终的状态；同样终就取更新的那次。
      const mineWins = STATE_RANK[record.state] > STATE_RANK[existing.state]
        || (STATE_RANK[record.state] === STATE_RANK[existing.state] && updatedAt >= existing.updatedAt);
      if (mineWins) merged.set(record.key, { ...(record as IdemRecord), updatedAt });
    }
  };
  take(disk);
  take(mine);

  const alive = [...merged.values()].filter((record) => options.now - record.updatedAt <= options.ttlMs);
  alive.sort((a, b) => a.updatedAt - b.updatedAt);
  const kept = alive.slice(Math.max(0, alive.length - options.maxEntries));
  return { version: 1, records: kept };
}

export class IdempotencyLog {
  private readonly sink: IdemSink | undefined;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly records = new Map<string, IdemRecord>();

  constructor(sink: IdemSink | undefined, options: { ttlSeconds?: number; maxEntries?: number } = {}) {
    this.sink = sink;
    this.ttlMs = Math.max(1, options.ttlSeconds ?? 1800) * 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
    this.restore();
  }

  get size(): number {
    return this.records.size;
  }

  get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }

  /**
   * 复原：逐字段校验，坏记录整条丢掉。
   * 这里不做「尽量救回来」—— 一条半坏的记录会让系统误以为某笔请求已经办过。
   */
  private restore(): void {
    const raw = this.sink?.readIdempotency() ?? null;
    if (raw === null || typeof raw !== "object") return;
    const list = (raw as { records?: unknown }).records;
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const candidate = item as Partial<IdemRecord>;
      if (typeof candidate.key !== "string" || !KEY_PATTERN.test(candidate.key)) continue;
      if (typeof candidate.method !== "string" || typeof candidate.sessionId !== "string") continue;
      if (typeof candidate.fingerprint !== "string" || typeof candidate.createdAt !== "number") continue;
      if (candidate.state !== "inflight" && candidate.state !== "done" && candidate.state !== "failed") continue;
      const updatedAt = typeof candidate.updatedAt === "number" ? candidate.updatedAt : candidate.createdAt;
      if (now - updatedAt > this.ttlMs) continue;
      this.records.set(candidate.key, { ...(candidate as IdemRecord), updatedAt });
    }
    this.prune();
  }

  /** 查一条：先看是不是同一件事，再看办到哪一步了。 */
  lookup(key: string, method: string, sessionId: string, fingerprint: string): IdemLookup {
    const record = this.records.get(key);
    if (record === undefined) return { kind: "miss" };
    if (record.method !== method || record.sessionId !== sessionId) {
      return { kind: "conflict", reason: "这个请求编号已经被另一笔操作用过" };
    }
    if (record.fingerprint !== fingerprint) {
      return { kind: "conflict", reason: "同一个请求编号被用在了不同的内容上" };
    }
    if (record.state === "inflight") return { kind: "interrupted", record };
    return { kind: "replay", reply: record.reply, state: record.state, record };
  }

  begin(key: string, method: string, sessionId: string, fingerprint: string): void {
    const now = Date.now();
    this.records.set(key, { key, method, sessionId, fingerprint, state: "inflight", createdAt: now, updatedAt: now });
    this.save();
  }

  finish(key: string, reply: unknown): void {
    this.settle(key, "done", { reply });
  }

  fail(key: string, error: string, reply?: unknown): void {
    this.settle(key, "failed", reply === undefined ? { error } : { error, reply });
  }

  private settle(key: string, state: IdemState, patch: { reply?: unknown; error?: string }): void {
    const record = this.records.get(key);
    if (record === undefined) return;
    record.state = state;
    record.updatedAt = Date.now();
    if (patch.reply !== undefined) record.reply = patch.reply;
    if (patch.error !== undefined) record.error = patch.error;
    this.save();
  }

  private save(): void {
    if (this.sink === undefined) return;
    this.prune();
    const snapshot = { version: 1, records: [...this.records.values()] };
    /**
     * 写完把合并结果接回内存：别的进程办完的那笔，我这边也得知道它办完了。
     * 不接回的话，我下一次写会用自己那份（缺那条的）覆盖掉盘上刚合进去的 ——
     * 合并就白做了，而且丢的恰恰是幂等记录这种不能丢的东西。
     */
    const merged = this.sink.saveIdempotency(snapshot, (disk, mine) =>
      mergeIdempotencySnapshot(disk, mine, { ttlMs: this.ttlMs, maxEntries: this.maxEntries, now: Date.now() }));
    this.adopt(merged);
  }

  /** 接回合并后的记录：逐条校验，坏记录丢掉（和 restore 同一把尺子）。 */
  private adopt(merged: unknown): void {
    if (merged === null || typeof merged !== "object") return;
    const list = (merged as { records?: unknown }).records;
    if (!Array.isArray(list)) return;
    const now = Date.now();
    for (const item of list) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Partial<IdemRecord>;
      if (typeof record.key !== "string" || !KEY_PATTERN.test(record.key)) continue;
      if (typeof record.method !== "string" || typeof record.sessionId !== "string") continue;
      if (typeof record.fingerprint !== "string" || typeof record.createdAt !== "number") continue;
      if (record.state !== "inflight" && record.state !== "done" && record.state !== "failed") continue;
      const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : record.createdAt;
      if (now - updatedAt > this.ttlMs) continue;
      this.records.set(record.key, { ...(record as IdemRecord), updatedAt });
    }
    this.prune();
  }

  /** 先按时间淘汰，再按条数淘汰：条数上限是给「批量重放」留的保险。 */
  private prune(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (now - record.updatedAt > this.ttlMs) this.records.delete(key);
    }
    if (this.records.size <= this.maxEntries) return;
    const ordered = [...this.records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of ordered.slice(0, this.records.size - this.maxEntries)) this.records.delete(record.key);
  }
}
