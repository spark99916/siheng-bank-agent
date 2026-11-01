/**
 * 离线演示引擎：把 `track-pi/src/agent.ts` 原样搬进浏览器。
 *
 * 为什么不是"另写一个模拟器" —— 模拟器会漂。演示页上写的「43 条规则、判红、令牌一次性」
 * 一旦由另一份代码算出来，它证明的就不是产品的行为，而是模拟器的行为。
 *
 * 这里的做法是：**同一份 agent、同一份 rules/state/persist**，只把
 * `node:crypto`、`node:fs`、`node:path`、`node:os` 换成浏览器替身（见 ./shims）。
 * 于是 `FileStore` 照常工作，只是落在内存里；审计链、幂等、工单、令牌全都还是原逻辑。
 * 页面上会明示：离线 = 判定同一份代码 + 持久层换成内存，刷新即清空。
 *
 * 不做的两件事，也明说：
 *   ① 不调模型（useModel: false）—— 浏览器里没有模型网关，规则解析本来就是主路径；
 *   ② 不连外部反欺诈 / 行情（没配 McpClient）—— 与"后端没配外部服务"时的行为一致。
 */

import { Agent } from "../../track-pi/src/agent.ts";
import { createOfflineTransport } from "../../track-pi/src/transport.ts";
import { AuditChain, DEFAULT_ACTOR, TIER_LABEL, TIER_POLICY } from "../../shared/rules.ts";
import type { Actor, AuditRecord, Tier } from "../../shared/rules.ts";
import { FileStore } from "../../shared/persist.ts";
import { initialState } from "../../shared/state.ts";

const DATA_DIR = "/siheng-demo";

const store = new FileStore(DATA_DIR);
const boot = store.readAudit();
const chain = new AuditChain(store, boot.rows as AuditRecord[]);
const loaded = store.loadState();

const agent = new Agent({
  state: loaded.kind === "disk" ? loaded.state : initialState(),
  transport: createOfflineTransport(),
  chain,
  store,
  useModel: false,
  narrate: false,
});

function toActor(raw: unknown): Actor {
  if (raw === null || typeof raw !== "object") return DEFAULT_ACTOR;
  const input = raw as { userId?: unknown; tier?: unknown };
  const tier: Tier = input.tier === "gold" || input.tier === "private" ? input.tier : "standard";
  return { userId: typeof input.userId === "string" && input.userId !== "" ? input.userId : "web-local", tier };
}

function snapshot() {
  return agent.snapshot();
}

/** 离线版的健康读数：字段与真接口同名，值来自同一批对象。 */
function health() {
  return {
    track: "pi",
    mode: "offline",
    model: { model: "offline", available: false, baseUrl: "", maxTokens: 0, thinking: false },
    loop: { narrate: false, maxSteps: 1 },
    usage: null,
    external: { fx: { name: "fx", enabled: false }, risk: { name: "bank-risk", enabled: false } },
    accountDay: { cutoffHour: 0, label: "自然日零点切" },
    uptime: Math.round(performance.now() / 1000),
    persistence: {
      enabled: true,
      dir: DATA_DIR,
      // 内存盘的"目录"不是真的目录，这里如实写清楚，不冒充磁盘。
      backing: "memory",
      ...store.info(),
      loadedRecords: boot.rows.length,
      corruptLines: boot.corrupt,
      chain: chain.verify(),
    },
    idempotency: agent.idempotencyInfo,
    handoff: agent.handoffBoard.metrics(),
    tiers: (Object.keys(TIER_POLICY) as Tier[]).map((tier) => ({
      tier,
      label: TIER_LABEL[tier],
      singleLimitCents: TIER_POLICY[tier].singleLimitCents,
      dailyLimitCents: TIER_POLICY[tier].dailyLimitCents,
    })),
  };
}

/** 就绪读数：离线模式下"进程"就是这个页面，所以永远能派活，除非状态读坏了。 */
function ready() {
  const state = loaded.kind;
  const ok = state !== "corrupt";
  return {
    ready: ok,
    checks: {
      phase: "running",
      inflight: 0,
      audit: chain.verify(),
      stateOrigin: state === "disk" ? "disk" : "fresh",
      idempotency: agent.idempotencyInfo,
      handoff: agent.handoffBoard.metrics(),
      backing: "memory",
    },
    ...(ok ? {} : { reason: "状态文件存在但读不出来（内存盘里不会发生，留作形状一致）" }),
  };
}

/**
 * 与 `track-pi/src/index.ts` 的 `/rpc` 同形状：方法名、参数顺序、返回结构都对齐。
 * 页面因此不需要两套调用代码 —— 换的是通道，不是语义。
 */
export async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  switch (method) {
    case "chat":
      return await agent.chat(
        String(params[0] ?? ""),
        String(params[1] ?? ""),
        toActor(params[2]),
        undefined,
        typeof params[4] === "string" ? params[4] : undefined,
      );
    case "confirm":
      return await agent.confirm(String(params[0] ?? ""), String(params[1] ?? ""), typeof params[2] === "string" ? params[2] : undefined);
    case "plan":
      return agent.explainPlan(String(params[0] ?? ""), toActor(params[1]));
    case "cancel":
      return agent.cancel(String(params[0] ?? ""));
    case "state":
      return snapshot();
    case "reset":
      return agent.reset();
    case "audit":
      return agent.auditLog(typeof params[0] === "string" ? params[0] : undefined, Number(params[1] ?? 20));
    case "tick":
      return agent.tick(typeof params[0] === "string" && params[0] !== "" ? new Date(params[0]).getTime() : Date.now());
    case "handoffs":
      return {
        rows: agent.handoffBoard.list({
          state: params[0] === "open" || params[0] === "claimed" || params[0] === "closed" ? params[0] : undefined,
          sessionId: typeof params[1] === "string" && params[1] !== "" ? params[1] : undefined,
          limit: Number(params[2] ?? 20),
        }),
        metrics: agent.handoffBoard.metrics(),
      };
    case "handoff.claim":
      return agent.handoffBoard.claim(String(params[0] ?? ""), String(params[1] ?? "未署名"));
    case "handoff.close":
      return agent.handoffBoard.close(
        String(params[0] ?? ""),
        String(params[1] ?? "no-action") as never,
        String(params[2] ?? ""),
        typeof params[3] === "string" ? params[3] : undefined,
      );
    case "handoff.sweep":
      return agent.handoffBoard.sweep(typeof params[0] === "string" && params[0] !== "" ? new Date(params[0]).getTime() : Date.now());
    case "health":
      return health();
    default:
      throw new Error(`离线引擎没有这个方法：${method}`);
  }
}

/** 探针：离线模式下合成同样形状的响应，页面不用为此写第二套分支。 */
export function probe(pathname: string): { status: number; body: unknown } {
  if (pathname === "/live") return { status: 200, body: { ok: true, mode: "offline", uptime: Math.round(performance.now() / 1000) } };
  if (pathname === "/ready") {
    const body = ready();
    return { status: body.ready ? 200 : 503, body };
  }
  return { status: 404, body: { ok: false, error: "离线引擎只提供 /live 与 /ready" } };
}

export const info = {
  mode: "offline" as const,
  version: "1.14.2",
  dataDir: DATA_DIR,
  records: boot.rows.length,
  corrupt: boot.corrupt,
  stateKind: loaded.kind,
};
