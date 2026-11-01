import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { BankState, Holding } from "./state.ts";

/**
 * 落盘：只做四件事 —— 追加一行、读回所有行、原子写整个 JSON、读回 JSON。
 * 不做缓存、不做重试、不猜格式：写失败就抛，读失败就当没有。
 *
 * 为什么审计用追加写 JSONL 而不是一个 JSON 数组：
 * 数组每次都要重写整个文件，写到一半断电就是全毁；追加写最多毁最后一行，前面每条都还在。
 * 每写一行都 fsync，是因为「进程崩了但数据还在」和「操作系统缓存没落盘」是两件事，
 * 审计链要防的恰恰是后者。
 */
export interface AuditSink {
  append(record: unknown): void;
}

export interface ReadResult {
  /** 成功解析出来的记录，按写入顺序。 */
  rows: unknown[];
  /** 解析不了的行数：断电截断会留下半行，这里如实计数而不是悄悄丢掉。 */
  corrupt: number;
}

const AUDIT_FILE = "audit.jsonl";
const STATE_FILE = "state.json";
const SESSION_FILE = "sessions.json";
const IDEM_FILE = "idempotency.json";

export class FileStore implements AuditSink {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private pathOf(name: string): string {
    return path.join(this.dir, name);
  }

  /** 追加一行并 fsync：返回后这一行已经不在操作系统缓存里。 */
  private appendLine(name: string, value: unknown): void {
    const line = `${JSON.stringify(value)}\n`;
    const fd = openSync(this.pathOf(name), "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private readLines(name: string): ReadResult {
    const file = this.pathOf(name);
    if (!existsSync(file)) return { rows: [], corrupt: 0 };
    const text = readFileSync(file, "utf8");
    const rows: unknown[] = [];
    let corrupt = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line) as unknown);
      } catch {
        corrupt += 1;
      }
    }
    return { rows, corrupt };
  }

  /** 原子写：先写临时文件再 rename，读到的永远是完整的旧版或完整的新版。 */
  private writeJson(name: string, value: unknown): void {
    const target = this.pathOf(name);
    const temp = `${target}.tmp`;
    const body = JSON.stringify(value);
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  }

  private readJson(name: string): unknown {
    const file = this.pathOf(name);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      // 坏文件不删除：留着给人看，运行时按「没有」处理。
      return null;
    }
  }

  // ------------------------------------------------------------ AuditSink

  append(record: unknown): void {
    this.appendLine(AUDIT_FILE, record);
  }

  readAudit(): ReadResult {
    return this.readLines(AUDIT_FILE);
  }

  /** 清空审计（演示专用，不进正常流程）。 */
  dropAudit(): void {
    const file = this.pathOf(AUDIT_FILE);
    if (existsSync(file)) unlinkSync(file);
  }

  /**
   * 探针用：这个目录还能不能写。
   *
   * 只 open 一个空文件就关，不写内容也不删 —— 探针十秒一次，不能每次都落盘。
   * 为什么不用 access(W_OK)：它在 Windows 上只判只读属性，磁盘满、句柄被占、
   * 目录被删都照样报可写，正好漏掉真正会让「写盘失败」的那几种。
   */
  checkWritable(): { ok: boolean; error?: string } {
    try {
      closeSync(openSync(this.pathOf(".writable-probe"), "a"));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "写入失败" };
    }
  }

  // ------------------------------------------------------------ 状态与会话

  saveState(state: BankState): void {
    this.writeJson(STATE_FILE, state);
  }

  readState(): BankState | null {
    return reviveState(this.readJson(STATE_FILE));
  }

  saveSessions(snapshot: unknown): void {
    this.writeJson(SESSION_FILE, snapshot);
  }

  readSessions(): unknown {
    return this.readJson(SESSION_FILE);
  }

  /** 幂等日志：写法和状态一样是整份原子覆盖，条目有限（带 TTL 与条数上限）。 */
  saveIdempotency(snapshot: unknown): void {
    this.writeJson(IDEM_FILE, snapshot);
  }

  readIdempotency(): unknown {
    return this.readJson(IDEM_FILE);
  }

  info(): { dir: string; auditBytes: number; hasState: boolean; hasSessions: boolean } {
    const size = (name: string): number => {
      const file = this.pathOf(name);
      return existsSync(file) ? readFileSync(file).byteLength : 0;
    };
    return {
      dir: this.dir,
      auditBytes: size(AUDIT_FILE),
      hasState: existsSync(this.pathOf(STATE_FILE)),
      hasSessions: existsSync(this.pathOf(SESSION_FILE)),
    };
  }
}

/**
 * 状态复原：文件可能是上一个版本写的、也可能是手改坏的，所以逐字段校验。
 * 校验不通过就整份丢掉回到初始状态 —— 拿半份状态去判钱，比从头开始更危险。
 */
export function reviveState(raw: unknown): BankState | null {
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as Partial<BankState>;
  const account = input.account;
  if (account === undefined || typeof account.balance !== "number" || typeof account.available !== "number") return null;
  if (!Array.isArray(input.contacts) || !Array.isArray(input.transferLog) || !Array.isArray(input.cards)) return null;
  if (!Array.isArray(input.subscriptions) || !Array.isArray(input.holdings) || !Array.isArray(input.bills)) return null;
  if (!Array.isArray(input.lockedFunds) || !Array.isArray(input.scheduledTransfers)) return null;
  if (!Array.isArray(input.wealthProducts) || input.customer === undefined) return null;
  // 新增字段要给旧文件留后路：上一版写的 state.json 里没有这两个数组，
  // 直接 undefined 下去，第一次 unshift 就会炸 —— 而那刚好发生在用户点了「发起」之后。
  const collections = Array.isArray(input.collections) ? input.collections : [];
  const birthdayGifts = Array.isArray(input.birthdayGifts) ? input.birthdayGifts : [];
  // 持仓在 v1.6.2 之前只有 id / productId / amountCents 三个字段。老文件读回来若直接
  // 用，`accruedMilliCents` 是 undefined，第一次参与加法就变 NaN —— 而 NaN 往下传是无声的：
  // 判钱时不报错，只在展示时变成一个 "NaN 元"。所以这里逐字段补齐，缺的按「刚买入、零收益」算。
  const revivedAt = Date.now();
  const holdings = input.holdings.map((item) => {
    const raw = (item ?? {}) as Partial<Holding>;
    return {
      id: typeof raw.id === "string" ? raw.id : "",
      productId: typeof raw.productId === "string" ? raw.productId : "",
      amountCents: typeof raw.amountCents === "number" ? raw.amountCents : 0,
      boughtAt: typeof raw.boughtAt === "number" ? raw.boughtAt : revivedAt,
      accruedMilliCents: typeof raw.accruedMilliCents === "number" ? raw.accruedMilliCents : 0,
      lastAccruedAt: typeof raw.lastAccruedAt === "number" ? raw.lastAccruedAt : revivedAt,
    };
  });
  const customer = {
    ...input.customer,
    spouseBirthday: typeof input.customer.spouseBirthday === "string" ? input.customer.spouseBirthday : "11-15",
  };
  return {
    account,
    cards: input.cards,
    subscriptions: input.subscriptions,
    holdings,
    lockedFunds: input.lockedFunds,
    contacts: input.contacts,
    transferLog: input.transferLog,
    bills: input.bills,
    wealthProducts: input.wealthProducts,
    customer,
    scheduledTransfers: input.scheduledTransfers,
    collections,
    birthdayGifts,
  };
}
