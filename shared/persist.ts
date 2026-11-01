import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { BankState, Holding, StateSeed } from "./state.ts";
import { initialState } from "./state.ts";

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
const HANDOFF_FILE = "handoff.json";

export class FileStore implements AuditSink {
  readonly dir: string;
  /**
   * 这个目录属于谁 —— 只有「没写过状态文件」时才用得上。
   * 首次开户要按人给不同的初始余额，否则四个客户打开都是林知远那 38,642.50。
   */
  private readonly seed: StateSeed | undefined;

  constructor(dir: string, seed?: StateSeed) {
    this.dir = path.resolve(dir);
    this.seed = seed;
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 按客户切一个独立目录。
   *
   * 为什么不在每个方法上多加一个 userId 参数：那要改 Agent 里所有 store 调用点，
   * 还得让每个实现都记得带。切目录之后 `saveState(state)` 的签名一个字都不用动，
   * 而隔离性由「拿到的目录不同」保证 —— 越权要先拿到别人的 store 实例，拿不到。
   */
  forUser(userId: string, seed?: StateSeed): FileStore {
    return new FileStore(path.join(this.dir, "users", userId), seed);
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

  /**
   * 装载状态，把三种情况分开报 —— 这三者在业务上完全不是一回事：
   *
   *   fresh   目录里没有状态文件：全新安装，从初始值开始是对的。
   *   disk    读回来并校验通过。
   *   corrupt 文件在，但读不出来：这不是「没有」，是「有，但坏了」。
   *
   * 上一版把后两种都当成 null，于是「文件被手改坏」和「全新安装」长得一模一样：
   * 都是初始余额，都照常开门。银行口径下前者意味着全部账目口径失效，
   * 必须停住让人看，不能拿初始余额冒充用户的钱。
   */
  loadState(): StateLoad {
    const file = this.pathOf(STATE_FILE);
    if (!existsSync(file)) return { kind: "fresh", state: this.seed === undefined ? initialState() : initialState(Date.now(), this.seed) };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      return { kind: "corrupt", reason: `不是合法 JSON：${error instanceof Error ? error.message : "解析失败"}` };
    }
    const checked = checkState(raw);
    if (!checked.ok) return { kind: "corrupt", reason: checked.reason };
    return { kind: "disk", state: checked.state };
  }

  readState(): BankState | null {
    const loaded = this.loadState();
    return loaded.kind === "corrupt" ? null : loaded.state;
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

  /**
   * 转人工工单：和状态一样整份原子覆盖。
   * 工单量级远小于审计（未结案的不许淘汰、已结案的按上限清），整份重写够用。
   */
  saveHandoffs(snapshot: unknown): void {
    this.writeJson(HANDOFF_FILE, snapshot);
  }

  readHandoffs(): unknown {
    return this.readJson(HANDOFF_FILE);
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

export type StateLoad =
  | { kind: "fresh"; state: BankState }
  | { kind: "disk"; state: BankState }
  | { kind: "corrupt"; reason: string };

export type StateCheck = { ok: true; state: BankState } | { ok: false; reason: string };

/**
 * 状态校验：这份数据能不能拿去判钱。
 *
 * 和上一版的区别是返回具体原因，不再只是一个 null —— 启动被拒的时候，
 * 日志里得说清是哪一项不对，否则运维只能靠猜。
 *
 * 校验的分寸：**缺字段可以补，有字段但值不对就停**。
 * 老版本写的 state.json 里没有 collections / birthdayGifts，也没有持仓的三个新字段，
 * 这些要补默认值放行；但「余额是字符串」「余额是 3.7 分」这种不是版本差异，是数据坏了。
 */
export function checkState(raw: unknown): StateCheck {
  if (raw === null || typeof raw !== "object") return { ok: false, reason: "顶层不是对象" };
  const input = raw as Partial<BankState>;

  const account = input.account;
  if (account === undefined) return { ok: false, reason: "缺少 account" };
  const balance = account.balance;
  const available = account.available;
  if (typeof balance !== "number") return { ok: false, reason: "account.balance 不是数字" };
  if (typeof available !== "number") return { ok: false, reason: "account.available 不是数字" };
  // 金额只用整数分，这是全项目的口径。出现小数或 NaN 说明不是本程序写的。
  if (!Number.isInteger(balance)) return { ok: false, reason: `account.balance 不是整数分（${balance}）` };
  if (!Number.isInteger(available)) return { ok: false, reason: `account.available 不是整数分（${available}）` };
  if (balance < 0) return { ok: false, reason: `account.balance 为负（${balance}）` };
  // available = balance - 预锁金额，所以它永远不该大于 balance。反了就是账错了。
  if (available > balance) {
    return { ok: false, reason: `account.available（${available}）大于 balance（${balance}）` };
  }

  const arrays: Array<[string, unknown]> = [
    ["contacts", input.contacts],
    ["transferLog", input.transferLog],
    ["cards", input.cards],
    ["subscriptions", input.subscriptions],
    ["holdings", input.holdings],
    ["bills", input.bills],
    ["lockedFunds", input.lockedFunds],
    ["scheduledTransfers", input.scheduledTransfers],
    ["wealthProducts", input.wealthProducts],
  ];
  for (const [name, value] of arrays) {
    if (!Array.isArray(value)) return { ok: false, reason: `${name} 不是数组` };
  }
  if (input.customer === undefined) return { ok: false, reason: "缺少 customer" };

  // 新增字段要给旧文件留后路：上一版写的 state.json 里没有这两个数组，
  // 直接 undefined 下去，第一次 unshift 就会炸 —— 而那刚好发生在用户点了「发起」之后。
  const collections = Array.isArray(input.collections) ? input.collections : [];
  const birthdayGifts = Array.isArray(input.birthdayGifts) ? input.birthdayGifts : [];
  // 持仓在 v1.6.2 之前只有 id / productId / amountCents 三个字段。老文件读回来若直接
  // 用，`accruedMilliCents` 是 undefined，第一次参与加法就变 NaN —— 而 NaN 往下传是无声的：
  // 判钱时不报错，只在展示时变成一个 "NaN 元"。所以这里逐字段补齐，缺的按「刚买入、零收益」算。
  const revivedAt = Date.now();
  const holdings = (input.holdings as unknown[]).map((item) => {
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
    ok: true,
    state: {
      account,
      cards: input.cards as BankState["cards"],
      subscriptions: input.subscriptions as BankState["subscriptions"],
      holdings,
      lockedFunds: input.lockedFunds as BankState["lockedFunds"],
      contacts: input.contacts as BankState["contacts"],
      transferLog: input.transferLog as BankState["transferLog"],
      bills: input.bills as BankState["bills"],
      wealthProducts: input.wealthProducts as BankState["wealthProducts"],
      customer,
      scheduledTransfers: input.scheduledTransfers as BankState["scheduledTransfers"],
      collections,
      birthdayGifts,
    },
  };
}

/** 旧接口：只要状态，不要原因。调用方用它表示「读不出来就当没有」。 */
export function reviveState(raw: unknown): BankState | null {
  const result = checkState(raw);
  return result.ok ? result.state : null;
}
