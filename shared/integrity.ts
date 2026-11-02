import { createHash } from "node:crypto";

/**
 * 数据完整性：状态自摘要与规范化序列化。
 *
 * 单独一个文件的原因：摘要这件事有两处要用 —— 写盘时算、读盘时验 ——
 * 而「算」的逻辑必须只有一份。两处各写一遍，早晚有一处改漏，
 * 而漏掉的那一处表现为「摘要一直对不上」，谁也查不出是哪边错了。
 *
 * 用的是同步的 `createHash` 而不是 `crypto.subtle`：
 * 审计链的哈希链判定是同步的（`AuditChain.append` 里直接算完写进记录），
 * 异步的 API 在那里根本用不上。浏览器端有等价的 SHA-256 替身，
 * 构建时会逐字节与 Node 的实现比对，不一致就构建失败。
 */

/**
 * 规范化序列化：对象键按字典序排，数组保持原序。
 *
 * **为什么必须排序**：摘要算的是「这段 JSON 的字节」。
 * 直接 `JSON.stringify` 的话，键的插入顺序不同就会算出不同的摘要 ——
 * 而读回来的对象键序由文件里的书写顺序决定，写出去时又由代码里的字面量顺序决定，
 * 两者只要有一处不一致就是误报。排序之后，摘要只取决于**内容**，
 * 不取决于键的摆放位置。
 *
 * 数组保持原序是必须的：`transferLog` 这种记录顺序本身就是信息，
 * 排序会把它抹掉。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * 对任意值算摘要。
 *
 * 先规范化再算哈希 —— 顺序反了就等于没规范化。
 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * 状态里带的完整性字段。
 *
 * 写进 `state.json` 的样子：
 * ```
 * "integrity": { "algo": "sha256", "digest": "<64 位十六进制>" }
 * ```
 *
 * `algo` 写明用的是哪种算法，是为了将来换算法时旧文件仍能被识别 ——
 * 摘要字段自己也要能被校验：否则把 digest 换成别的东西也「算通过」了。
 */
export interface StateIntegrity {
  algo: string;
  digest: string;
}

/**
 * 校验状态自摘要。
 *
 * 返回三种结果，不能只返回布尔：
 * - `ok`：摘要对得上
 * - `absent`：文件里没有 integrity 字段（老版本写的盘）—— **不判死**，
 *   按「这份账从来没被摘要保护过」处理，只是不给这个保证
 * - `mismatch`：摘要对不上 —— **这份状态在落盘之后被改过**
 *
 * 为什么老盘不判死：v1.19.0 之前写的 state.json 里没有这个字段。
 * 把它判成损坏，所有历史演示数据都读不进来 —— 那是「用新规则杀旧数据」，
 * 不是「发现数据坏了」。两者必须分开。
 */
export type IntegrityCheck =
  | { kind: "ok"; digest: string }
  | { kind: "absent" }
  | { kind: "mismatch"; expected: string; actual: string };

/**
 * 校验一份状态的完整性。
 *
 * 算的是「去掉 integrity 字段之后」的正文摘要，与写盘时算的完全一致。
 */
export function checkIntegrity(raw: unknown): IntegrityCheck {
  if (raw === null || typeof raw !== "object") return { kind: "absent" };
  const body = { ...(raw as Record<string, unknown>) };
  const stamp = body.integrity;
  delete body.integrity;
  if (stamp === undefined || stamp === null || typeof stamp !== "object") return { kind: "absent" };
  const field = stamp as Partial<StateIntegrity>;
  if (typeof field.digest !== "string" || typeof field.algo !== "string") {
    // integrity 字段本身坏了：这同样说明文件被动过，报不一致而不是「没有」。
    return { kind: "mismatch", expected: "（integrity 字段结构不完整）", actual: "（读不出来）" };
  }
  if (field.algo !== "sha256") {
    // 认不出的算法不能当成「通过」—— 那等于放过一切。
    return { kind: "mismatch", expected: `sha256`, actual: field.algo };
  }
  const actual = digestOf(body);
  return actual === field.digest ? { kind: "ok", digest: actual } : { kind: "mismatch", expected: field.digest, actual };
}
