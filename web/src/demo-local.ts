/**
 * 离线演示引擎：把 `track-pi/src/agent.ts` 原样搬进浏览器。
 *
 * 为什么不是"另写一个模拟器" —— 模拟器会漂。演示页上写的「44 条规则、判红、令牌一次性」
 * 一旦由另一份代码算出来，它证明的就不是产品的行为，而是模拟器的行为。
 *
 * 这里的做法是：**同一份 agent、同一份 rules/state/persist**，只把
 * `node:crypto`、`node:fs`、`node:path`、`node:os` 换成浏览器替身（见 ./shims）。
 * 于是 `FileStore` 照常工作，只是落在内存里；审计链、幂等、工单、令牌全都还是原逻辑。
 * 页面上会明示：离线 = 判定同一份代码 + 持久层换成内存，刷新即清空。
 *
 * 多客户：一人一个 Agent，和真后端是同一套隔离方式 —— 状态各存一份、审计共用一条链、
 * 会话键带 userId 前缀。切换身份只是换一个 Agent，看不到也动不了别人的账。
 *
 * 不做的两件事，也明说：
 *   ① 不调模型（useModel: false）—— 浏览器里没有模型网关，规则解析本来就是主路径；
 *   ② 不连外部反欺诈 / 行情（没配 McpClient）—— 与"后端没配外部服务"时的行为一致。
 */

import { Agent } from "../../track-pi/src/agent.ts";
import { createOfflineTransport } from "../../track-pi/src/transport.ts";
import { AuditChain, TIER_LABEL, TIER_POLICY } from "../../shared/rules.ts";
import type { AuditRecord, Tier } from "../../shared/rules.ts";
import { FileStore } from "../../shared/persist.ts";
import { initialState } from "../../shared/state.ts";
import { CUSTOMERS, customerByToken, DEFAULT_CUSTOMER, publicDirectory, type Customer } from "../../shared/directory.ts";
import { newTraceId, runWithTrace } from "../../shared/trace.ts";

/**
 * 限流退避也一并导出。
 *
 * 演示站的主脚本是内联的（file:// 下不能 import 模块），但退避逻辑必须与
 * 业务界面共用同一份 —— 手写两遍一定会漂。挂在引擎全局上，页面直接取。
 */
export { isThrottled, throttleSignal, withThrottleRetry } from "./throttle.ts";

const DATA_DIR = "/siheng-demo";

/** 最近一次请求的 traceId。离线引擎没有响应头，页面用它显示「这一条追到哪」。 */
let lastTrace = "";

/**
 * 根存储与审计链只有一份。
 *
 * 审计链**不**按客户拆：一条链、各用户共写，靠 sessionId 前缀区分。
 * 链的作用是「发生过的事按顺序连起来」，按人切开反而拼不回全局时序 ——
 * 这一点和真后端的 `index.ts` 保持一致，否则离线跑出来的形状和线上不是一回事。
 */
const rootStore = new FileStore(DATA_DIR);
const boot = rootStore.readAudit();
const chain = new AuditChain(rootStore, boot.rows as AuditRecord[]);

/** 一人一个 Agent，一人一个子目录。 */
const agents = new Map<string, Agent>();
const stores = new Map<string, FileStore>();

function seedOf(customer: Customer) {
  return {
    holder: customer.name,
    balanceCents: customer.seed.balanceCents,
    availableCents: customer.seed.availableCents,
  };
}

function agentFor(customer: Customer): Agent {
  const hit = agents.get(customer.userId);
  if (hit !== undefined) return hit;
  const store = rootStore.forUser(customer.userId, seedOf(customer));
  stores.set(customer.userId, store);
  const loaded = store.loadState();
  const agent = new Agent({
    state: loaded.kind === "disk" ? loaded.state : initialState(Date.now(), seedOf(customer)),
    // seed 交给 Agent：reset 要按本客户的开户余额退账，不能一律退成默认客户。
    seed: seedOf(customer),
    transport: createOfflineTransport(),
    chain,
    store,
    useModel: false,
    narrate: false,
  });
  agents.set(customer.userId, agent);
  return agent;
}

/**
 * 当前身份。演示页可以在四个客户之间切换 ——
 * 切换之后拿到的是另一个 Agent，读到的余额、流转的都是那个人的账。
 */
let active: Customer = DEFAULT_CUSTOMER;

export function currentUser(): { userId: string; name: string; tier: Tier; tierLabel: string } {
  return { userId: active.userId, name: active.name, tier: active.tier, tierLabel: TIER_LABEL[active.tier] };
}

/** 按令牌切身份。切不动就原样返回 null，不悄悄留在上一个人身上。 */
export function switchUser(token: string): { userId: string; name: string; tier: Tier; tierLabel: string } | null {
  const customer = customerByToken(token);
  if (customer === null) return null;
  active = customer;
  agentFor(customer);
  return currentUser();
}

/**
 * 会话键加客户端前缀，且**只加一次**。
 *
 * 幂等不是洁癖：chat 的返回值里带的是已经加过前缀的 sessionId，
 * 页面拿着它去调 confirm 时又会进来一次。不做判断就会变成
 * `u-1001:u-1001:web:xxx`，两边的键对不上，刚签出的卡确认不了。
 */
