/**
 * 丢弃留证：数据坏了不许静默吞掉。
 *
 * **为什么必须留证**：合并结果会覆盖原文件。丢掉一条就是永久丢掉 ——
 * 事后没人说得清「这里本来有没有东西」。留一份原文在旁边，
 * 至少还能查清丢的是什么、什么时候丢的。
 *
 * **为什么丢掉并留证，而不是留着并当真**：一条字段坏掉的记录，
 * 并进正式数据可能让系统误判「这笔已经办过了」——
 * 那是错的方向（宁可重做一次让人看见，也不能凭空说「办过了」）。
 * 幂等日志上尤其如此。
 *
 * **计数与留证是一套**：只留证不计数，运维看不到；
 * 只计数不留证，查不出丢的是什么。两个一起做才有意义。
 */

/** 一条被丢弃的数据：原文 + 为什么被丢。 */
export interface RejectedEntry {
  /** 是哪本登记簿：会话 / 幂等 / 工单 / 审计。 */
  scope: string;
  /** 为什么被丢：字段缺失、类型不对、状态不认识…… */
  reason: string;
  /** 被丢的原文。 */
  item: unknown;
}

/**
 * 丢弃收集器：一次合并里丢掉的所有条目。
 *
 * 用一个对象贯穿整条链路（读 → 合并 → 留证 → 上报），
 * 而不是让每个 merge 函数各自返回一份 ——
 * 那会让「谁负责留证」这件事分散到四个地方，迟早有一处漏。
 */
export class RejectionLog {
  private readonly entries: RejectedEntry[] = [];
  /** 按 scope 计数：运维看的是「哪本账丢了多少条」。 */
  private readonly byScope = new Map<string, number>();

  /** 记下一条被丢弃的数据。 */
  reject(scope: string, reason: string, item: unknown): void {
    this.entries.push({ scope, reason, item });
    this.byScope.set(scope, (this.byScope.get(scope) ?? 0) + 1);
  }

  /** 一共丢了几条。 */
  get total(): number {
    return this.entries.length;
  }

  /** 某一本账丢了几条。 */
  countOf(scope: string): number {
    return this.byScope.get(scope) ?? 0;
  }

  /** 按 scope 的完整计数，给 health 读数用。 */
  counts(): Record<string, number> {
    return Object.fromEntries(this.byScope);
  }

  /** 被丢弃的原文，给留证文件用。 */
  list(): RejectedEntry[] {
    return [...this.entries];
  }
}
