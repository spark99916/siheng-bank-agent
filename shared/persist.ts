import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BankState, Holding, StateSeed } from "./state.ts";
import { initialState } from "./state.ts";

/**
 * 写者标识：进程号在 Node 上用来区分两个实例；浏览器里没有 process，
 * 离线引擎是单线程页面、不存在第二个写者，用常量占位即可。
 * 直接写 `process.pid` 会在模块加载后第一次写盘时才炸（ReferenceError），
 * 而且炸的位置在「用户点了转账」之后 —— 画面上的表现是「点了没反应」。
 */
const writerId: string = typeof process !== "undefined" && typeof (process as { pid?: unknown }).pid === "number" ? String(process.pid) : "browser";

/**
 * 账本写冲突：盘上的版本和手上这份对不上。
 *
 * 这不是「出错了」，是「有人在你看不见的时候记了一笔账」。
 * 必须让它显形 —— 整份覆盖的写法会把别人的那笔抹掉，而抹掉这件事本身不留任何痕迹，
 * 事后只能从余额对不上反推，对不上时又说不清是哪一笔。
 */
export class StateConflictError extends Error {
  readonly code = "STATE_CONFLICT";
  /** 盘上此刻的版本。 */
  readonly diskRevision: number;
  /** 手上这份账是基于哪个版本改的。 */
  readonly baseRevision: number;
  readonly reason: "stale" | "busy";

  constructor(diskRevision: number, baseRevision: number, reason: "stale" | "busy") {
    super(
      reason === "busy"
        ? `账本正被另一个写者占用，本次没有写盘（盘上第 ${diskRevision} 版）`
        : `账本已被改过：盘上是第 ${diskRevision} 版，手上这份基于第 ${baseRevision} 版`,
    );
    this.name = "StateConflictError";
    this.diskRevision = diskRevision;
    this.baseRevision = baseRevision;
    this.reason = reason;
  }
}

/**
 * 临界区里唯一的等待手段：同步 sleep，不阻塞事件循环之外的任何东西。
 *
 * 只能用在有 SharedArrayBuffer 的环境（Node）。浏览器里 file:// 没有
 * 跨域隔离头，Chrome 不给 SharedArrayBuffer，**在模块顶层 new 一个会直接抛**，
 * 整个存储模块加载失败，页面引擎起不来 —— v1.18.1 上线当天两个本地页面全白，就是它。
 * 所以这里必须探测：浏览器是单线程页面，写锁永远一次抢到，park 根本不会被调用，
 * 退化成「不等待」在那边是安全的，不是假实现。
 */
const park: (ms: number) => void = (() => {
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    return (ms: number) => {
      Atomics.wait(view, 0, 0, ms);
    };
  } catch {
    return () => {};
  }
})();

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

  /**
   * 原子写：先写临时文件再 rename，读到的永远是完整的旧版或完整的新版。
   *
   * 临时文件名必须每次都不一样。原先固定用 `state.json.tmp`，两个进程同时写时
   * B 会把 A 正在写的那个文件清空重写，A rename 走的可能是 B 的半截内容 ——
   * 结果是 state.json 变成一段解析不了的 JSON，而两边都以为自己写成功了。
   * 带上 pid 与随机后缀之后，各写各的，rename 只决定「谁最后落地」，不会把文件写坏。
   */
  private writeJson(name: string, value: unknown): void {
    const target = this.pathOf(name);
    const temp = `${target}.${writerId}.${randomUUID().slice(0, 8)}.tmp`;
    const body = JSON.stringify(value);
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, target);
    } catch (error) {
      // rename 失败别把临时文件留在盘上，否则下次清理还得靠人。
      try {
        unlinkSync(temp);
      } catch {
        /* 已经没了就算了 */
      }
      throw error;
    }
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

  /**
   * 反方向也要堵死：写盘期间不许别人插进来读版本。
   *
   * 版本比对本身是「读版本 → 比 → 写」，这三步之间只要有缝隙，
   * 两个写者就能同时通过比对然后一前一后各写一次 —— 比对做了，账照样丢。
   * 所以比对和写盘必须在这把锁里面，锁用 O_EXCL 建文件实现（建目录也行，
   * 但文件能顺手写下持有者是谁，事后排查知道是谁卡住的）。
   *
   * 只阻塞毫秒级：临界区就是一次 writeSync + 一次 rename。
   * 抢不到先自旋一会儿，实在抢不到就报 busy 交给上层，绝不死等。
   */
  private lock<T>(fn: () => T, waitMs = 300): T {
    const lockPath = this.pathOf(".state.lock");
    const deadline = Date.now() + waitMs;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // 上一任写者崩在临界区里，锁文件会永远留着。超过阈值就当僵尸清掉，
        // 否则一次崩溃会把这份账永久锁死 —— 那比丢一笔账还严重。
        try {
          const stat = statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 10_000) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* 对方刚好释放了，重试即可 */
        }
        if (Date.now() >= deadline) {
          throw new StateConflictError(this.diskRevision() ?? 0, 0, "busy");
        }
        park(2);
        continue;
      }
      try {
        writeSync(fd, `${writerId}\n`);
        return fn();
      } finally {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          /* 已经被僵尸清理逻辑收走了 */
        }
      }
    }
  }

  /** 盘上此刻的版本；没有文件或解析不出来返回 null（表示「没有可比对的版本」）。 */
  private diskRevision(): number | null {
    const file = this.pathOf(STATE_FILE);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { revision?: unknown };
      return typeof raw.revision === "number" && Number.isInteger(raw.revision) ? raw.revision : 0;
    } catch {
      // 文件在但读不出来：这份盘不可信，没有「版本」可言，交给写的一方形做决定。
      return null;
    }
  }

  /**
   * 写账本：先比版本，再写。
   *
   * 签名一个字没变 —— 调用方还是 `saveState(state)`，只是这个 state 上多了
   * 一个它自己不一定在意的 `revision`。版本对不上就抛，不静默覆盖。
   * 抛出去之后内存和盘就不一致了，所以上层必须接住并处理（见 Agent.persistState）。
   */
  saveState(state: BankState): void {
    this.lock(() => {
      const disk = this.diskRevision();
      if (disk !== null && disk !== state.revision) {
        throw new StateConflictError(disk, state.revision, "stale");
      }
      state.revision += 1;
      this.writeJson(STATE_FILE, state);
    });
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
  // 版本号是 v1.19.0 才有的。老盘没有这个字段，按第 0 版算 —— 这不是数据坏了，
  // 是「这份账从来没被这个版本写过」。当成坏文件停住的话，所有历史演示数据都读不进来。
  const revision =
    typeof (input as { revision?: unknown }).revision === "number" && Number.isInteger((input as { revision: number }).revision)
      ? (input as { revision: number }).revision
      : 0;
  return {
    ok: true,
    state: {
      revision,
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
