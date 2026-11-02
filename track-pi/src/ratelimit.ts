/**
 * 每个客户一个令牌桶：防的是「一个人把整个服务的额度和模型调用打光」。
 *
 * 为什么按客户（而不是按 IP）：银行的配额是给客户的，不是给出口 IP 的。
 * 一个客户从手机和电脑同时发，是同一个人的两份额度，不该互相挤占。
 *
 * 为什么是令牌桶而不是固定窗口：固定窗口在边界上有两倍突发（59 秒来 60 次、
 * 61 秒再来 60 次，两秒内 120 次）。银行的场景里「边界突发」正是最需要拦的形态。
 *
 * 为什么零依赖手写：和 metrics 同理，30 行能说清的东西不值得引一个包；
 * 而且这里必须能注入时钟，否则测试只能靠 sleep，慢且不稳。
 */

export interface BucketOptions {
  /** 桶容量（允许的突发行数）。 */
  capacity: number;
  /** 每秒补充多少令牌。 */
  refillPerSecond: number;
  /** 时钟，默认 Date.now。测试注入。 */
  now?: () => number;
  /**
   * 桶闲置多久后清掉。不清理的话，一个扫描器拿一万个令牌来刷，
   * 这里就会留一万个空桶 —— 内存被「不存在的客户」吃掉。
   */
  idleMs?: number;
}

export interface TakeResult {
  ok: boolean;
  /** 这一次有没有被拦。被拦时 retryAfterMs 是被拦的那一位说的「多久后再来」。 */
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private readonly idleMs: number;
  private lastSweep = 0;

  constructor(options: BucketOptions) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerSecond = Math.max(0.0001, options.refillPerSecond);
    this.now = options.now ?? (() => Date.now());
    this.idleMs = options.idleMs ?? 10 * 60_000;
  }

  /**
   * 取一个令牌。
   *
   * 注意「先补后扣」的顺序：补到容量上限再扣，扣不动才算拒绝。
   * 反过来（先扣再补）会让突发额度随时间被吃掉，桶就退化成计数器了。
   */
  take(key: string, cost = 1): TakeResult {
    const now = this.now();
    const current = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, (now - current.updatedAt) / 1000);
    const refilled = Math.min(this.capacity, current.tokens + elapsedSeconds * this.refillPerSecond);

    if (refilled >= cost) {
      const left = refilled - cost;
      this.buckets.set(key, { tokens: left, updatedAt: now });
      this.maybeSweep(now);
      return { ok: true, remaining: Math.floor(left), retryAfterMs: 0 };
    }

    // 拒绝时也要把补充后的值写回去，否则连续的拒绝会各自从旧值重算，永远补不满。
    this.buckets.set(key, { tokens: refilled, updatedAt: now });
    const need = cost - refilled;
    return {
      ok: false,
      remaining: Math.floor(refilled),
      retryAfterMs: Math.ceil((need / this.refillPerSecond) * 1000),
    };
  }

  /** 当前桶里还剩多少（不扣）。给健康检查与测试用。 */
  peek(key: string): number {
    const now = this.now();
    const current = this.buckets.get(key);
    if (current === undefined) return this.capacity;
    const refilled = Math.min(this.capacity, current.tokens + Math.max(0, (now - current.updatedAt) / 1000) * this.refillPerSecond);
    return Math.floor(refilled);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** 整分钟配额：报错文案与健康检查要用同一口径，所以从同一个数算出来。 */
  get refillPerMinute(): number {
    return Math.round(this.refillPerSecond * 60);
  }

  get burst(): number {
    return this.capacity;
  }

  /** 手动清理：只清「已经补满」的桶，补满等于没欠账，删掉与留着等价。 */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      const refilled = Math.min(this.capacity, bucket.tokens + Math.max(0, (now - bucket.updatedAt) / 1000) * this.refillPerSecond);
      if (refilled >= this.capacity || now - bucket.updatedAt > this.idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 每分钟最多扫一次：扫描不是热路径，别让它跟着每个请求跑。 */
  private maybeSweep(now: number): void {
    if (this.buckets.size < 512) return;
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    this.sweep();
  }
}

/**
 * 从环境变量读配额：RATE_LIMIT_PER_MINUTE=0 表示关掉（压测、演示时用）。
 *
 * 默认 120 次/分钟、突发 40：一个真人点对话点不到这个数，
 * 一台跑脚本的机器一分钟能打几千次 —— 中间这一档就是这条线要站的位置。
 */
export function bucketsFromEnv(env: NodeJS.ProcessEnv): TokenBuckets | undefined {
  const perMinute = Number(env.RATE_LIMIT_PER_MINUTE ?? 120);
  if (!Number.isFinite(perMinute) || perMinute <= 0) return undefined;
  const fallbackBurst = Math.max(5, Math.floor(perMinute / 3));
  const burstRaw = Number(env.RATE_LIMIT_BURST ?? fallbackBurst);
  return new TokenBuckets({
    capacity: Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : fallbackBurst,
    refillPerSecond: perMinute / 60,
  });
}

/**
 * 只读调用单独一个桶。
 *
 * 为什么只读要分开：读数不调模型、不动账、不写审计 —— 它占的是
 * 「这个客户的办事额度」，可它根本不是「办事」。混在一个桶里有两个坏处：
 *
 * ① **读数把办事额度吃光**。演示页面每 4 秒轮询一次读数，三个请求；
 *    一台开着页面的机器一分钟就白烧掉 45 次额度。用户真正要转账的时候，
 *    额度已经被自己的仪表盘耗光了 —— 被自己的读数挡下的转账，最冤。
 *
 * ② **限流拦错了东西**。桶满的原因是读数多，不是有人刷接口；
 *    拦下来之后报「请求太频繁」，用户不知道自己做了什么就被挡了。
 *
 * 所以只读走自己的桶，额度宽得多（默认 6 倍），但**照样有限流** ——
 * 它挡的是有人拿读数接口当压测工具打，那也得挡。
 */
export function readOnlyBucketsFromEnv(env: NodeJS.ProcessEnv, business: TokenBuckets | undefined): TokenBuckets | undefined {
  if (business === undefined) return undefined;
  const perMinute = Number(env.RATE_LIMIT_READ_PER_MINUTE ?? Math.round(business.refillPerMinute * 6));
  if (!Number.isFinite(perMinute) || perMinute <= 0) return undefined;
  const fallbackBurst = Math.max(10, Math.floor(perMinute / 3));
  const burstRaw = Number(env.RATE_LIMIT_READ_BURST ?? fallbackBurst);
  return new TokenBuckets({
    capacity: Number.isFinite(burstRaw) && burstRaw > 0 ? burstRaw : fallbackBurst,
    refillPerSecond: perMinute / 60,
  });
}

/**
 * 哪些方法是只读的。
 *
 * 判据是「会不会改变客户的钱或状态」：只查、不动手的算只读。
 * `handoffs` 在这里算只读 —— 它只是读工单列表；
 * 改工单的是 `handoff.claim` / `handoff.close` / `handoff.sweep`，那几个是写。
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "state",
  "health",
  "handoffs",
  "directory",
  "audit",
  "plan",
]);
