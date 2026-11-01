/**
 * 优雅退出：先摘流量，再等手上这几笔办完，最后才走。
 *
 * 不优雅的退出恰好停在最坏的那一刻 —— 钱已经动了、state.json 已经落盘、
 * 响应还没发出去。客户端看到超时，用户不知道这笔到底成没成。
 * 幂等键能兜住「重试别重做」，但兜不住「进程被硬切在写与回之间」。
 * 这里能做的是把硬切换成一次有时间边界的软切：
 *
 *   收到信号 → 不再接新活（新请求得 503，且说清原因）
 *            → 手上这几笔等它们办完（默认 10 秒）
 *            → 办完就退；办不完记一笔「还有 N 笔没回」再退
 *
 * 为什么不一直等下去：卡住的请求可能永远不返回（比如在等一个不响应的上游），
 * 无限等会让进程变成一个不接客也不死的僵尸。超时退出 + 幂等键 + 人工兜底，
 * 比无限等更诚实。
 */

export type ShutdownPhase = "running" | "draining" | "done";

export interface ShutdownDeps {
  /** 收尾动作：停监听、关空闲连接。退出前只调一次。 */
  close?: () => void;
  log?: (line: string) => void;
  exit?: (code: 0 | 1) => void;
  /** 等在途请求的上限。默认 10 秒，够一两笔对话往返。 */
  timeoutMs?: number;
}

export class Shutdown {
  private readonly closeFn: (() => void) | undefined;
  private readonly log: (line: string) => void;
  private readonly exitFn: (code: 0 | 1) => void;
  private readonly timeoutMs: number;

  private phase: ShutdownPhase = "running";
  /** 业务请求与探针分开计：前者是「手上还压着几笔」，后者只是「有人还在问我」。 */
  private business = 0;
  private probes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private signals = 0;

  constructor(deps: ShutdownDeps = {}) {
    this.closeFn = deps.close;
    this.log = deps.log ?? ((line) => console.log(line));
    this.exitFn = deps.exit ?? ((code) => process.exit(code));
    this.timeoutMs = Math.max(0, deps.timeoutMs ?? 10000);
  }

  get draining(): boolean {
    return this.phase !== "running";
  }

  /** 在途总数（含探针）：决定还要不要等。 */
  get inflightCount(): number {
    return this.business + this.probes;
  }

  /** 业务在途数（不含探针）：这是对外报的那个「还有几笔没办完」。 */
  get businessCount(): number {
    return this.business;
  }

  get phaseName(): ShutdownPhase {
    return this.phase;
  }

  /** 进门登记。退出中就不收了 —— 返回 false 表示这个请求不该执行。 */
  enter(): boolean {
    if (this.phase !== "running") return false;
    this.business += 1;
    return true;
  }

  /** 出门销号。归零且正在退出，就收尾。 */
  leave(): void {
    this.business = Math.max(0, this.business - 1);
    this.settleIfDrained();
  }

  /**
   * 探针登记：无条件计入在途。
   * 为什么不直接复用 enter：探针在退出中也要能访问（否则摘流量的那几秒没人看得见），
   * 但它不算业务，不该出现在「还有几笔没办完」这个数里。
   */
  track(): void {
    this.probes += 1;
  }

  untrack(): void {
    this.probes = Math.max(0, this.probes - 1);
    this.settleIfDrained();
  }

  private settleIfDrained(): void {
    if (this.phase === "draining" && this.inflightCount === 0) this.finish("在途已清空");
  }

  /**
   * 开始退出。第一次收到信号走软切，第二次不等了直接走 ——
   * 运维连按两次 Ctrl-C 的意思就是「别再等了」。
   */
  begin(signal: string): void {
    this.signals += 1;
    if (this.signals > 1) {
      this.log(`[shutdown] 再次收到 ${signal}：立即退出，仍有 ${this.inflightCount} 笔在途`);
      this.finish("强制退出", 1);
      return;
    }

    this.phase = "draining";
    this.startedAt = Date.now();
    this.log(
      `[shutdown] 收到 ${signal}：停止接新请求，等待 ${this.inflightCount} 笔在途，最多 ${Math.round(this.timeoutMs / 1000)} 秒`,
    );

    // 注意这里不停监听：先让新请求拿到 503 和原因，比直接扑空成 ECONNREFUSED 好排查；
    // 探针也要能被访问到，否则摘流量的那几秒没人看得见。真正停监听放在收尾。
    if (this.inflightCount === 0) {
      this.finish("无在途请求");
      return;
    }
    this.timer = setTimeout(() => {
      this.log(`[shutdown] 等待超时：${this.inflightCount} 笔仍未返回，先退出交给人工核对`);
      this.finish("等待超时", 1);
    }, this.timeoutMs);
  }

  private finish(reason: string, code: 0 | 1 = 0): void {
    if (this.phase === "done") return;
    this.phase = "done";
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // 停监听放在最后：前面那一小段时间里还在等服务端的探针和 503，不能提前断。
    try {
      this.closeFn?.();
    } catch (error) {
      this.log(`[shutdown] 停监听时出错：${error instanceof Error ? error.message : "未知"}`);
    }
    const cost = this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
    this.log(`[shutdown] ${reason}，用时 ${cost}ms，退出码 ${code}`);
    // 最后这几毫秒是留给最后一笔响应的：res.end() 之后数据还在 socket 缓冲里，
    // 立刻 process.exit 会把它截断 —— 客户端看到的就是「办完了但没回话」。
    setTimeout(() => this.exitFn(code), code === 0 ? 20 : 0);
  }
}
