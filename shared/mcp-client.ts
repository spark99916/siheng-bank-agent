import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 外部服务客户端：stdio 上的 JSON-RPC，只做三件事。
 * 一、把调用发出去；二、把返回当数据收回来；三、超时就当失败，绝不阻塞主流程。
 * 外部返回一律不进系统提示词，只作为工具结果参与拼装。
 */
export interface McpServerConfig {
  command: string;
  args: string[];
  /** 单次调用超时，毫秒。超时按失败处理并重启子进程。 */
  timeoutMs: number;
}

export interface McpCallResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

interface Waiter {
  resolve: (value: McpCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class McpClient {
  private readonly label: string;
  private readonly config: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private seq = 0;
  private readonly waiters = new Map<number, Waiter>();

  constructor(label: string, config: McpServerConfig) {
    this.label = label;
    this.config = config;
  }

  get name(): string {
    return this.label;
  }

  info(): { name: string; running: boolean; timeoutMs: number } {
    return { name: this.label, running: this.child !== null, timeoutMs: this.config.timeoutMs };
  }

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child !== null) return this.child;
    try {
      const child = spawn(this.config.command, this.config.args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onData(chunk));
      child.on("error", () => this.reset());
      child.on("exit", () => this.reset());
      // 子进程被杀之后，下一次写 stdin 会抛 EPIPE。这是流上的 error 事件，
      // 不接就是未捕获异常，会把整个服务带走 —— 外部服务挂掉不该连累内置业务，所以接住它。
      child.stdin.on("error", () => this.reset());
      this.child = child;
      // 握手：服务端会回一条 initialize，这里不等它，失败由首次调用的超时兜住。
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
      return child;
    } catch {
      this.child = null;
      return null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      if (line === "") continue;
      let message: { id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const waiter = this.waiters.get(message.id);
      if (waiter === undefined) continue;
      this.waiters.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) {
        waiter.resolve({ ok: false, error: message.error.message ?? "external_error" });
        continue;
      }
      const block = message.result?.content?.[0];
      const text = typeof block?.text === "string" ? block.text : "";
      if (message.result?.isError === true) {
        waiter.resolve({ ok: false, error: text === "" ? "external_error" : text });
        continue;
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        waiter.resolve({
          ok: true,
          data: parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed },
        });
      } catch {
        // 外部服务返回的不是 JSON：当数据存原文，不做任何解释。
        waiter.resolve({ ok: true, data: { text } });
      }
    }
  }

  private reset(): void {
    this.child = null;
    this.buffer = "";
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, error: "external_unavailable" });
    }
    this.waiters.clear();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const child = this.ensure();
    if (child === null) return { ok: false, error: "external_unavailable" };
    const id = (this.seq += 1);
    return await new Promise<McpCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        // 超时说明这条链路已经不可信，杀掉重连，别让下一次调用继续堵着。
        child.kill();
        this.reset();
        resolve({ ok: false, error: "external_timeout" });
      }, this.config.timeoutMs);
      this.waiters.set(id, { resolve, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } })}\n`);
      } catch {
        clearTimeout(timer);
        this.waiters.delete(id);
        resolve({ ok: false, error: "external_write_failed" });
      }
    });
  }

  close(): void {
    this.child?.kill();
    this.reset();
  }
}
