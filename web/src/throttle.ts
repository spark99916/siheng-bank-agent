/**
 * 限流退避：客户端这一侧。
 *
 * 服务端按 HTTP 标准回 `429` + `retry-after` 头。以前客户端把这个直接渲染成
 * 红色「请求失败」—— 但它不是失败，是「等一下再来」。现场连点几下就撞上，
 * 演示当场翻车，而且红字会让人误以为被风控拦了。
 *
 * 为什么重发是安全的：限流发生在**建 Agent 之前**（认证 → 限流 → 建 Agent），
 * 被拦下的请求没碰磁盘、没动账、没写审计，重发就是把同一件事从头做一遍。
 * 而且重发复用同一组参数、同一个 requestId，幂等编号照旧。
 *
 * 为什么是单一真源：业务界面走 vite 打包，演示站走 esbuild 注入，
 * 两边手写两份实现一定会漂 —— 所以这份逻辑只写一遍，两边都用它。
 */

/** 429 之后最多再试几次。总请求数 = 1 + 这个数。 */
export const THROTTLE_MAX_RETRIES = 2;

/** 等多久的兜底：服务端没给 `retry-after`、或给的不是数字时用这个。 */
export const THROTTLE_DEFAULT_WAIT_MS = 1000;

/** 等多久的上限：再久也不该把页面按死。 */
export const THROTTLE_MAX_WAIT_MS = 5000;

/** 只要有 `get` 就够 —— 浏览器 `Headers` 与 Node `Headers` 都满足。 */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * 这是「限流」而不是「失败」。
 *
 * 带 `throttled` 标记而不是只靠 `instanceof`：演示站与业务界面各打包一份，
 * 跨副本时 `instanceof` 会失效，标记位才靠得住。
 */
export class ThrottledError extends Error {
  readonly throttled = true;
  readonly retryAfterMs: number;
  readonly status: number;

  constructor(message: string, retryAfterMs: number, status = 429) {
    super(message);
    this.name = "ThrottledError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** 认出「这是限流」。跨副本也认得出。 */
export function isThrottled(error: unknown): error is ThrottledError {
  return typeof error === "object" && error !== null && (error as { throttled?: unknown }).throttled === true;
}

/**
 * 读「多久再来」。
 *
 * 服务端回的是秒数（`retry-after: "1"`）。`retry-after` 也允许写成 HTTP 日期，
 * 但本项目自己发的就是秒数，认不出的写法一律按兜底值处理 ——
 * 与其猜错让页面干等，不如早一点重试。
 */
export function readRetryAfterMs(headers: HeaderReader | null | undefined, fallbackMs = THROTTLE_DEFAULT_WAIT_MS): number {
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.min(Math.ceil(seconds * 1000), THROTTLE_MAX_WAIT_MS);
}

/**
 * 429 → 一个带等待时间的错误；其它状态码放过去（那是真失败）。
 *
 * 单独拎出来是因为「限流」和「失败」在页面上要说不同的话、挂不同的颜色。
 */
export function throttleSignal(status: number, headers: HeaderReader | null | undefined, message: string): ThrottledError | null {
  if (status !== 429) return null;
  return new ThrottledError(message, readRetryAfterMs(headers));
}

export interface ThrottleRetryOptions {
  /** 429 之后最多再试几次。 */
  maxRetries?: number;
  /** 等多久。测试里注掉，别让单测真的睡。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次要重试时喊一声 —— 页面据此告诉用户「系统繁忙，正在等 N 秒」。 */
  onRetry?: (info: { attempt: number; waitMs: number; error: ThrottledError }) => void;
}

/**
 * 跑一件事，撞上限流就按 `retry-after` 退避后重试。
 *
 * 只对限流重试：别的错重试也没用（重试只会把同一个错再犯一遍）。
 * 重试用尽仍被限流，就把这个错如实抛出去，由调用方决定怎么呈现。
 */
export async function withThrottleRetry<T>(
  attempt: (attemptIndex: number) => Promise<T>,
  options: ThrottleRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? THROTTLE_MAX_RETRIES;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: ThrottledError | undefined;

  for (let index = 0; index <= maxRetries; index += 1) {
    try {
      return await attempt(index);
    } catch (error) {
      if (!isThrottled(error)) throw error;
      lastError = error;
      if (index === maxRetries) break;
      options.onRetry?.({ attempt: index + 1, waitMs: error.retryAfterMs, error });
      await sleep(error.retryAfterMs);
    }
  }

  throw lastError;
}
