/**
 * 一次请求的「身份证」：traceId。
 *
 * 为什么这东西值得单独一个文件：审计里记的是「谁在什么时候做了什么」，日志里记的是
 * 「这一次请求花了多久、走到哪一步」。两边的记录各自都对，但要回答「用户说的那句话
 * 对应审计里哪一条」时，光有时间和会话号是不够的 —— 同一个会话里一分钟能说五句话，
 * 时间戳精度一撞就分不清。traceId 是那根唯一的线。
 *
 * 传递方式用 AsyncLocalStorage 而不是「每个函数加一个参数」：
 * 加参数意味着 agent.ts 的每一个方法签名都要多一位，漏传一处就断链，而断链是静默的。
 * ALS 让调用链上任何一处（包括 await 出去的 Promise 里）都能拿到同一个值。
 *
 * 为什么放在 shared/ 而不是 track-pi/src/：shared/rules.ts 的审计链要读它，
 * 反过来 shared 依赖 track-pi 就成环了。浏览器替身见 web/src/shims/node-async-hooks.ts。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface TraceContext {
  traceId: string;
  /** 请求进门的时间（毫秒），用来算端到端耗时。 */
  startedAt: number;
  /** 进来的方法名（chat / confirm / …）。由 HTTP 层填，判定层不关心。 */
  method?: string;
  /** 身份。填了之后日志里每一行都能看出是谁在办事。 */
  userId?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * traceId 取 16 位十六进制（64 位随机）。
 *
 * 不用完整的 32 位 uuid：日志一行一个字段，32 位在终端里会把别的字段挤出去，
 * 而 64 位随机在「单进程一天几十万次请求」的尺度上碰撞概率可以忽略。
 * 网关若已生成 traceId（x-trace-id 头），直接用它的，保证跨服务是一条线。
 */
export function newTraceId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export function runWithTrace<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * 给一段异步逻辑换上下文里的身份。
 *
 * 为什么需要它：HTTP 层是按请求建上下文的，但身份是在解析令牌之后才知道的 ——
 * 那时上下文已经建好了。就地改字段比「建两层上下文」简单，也不会让内层拿到旧值。
 */
export function annotateTrace(patch: Partial<Omit<TraceContext, "traceId" | "startedAt">>): void {
  const context = storage.getStore();
  if (context === undefined) return;
  if (patch.method !== undefined) context.method = patch.method;
  if (patch.userId !== undefined) context.userId = patch.userId;
  if (patch.sessionId !== undefined) context.sessionId = patch.sessionId;
}
