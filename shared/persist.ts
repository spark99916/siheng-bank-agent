import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BankState, Holding, StateSeed } from "./state.ts";
import { initialState } from "./state.ts";
import { checkIntegrity, digestOf } from "./integrity.ts";
import { RejectionLog } from "./rejections.ts";

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
  /** 争的是哪一份文件：账本、会话快照、幂等日志还是工单簿。 */
  readonly scope: string;

  constructor(diskRevision: number, baseRevision: number, reason: "stale" | "busy", scope = "账本") {
    super(
      reason === "busy"
        ? `${scope}正被另一个写者占用，本次没有写盘（盘上第 ${diskRevision} 版）`
        : `${scope}已被改过：盘上是第 ${diskRevision} 版，手上这份基于第 ${baseRevision} 版`,
    );
    this.name = "StateConflictError";
    this.diskRevision = diskRevision;
    this.baseRevision = baseRevision;
    this.reason = reason;
    this.scope = scope;
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
 * 锁的持有者身份。
 *
 * 锁文件里写的是「谁拿着这把锁」，不是一个空文件。为什么要记身份：
 * 释放锁靠的是「把锁文件挪走」，万一挪不动（权限、别的进程占着），
 * 下一个写者要能分清「这份锁是别人正经持有的」和「这是我自己上一笔留下的残骸」。
 * 前者要等，后者可以直接接管 —— 不等的话就是自己把自己锁死。
 *
 * 格式：`进程号#实例序号`。
 *
 * 为什么要带实例序号：光有进程号不够 —— 同一个进程里可以有好几个 FileStore
 * 实例（一个用户目录一个），它们的进程号一样。只比进程号的话，
 * 实例 A 会把实例 B 正持有的锁当成「自己的残骸」抢走，两个写者同时落盘。
 * 加上序号才能分清「同一个实例的残骸」（能接管）和「别的实例正持有」（要等）。
 *
 * 浏览器里的离线引擎没有 process，用常量占位；它单线程、不会并发写。
 */
const writerId: string = typeof process !== "undefined" && typeof (process as { pid?: unknown }).pid === "number" ? String((process as { pid: number }).pid) : "browser";

/** 实例序号：这个进程里第几个 FileStore。全局递增，各实例不同。 */
let instanceSeq = 0;

/**
 * 这个进程号还活着吗？判不了就返回 null（意思是「不知道」）。
 *
 * 只发 0 号信号问一声「在不在」，不真杀。EPERM 是「有这个人但我管不着」
 * —— 仍然算活着；ESRCH 才是真的没了。
 *
 * 注意 Windows 上没有 init 进程，pid 1 也是「不在」，
 * 所以别拿「pid 很小」当活着的证据 —— 一律问操作系统。
 */
function processAlive(pid: number): boolean | null {
  if (typeof process === "undefined" || typeof process.kill !== "function") return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 锁文件里的持有者是谁？读不出来就当「不知道」—— 不知道时只能靠时间判断。 */
function lockOwner(raw: string): { pid: number | null; tag: string } {
  const text = raw.trim();
  const hash = text.indexOf("#");
  const pidText = hash >= 0 ? text.slice(0, hash) : text;
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
  return { pid, tag: text };
}

/**
 * 本进程当前正握着的锁路径。
 *
 * 用来识别「重入」：临界区里又去抢同一把锁，说明代码写错了。
 * 这种情况下绝不能「抢自己的锁」蒙混过去 —— 那会让两个写者同时落盘。
 * 识别出来之后按「别人持有」处理：等、等不到就报错，让问题显形。
 */
const heldLocks = new Set<string>();

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

/**
 * 审计链的链头锚点。
 *
 * **为什么要有它**：哈希链只能查出「中间被改过」，查不出「尾部被整行删掉」——
 * 删掉最后几条之后，剩下的记录依然首尾相连，链校验照样通过。
 * 后果是：那几笔记录从盘上消失，没有任何痕迹表明它们曾经存在过，
 * 而钱可能已经扣了。
 *
 * **怎么解决**：把链头的三个值（序号、哈希、总条数）另写一个文件。
 * 删审计尾巴的人如果忘了这个文件，启动时就能发现；
 * 忘了改第二个文件，正是本地文件系统上最常见的那种疏漏。
 *
 * **它挡不住什么**：挡不住有写权限的人同时改审计和锚点、把整条链重算一遍。
 * 本项目不声称能防住那种人 —— 那需要签名密钥或外部锚定。
 * 这里要防的是意外截断、误删、以及部分篡改。
 */
export interface AuditHead {
  /** 链头记录的序号。 */
  seq: number;
  /** 链头记录的哈希。 */
  hash: string;
  /** 链上总条数。 */
  count: number;
}

const AUDIT_FILE = "audit.jsonl";
const AUDIT_HEAD_FILE = "audit.head";
const STATE_FILE = "state.json";
const SESSION_FILE = "sessions.json";
const IDEM_FILE = "idempotency.json";
const HANDOFF_FILE = "handoff.json";

/**
 * 合并函数：把「盘上已有的」和「我手上这份」合成一份不丢东西的快照。
 *
 * 纯函数，不碰磁盘 —— 这样每条合并规则都能单独打脸，不用起进程。
 */
export type LedgerMerge = (disk: unknown, mine: unknown) => unknown;

export class FileStore implements AuditSink {
  readonly dir: string;
  /**
   * 这个目录属于谁 —— 只有「没写过状态文件」时才用得上。
   * 首次开户要按人给不同的初始余额，否则四个客户打开都是林知远那 38,642.50。
   */
  private readonly seed: StateSeed | undefined;
  /**
   * 这个实例的锁身份：`进程号#实例序号`。
   *
   * 带实例序号是必须的：同一个进程里可以有多个 FileStore（每个用户目录一个），
   * 它们进程号相同。只比进程号的话，实例 A 会把实例 B 正持有的锁
   * 当成「自己的残骸」抢走 —— 两个写者同时落盘，钱就没了。
   *
   * 公开出来是为了能写进日志与测试：排查「谁卡住了」时要看的就是这个值。
   */
  readonly lockTag: string;

  /**
   * 丢弃留证：这一轮里被丢掉的数据条目。
   *
   * 为什么挂在 store 上而不是各自 new 一个：
   * 合并函数是纯函数（不碰磁盘），它们把丢弃的条目交给调用方；
   * 而「留证文件写到哪、health 报多少」这些是**存储层的事** ——
   * 合并函数写盘就破坏了纯函数的可测性。
   *
   * 一个实例贯穿整条链路，读→合并→留证→上报都看同一个计数器，
   * 运维看到的数字才对得上。
   */
  readonly rejections = new RejectionLog();

  constructor(dir: string, seed?: StateSeed, parent?: FileStore) {
    this.dir = path.resolve(dir);
    this.seed = seed;
    this.parent = parent;
    instanceSeq += 1;
    this.lockTag = `${writerId}#${instanceSeq}`;
    mkdirSync(this.dir, { recursive: true });
    // 客户目录挂到根 store 上：根 store 才有「全局视角」。
    // 不用一个静态集合装所有实例 —— 那会无界增长（每 forUser 一次多一个），
    // 而测试里更明显：历史 store 的计数会污染后来用例的读数。
    parent?.children.set(this.dir, this);
  }

  /** 上级 store：客户目录 store 的上级是根 store。 */
  private readonly parent: FileStore | undefined;

  /** 这个 store 直接持有的子 store（按目录索引）。 */
  private readonly children = new Map<string, FileStore>();

  /**
   * 汇总本 store 及其所有子 store 的丢弃计数。
   *
   * 为什么需要汇总：审计链是**全局单链**（根目录），而会话、幂等、工单是
   * **按客户分目录**的。丢弃计数分散在各个实例上，
   * 只报根 store 的计数就等于漏掉了所有客户账上的丢弃 ——
   * 而恰恰是客户账上的幂等记录最要紧（丢一条，钱可能扣两次）。
   */
  rejectionCounts(): Record<string, number> {
    const total = new Map<string, number>();
    const walk = (instance: FileStore): void => {
      for (const [scope, count] of Object.entries(instance.rejections.counts())) {
        total.set(scope, (total.get(scope) ?? 0) + count);
      }
      for (const child of instance.children.values()) walk(child);
    };
    walk(this);
    return Object.fromEntries(total);
  }

  /**
   * 按客户切一个独立目录。
   *
   * 为什么不在每个方法上多加一个 userId 参数：那要改 Agent 里所有 store 调用点，
   * 还得让每个实现都记得带。切目录之后 `saveState(state)` 的签名一个字都不用动，
   * 而隔离性由「拿到的目录不同」保证 —— 越权要先拿到别人的 store 实例，拿不到。
   */
  forUser(userId: string, seed?: StateSeed): FileStore {
    return new FileStore(path.join(this.dir, "users", userId), seed, this);
  }

  /**
   * 把文件名解析成完整路径。
   *
   * 公开是为了能被测试直接打脸 —— 这道防御挡的是「传了绝对路径被拼错」，
   * 而拼错时报的 EPERM 完全看不出真实原因。
   */
  pathOf(name: string): string {
    /**
     * 绝对路径直接拒绝。
     *
     * 为什么：`path.join(dir, "C:\\a\\b")` 在 Windows 上会拼成 `dir\C:\a\b` ——
     * 路径看起来还是那么回事，实际上指向一个不存在的目录，写盘时报 EPERM，
     * 而错误信息里那个怪路径让人完全想不到是「传了绝对路径」。
     *
     * 统一在这里拦：所有写盘的地方都走 pathOf，一处拦就够。
     * 报「请传文件名」比报 EPERM 有用得多。
     */
    if (path.isAbsolute(name)) {
      throw new Error(`落盘只接受文件名，收到绝对路径：${name}`);
    }
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
    this.refreshAuditHead();
  }

  readAudit(): ReadResult {
    return this.readLines(AUDIT_FILE);
  }

  /**
   * 读链头锚点。读不出来（文件不存在或坏了）返回 null ——
   * 「没有锚点」和「锚点坏了」在下一步的处理上是一样的：都不据此判死，
   * 而是把盘上实际的链头重新写成锚点。
   */
  readAuditHead(): AuditHead | null {
    const file = this.pathOf(AUDIT_HEAD_FILE);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AuditHead>;
      if (typeof raw.seq !== "number" || typeof raw.hash !== "string" || typeof raw.count !== "number") return null;
      return { seq: raw.seq, hash: raw.hash, count: raw.count };
    } catch {
      return null;
    }
  }

  /**
   * 重写链头锚点：以盘上审计文件的实际内容为准。
   *
   * 什么时候写：追加一条审计记录之后。
   * 为什么每次追加都写而不是攒着写：锚点的作用是「记住链头长什么样」，
   * 攒着写就等于给它留了一段「已知不准」的时间窗 —— 那段时间里删尾巴查不出来。
   *
   * 为什么以盘上实际内容为准而不是以内存里的为准：盘上才是发生过的事实。
   * 内存里那条可能还没落盘（写失败了），拿它当锚点就等于记了一个不存在的链头。
   */
  private refreshAuditHead(): void {
    const rows = this.readLines(AUDIT_FILE).rows as Array<{ seq?: unknown; hash?: unknown }>;
    const last = rows.at(-1);
    const head: AuditHead = {
      seq: typeof last?.seq === "number" ? last.seq : 0,
      hash: typeof last?.hash === "string" ? last.hash : "GENESIS",
      count: rows.length,
    };
    this.writeJson(AUDIT_HEAD_FILE, head);
  }

  /** 清空审计（演示专用，不进正常流程）。锚点一起清 —— 否则会以为链被截断。 */
  dropAudit(): void {
    const file = this.pathOf(AUDIT_FILE);
    if (existsSync(file)) unlinkSync(file);
    const head = this.pathOf(AUDIT_HEAD_FILE);
    if (existsSync(head)) unlinkSync(head);
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
  private lock<T>(fn: () => T, waitMs = 300, scope = "账本"): T {
    const lockPath = this.pathOf(".state.lock");
    const deadline = Date.now() + waitMs;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        /**
         * 锁在这儿，但「谁拿着」有三种可能，处理方式不一样：
         *
         *  1. 持有者还活着 —— 那就是真有人在写，等它（这是正常的并发）。
         *  2. 持有者已经没了（崩在临界区里）—— 僵尸锁，接管。
         *  3. 持有者就是我自己 —— **上一次写盘的锁没释放干净**。
         *     这一支是 v1.19.0 补的：原来释放锁只靠「删文件」，删不掉（权限、
         *     安全策略拦删除、文件被占）就静默失败，锁文件永远留在盘上。
         *     于是之后每一次写盘都撞 EEXIST，自旋 300ms 后报 busy，
         *     用户看到的是「账本正被另一个进程写入」—— 而根本没有别的进程。
         *     自己留下的残骸直接接管，不能等。
         */
        if (this.reclaimLock(lockPath)) {
          // 接管成功就重试抢锁；但也不能无限重试 —— 接管没真把锁清掉的话，
          // 这里会变成活锁（永远抢不到、永远不超时）。所以每次接管后都看一眼期限。
          if (Date.now() >= deadline) {
            throw new StateConflictError(this.diskRevision() ?? 0, 0, "busy", scope);
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new StateConflictError(this.diskRevision() ?? 0, 0, "busy", scope);
        }
        park(2);
        continue;
      }
      try {
        writeSync(fd, `${this.lockTag}\n`);
        heldLocks.add(lockPath);
        return fn();
      } finally {
        heldLocks.delete(lockPath);
        closeSync(fd);
        /**
         * 释放锁：**删不掉就改名挪走**。
         *
         * 为什么不能只删：删文件这一步会失败，而且失败往往是环境决定的
         * （目录权限、安全策略拦批量删除、文件被别的进程占着）。
         * 一旦删不掉而这里又把错误吞掉，锁就永远留在盘上 —— 账从此写不进去，
         * 而表面上只是一句「有别的进程在写」。改名不依赖删除权限，
         * 挪走之后原路径立刻空出来，下一个写者照样抢得到锁。
         *
         * 挪走用的是固定名（.state.lock.released），不是每次一个新名：
         * 固定名会被下一次覆盖，所以这个目录里最多多一个文件，不会越攒越多。
         * 它是残留证据，不是锁 —— 抢锁看的是 .state.lock 在不在。
         */
        this.releaseLock(lockPath);
      }
    }
  }

  /**
   * 释放锁：优先删；删不掉就改名挪走，让原路径空出来。
   *
   * 挪不动（连改名都被拒）就只能留着 —— 但下一次写盘会通过 reclaimLock
   * 认出「这是我自己留下的残骸」而接管，所以不会真的锁死。
   */
  private releaseLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
      return;
    } catch {
      /* 删不掉就改名挪走 */
    }
    try {
      renameSync(lockPath, `${lockPath}.released`);
    } catch {
      /* 挪不动就留着：下一次写盘自愈（见 reclaimLock） */
    }
  }

  /**
   * 这把锁能不能接管？返回 true 表示「已经清理干净，可以重试抢锁」。
   *
   * 三种情况，只有前两种能接管：
   *  1. 持有者就是我自己这个实例 —— 上一笔没释放干净的残骸。直接接管。
   *  2. 持有者的进程已经不在了 —— 崩在临界区里的僵尸锁。接管。
   *  3. 持有者还活着 —— 那是真并发，不能抢，返回 false 让上层去等。
   *
   * 认不出来（锁文件读不出来、内容不是进程号）时退回老办法：
   * 按修改时间判断，超过十秒当僵尸清掉。宁可多等十秒，
   * 也不能把别人正经持有的锁抢过来 —— 抢错了就是两笔账互相覆盖。
   *
   * 还有两种不能抢：
   *  - 本进程自己正握着这把锁（重入）。临界区里不该再抢同一把锁，
   *    但真发生了也不能靠「抢自己的锁」蒙混过去 —— 那会让两个写者同时落盘。
   *    按「别人持有」处理：等、等不到就报错，让问题显形。
   *  - 同一个进程里的**另一个** FileStore 实例正握着它。
   *    进程号一样但实例序号不同 —— 那是真并发（两个用户目录各写各的，
   *    但共享这台机器上的写锁纪律），必须等。
   */
  private reclaimLock(lockPath: string): boolean {
    if (heldLocks.has(lockPath)) return false;
    let raw = "";
    let mtimeMs = 0;
    try {
      raw = readFileSync(lockPath, "utf8");
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      /* 读不出来：对方刚好释放了，重试即可 */
      return true;
    }
    const owner = lockOwner(raw);
    if (owner.tag === this.lockTag) {
      // 自己这个实例上一笔留下的残骸：接管。
      return this.discardLock(lockPath);
    }
    if (owner.pid !== null) {
      const alive = processAlive(owner.pid);
      if (alive === true) return false; // 真有人在写，等
      if (alive === false) {
        // 持有者已经没了：僵尸锁，接管。
        return this.discardLock(lockPath);
      }
    }
    // 认不出持有者：按时间兜底。
    if (Date.now() - mtimeMs > 10_000) {
      return this.discardLock(lockPath);
    }
    return false;
  }

  /**
   * 把一份锁彻底清掉：挪走优先，挪不动才删。
   *
   * 两手都要有：改名挪走不依赖删除权限，删除是最后的办法
   * （挪不动的常见原因是文件被占着，而被占着的文件恰恰删不掉）。
   *
   * 返回「真的清掉了没有」—— 清不掉就必须如实说 false，
   * 否则调用方会以为清干净了而无限重试，变成活锁。
   */
  private discardLock(lockPath: string): boolean {
    try {
      renameSync(lockPath, `${lockPath}.stale`);
      return !existsSync(lockPath);
    } catch {
      /* 挪不动就试删 */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* 真的清不掉 */
    }
    return !existsSync(lockPath);
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
      /**
       * 状态自摘要：算的是「去掉 integrity 字段之后」的账目正文。
       *
       * 为什么要自摘要而不是拿审计链做对账：审计记录里没有结构化的金额字段
       * （金额混在 result 自然语言里），从自然语言反解金额去做对账不可靠 ——
       * 解错一次就误报，而误报会让人不再相信这个信号。
       * 自摘要不需要解析任何东西，**改一个字节就一定对不上**。
       *
       * 它挡不住「改完账本后重算摘要」的有心人（没有密钥就做不到），
       * 但它挡得住绝大多数真实场景：手滑改错、脚本批量改、编辑器误存、
       * 拷贝了另一份 state.json 过来。
       */
      const body = { ...state } as Record<string, unknown>;
      delete body.integrity;
      this.writeJson(STATE_FILE, { ...body, integrity: { algo: "sha256", digest: digestOf(body) } });
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
    /**
     * 摘要校验放在结构校验之前。
     *
     * 为什么这个顺序：摘要回答的是「这份文件在落盘之后被动过没有」，
     * 结构校验回答的是「这份数据能不能用」。一份被手改过的 state.json
     * 可能结构完全合法（余额改成另一个整数分，available 也跟着改），
     * 只查结构的话会当成好数据放行 —— 而余额正是最该被保护的东西。
     *
     * 「没有摘要」不算坏：老版本写的盘没有这个字段，按「没被保护过」处理，
     * 不判死（详见 shared/integrity.ts 的说明）。
     */
    const integrity = checkIntegrity(raw);
    if (integrity.kind === "mismatch") {
      return {
        kind: "corrupt",
        reason: `自摘要对不上：这份状态在落盘之后被改过（盘上摘要 ${integrity.actual.slice(0, 12)}…，重算得到 ${integrity.expected.slice(0, 12)}…）`,
      };
    }
    const checked = checkState(raw);
    if (!checked.ok) return { kind: "corrupt", reason: checked.reason };
    return { kind: "disk", state: checked.state };
  }

  readState(): BankState | null {
    const loaded = this.loadState();
    return loaded.kind === "corrupt" ? null : loaded.state;
  }

  saveSessions(snapshot: unknown, merge?: LedgerMerge): unknown {
    return this.saveLedger(SESSION_FILE, snapshot, merge, "会话快照");
  }

  readSessions(): unknown {
    return this.readJson(SESSION_FILE);
  }

  /** 幂等日志：写法和状态一样是整份原子覆盖，条目有限（带 TTL 与条数上限）。 */
  saveIdempotency(snapshot: unknown, merge?: LedgerMerge): unknown {
    return this.saveLedger(IDEM_FILE, snapshot, merge, "幂等日志");
  }

  readIdempotency(): unknown {
    return this.readJson(IDEM_FILE);
  }

  /**
   * 转人工工单：和状态一样整份原子覆盖。
   * 工单量级远小于审计（未结案的不许淘汰、已结案的按上限清），整份重写够用。
   */
  saveHandoffs(snapshot: unknown, merge?: LedgerMerge): unknown {
    return this.saveLedger(HANDOFF_FILE, snapshot, merge, "工单簿");
  }

  readHandoffs(): unknown {
    return this.readJson(HANDOFF_FILE);
  }

  /**
   * 把丢弃的条目写进留证文件。
   *
   * **为什么必须留证**：合并结果会覆盖原文件。丢掉一条就是永久丢掉 ——
   * 事后没人说得清「这里本来有没有东西」。
   *
   * **为什么是追加写而不是覆盖**：一次运行里可能丢弃多批（每次合并一批），
   * 覆盖写会把前面几批的证据抹掉，只留最后一批。
   *
   * **文件名带序号**：同一秒内可能丢弃两批，用序号区分开。
   * 序号用「这个目录里已经留了几份证」来算 —— 不用时间戳，
   * 因为时间戳在快速连续写入时会撞。
   */
  preserveRejected(scope: string): void {
    const entries = this.rejections.list().filter((entry) => entry.scope === scope);
    if (entries.length === 0) return;
    // 传**文件名**而不是绝对路径：writeJson 会自己拼目录，
    // 传绝对路径会被再拼一遍（path.join 遇到绝对路径不会丢弃前面的部分）。
    const file = `.rejected-${scope}-${this.rejectedSeq++}.json`;
    this.writeJson(file, { scope, at: new Date().toISOString(), count: entries.length, entries });
  }

  /** 留证文件的序号：同一个目录里第几份。 */
  private rejectedSeq = 0;

  /**
   * 登记簿式写入：加锁 → 读盘 → 合并 → 原子替换。
   *
   * 为什么账本之外的三个文件也要走这条路：它们以前是「整份覆盖」——
   * 两个写者各写各的，后写的把先写的那份整个抹掉，而且**不留任何痕迹**
   * （不像账本丢账会表现为余额对不上，抹掉一条幂等记录是查不出来的：
   * 同一个请求编号会第二次被当成新请求，钱再扣一次）。
   *
   * 合并规则不放在这一层：TTL 归幂等日志管、状态机归工单板管、草稿语义归会话管。
   * 这里只提供机制 —— 读到什么、怎么合，由数据的主人用 merge 函数说清楚。
   *
   * 返回合并后的快照：写方必须把它接回内存，否则下一次写又会用自己那份
   * 覆盖掉刚合进来的别人的记录 —— 那等于合并白做。
   */
  private saveLedger(name: string, snapshot: unknown, merge: LedgerMerge | undefined, scope: string): unknown {
    let merged: unknown = snapshot;
    this.lock(() => {
      const file = this.pathOf(name);
      let disk: unknown = null;
      if (existsSync(file)) {
        try {
          disk = JSON.parse(readFileSync(file, "utf8")) as unknown;
        } catch {
          /**
           * 坏文件不删也不直接覆盖：旁存一份留证（.bad-时间戳），再写新档。
           * 删掉就永远查不到「这里本来有一份东西」；覆盖掉就是把现场毁了。
           */
          this.preserveBad(file);
          disk = null;
        }
      }
      merged = merge === undefined ? snapshot : merge(disk, snapshot);
      this.writeJson(name, merged);
    }, 300, scope);
    return merged;
  }

  /** 坏文件旁存：改个名留在原地旁边，人来看得见，不丢证据。 */
  private preserveBad(file: string): void {
    try {
      renameSync(file, `${file}.bad-${Date.now()}`);
    } catch {
      /* 旁存失败也不能挡住正常写入 */
    }
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
