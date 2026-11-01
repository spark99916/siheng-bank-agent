/**
 * `node:async_hooks` 的浏览器替身：只实现 AsyncLocalStorage，且只够单人使用。
 *
 * 为什么需要它：`shared/trace.ts` 用 AsyncLocalStorage 在调用链上传递 traceId，
 * 而审计链（`shared/rules.ts`）要读它。离线演示引擎把真的 shared/ 打进了页面，
 * 所以这个 import 必须能在浏览器里解析 —— 否则 `npm run demo:build` 直接失败。
 *
 * 为什么敢用栈式近似：真正的 AsyncLocalStorage 解决的是「多个异步请求交错执行时
 * 各自的上下文不串」。浏览器里的演示是一次一个人、一次只点一下，
 * 不存在交错；栈式实现在这种情况下结果与真实现一致。
 *
 * **局限要说清**：它不是 Node 实现的替代品。真后端仍然用 node:async_hooks，
 * 这里只服务 file:// 双击打开的那份单文件演示。
 */

export class AsyncLocalStorage<T> {
  private readonly stack: T[] = [];

  getStore(): T | undefined {
    return this.stack.length === 0 ? undefined : this.stack[this.stack.length - 1];
  }

  /**
   * 跑一段带上下文的逻辑。
   *
   * 返回 Promise 时要等它落定再出栈：异步逻辑里 `await` 之后仍要读得到上下文，
   * 提前出栈会让审计写进去的 traceId 变成 undefined —— 而这不会报错，只会少个字段。
   */
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    this.stack.push(store);
    let popped = false;
    const pop = (): void => {
      if (popped) return;
      popped = true;
      // 只从栈顶弹自己这一层：中途若有嵌套 run，内层已经先弹干净了。
      const index = this.stack.lastIndexOf(store);
      if (index >= 0) this.stack.splice(index, 1);
    };
    try {
      const out = callback(...args) as unknown;
      if (out !== null && typeof out === "object" && typeof (out as PromiseLike<unknown>).then === "function") {
        return Promise.resolve(out).finally(pop) as unknown as R;
      }
      pop();
      return out as R;
    } catch (error) {
      pop();
      throw error;
    }
  }

  enterWith(store: T): void {
    this.stack.push(store);
  }

  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const saved = this.stack.length === 0 ? undefined : this.stack.pop();
    try {
      return callback(...args) as R;
    } finally {
      if (saved !== undefined) this.stack.push(saved);
    }
  }
}

export default { AsyncLocalStorage };