function sessionKey(sessionId: string): string {
  const prefix = `${active.userId}:`;
  return sessionId.startsWith(prefix) ? sessionId : prefix + sessionId;
}

function snapshot(method: string, params: unknown[]) {
  const base = agentFor(active).snapshot();
  void method;
  void params;
  return {
    ...base,
    identity: currentUser(),
  };
}

/** 离线版的健康读数：字段与真接口同名，值来自同一批对象。 */
function health() {
  const agent = agentFor(active);
  const store = stores.get(active.userId) as FileStore;
  return {
    track: "pi",
    mode: "offline",
    model: { model: "offline", available: false, baseUrl: "", maxTokens: 0, thinking: false },
    loop: { narrate: false, maxSteps: 1 },
    usage: null,
    external: { fx: { name: "fx", enabled: false }, risk: { name: "bank-risk", enabled: false } },
    accountDay: { cutoffHour: 0, label: "自然日零点切" },
    uptime: Math.round(performance.now() / 1000),
    identity: currentUser(),
    persistence: {
      enabled: true,
      dir: store.dir,
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
  const store = stores.get(active.userId) as FileStore | undefined;
  const kind = store === undefined ? "fresh" : store.loadState().kind;
  const ok = kind !== "corrupt";
  const agent = agentFor(active);
  return {
    ready: ok,
    checks: {
      phase: "running",
      inflight: 0,
      audit: chain.verify(),
      stateOrigin: kind === "disk" ? "disk" : "fresh",
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
 *
 * 身份不从这里传：调用者只可能是当前页面上选中的那个客户，
 * 与真后端「令牌换身份、参数无权指定」是同一条规矩。
 */
export async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  /**
   * 离线引擎也发 traceId。
   *
   * 为什么不是「反正没有 HTTP 层，省了」：审计记录里的 traceId 是判定链一部分，
   * 离线演示看到的记录必须和真后端看到的同形 —— 否则演示时说的和跑起来的是两回事。
   * 这里只是没有响应头可回，id 本身照样生成、照样进链。
   */
  const context = { traceId: newTraceId(), startedAt: Date.now(), method, userId: active.userId };
  lastTrace = context.traceId;
  return await runWithTrace(context, () => rpcInner(method, params));
}

/** 最近一次请求的 traceId：页面拿它显示「这一条能追到哪」。 */
export function traceId(): string {
  return lastTrace;
}

async function rpcInner(method: string, params: unknown[] = []): Promise<unknown> {
  const agent = agentFor(active);
  const actor = { userId: active.userId, tier: active.tier };
  switch (method) {
    case "chat":
      return await agent.chat(
        sessionKey(String(params[0] ?? "")),
        String(params[1] ?? ""),
        actor,
        undefined,
        typeof params[4] === "string" ? params[4] : undefined,
      );
    case "confirm":
      return await agent.confirm(sessionKey(String(params[0] ?? "")), String(params[1] ?? ""), typeof params[2] === "string" ? params[2] : undefined);
    case "plan":
      return agent.explainPlan(sessionKey(String(params[0] ?? "")), actor);
    case "cancel":
      return agent.cancel(sessionKey(String(params[0] ?? "")));
    case "state":
      return snapshot(method, params);
    case "directory":
      return { entries: publicDirectory(), me: currentUser() };
    case "reset":
      return agent.reset();
    case "audit":
      return agent.auditLog(typeof params[0] === "string" ? sessionKey(String(params[0])) : undefined, Number(params[1] ?? 20));
    /**
     * 篡改演示：改掉一条审计结论，让链断在那一。
     *
     * 真后端这一条要 `DEMO_TAMPER=on` 才开，理由是它改的是磁盘上真实存在的审计链 ——
     * 那是真数据，闸门必须挡。离线这里的理由不一样：FileStore 落在内存 Map 里，
     * 刷新即清空，压根没有"被篡改的真实记录"可保护，而链断不断正是要演示的东西。
     * 所以离线默认开着，不设环境变量 —— 双击就能看见链断，比让人先配好变量再开服务强。
     *
     * 改的是 `AuditChain` 内存里的那一份，落盘那份没动。断链由 `verify()` 按哈希重算得出，
     * 结论和真后端同源：改哪个字段都会断，断点位置由 brokenAt 直接报出来。
     */
    case "tamper":
      return agent.tamper(Number(params[0] ?? 0), String(params[1] ?? "（被篡改）"));
    case "tick":
      return agent.tick(typeof params[0] === "string" && params[0] !== "" ? new Date(params[0]).getTime() : Date.now());
    case "handoffs":
      return {
        rows: agent.handoffBoard.list({
          state: params[0] === "open" || params[0] === "claimed" || params[0] === "closed" ? params[0] : undefined,
          sessionId: typeof params[1] === "string" && params[1] !== "" ? sessionKey(String(params[1])) : undefined,
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
  version: "1.21.0",
  dataDir: DATA_DIR,
  records: boot.rows.length,
  corrupt: boot.corrupt,
  stateKind: "fresh" as const,
  customers: CUSTOMERS.map((item) => ({ userId: item.userId, name: item.name, token: item.token })),
};
