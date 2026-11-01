import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import type { AccountDayConfig, Actor, RiskPolicy } from "../../shared/rules.ts";
import { AuditChain, redact, TIER_LABEL, TIER_POLICY } from "../../shared/rules.ts";
import type { AuditRecord } from "../../shared/rules.ts";
import type { HandoffResolution } from "../../shared/handoff.ts";
import { McpClient } from "../../shared/mcp-client.ts";
import { FileStore } from "../../shared/persist.ts";
import { initialState } from "../../shared/state.ts";
import { CUSTOMERS, customerByToken, DEFAULT_CUSTOMER, publicDirectory, type Customer } from "../../shared/directory.ts";
import { annotateTrace, newTraceId, runWithTrace, type TraceContext } from "../../shared/trace.ts";
import { Shutdown } from "./lifecycle.ts";
import { createLogger, logText, Metrics, type LogLevel } from "./obs.ts";
import { bucketsFromEnv, type TokenBuckets } from "./ratelimit.ts";
import { createHttpTransport, createOfflineTransport, readTransportSettings } from "./transport.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 18150);
/**
 * 监听地址默认只开回环。
 *
 * 容器里必须让外部连进来，所以给 HOST 一个开关，**而不是把默认值改成 0.0.0.0** ——
 * 默认对外监听意味着开发机上跑一次就把接口暴露到局域网，这不是「方便」，这是事故来源。
 * Dockerfile 里显式设 HOST=0.0.0.0。
 */
const host = process.env.HOST ?? "127.0.0.1";

/**
 * 落盘开关：PERSIST=off 退回纯内存（一次性演示、压测用）。
 * 默认写 data/（已在 .gitignore 里），路径可用 DATA_DIR 改。
 */
const persistOn = process.env.PERSIST !== "off";
const dataDir = process.env.DATA_DIR ?? path.resolve(here, "..", "..", "data");
const store = persistOn ? new FileStore(dataDir) : undefined;

/**
 * ─────────────── 可观测：指标、日志、限流 ───────────────
 *
 * 三样东西的分工：
 *   指标（/metrics）回答「现在好不好」——给监控看，低基数、可聚合；
 *   日志（JSON Lines）回答「刚才那一次发生了什么」——给人看，带 traceId、可检索；
 *   限流（令牌桶）回答「要不要拦住他」——给系统自保用，按客户计数。
 *
 * 都不进业务层：agent.ts 一行都没改。判定仍然只做判定，
 * 「这次跑了多久、被谁调、超没超配额」是入口的事。
 */
const logFormat = (process.env.LOG_FORMAT ?? "text").toLowerCase() === "json" ? "json" : "text";
const logLevel = (["debug", "info", "warn", "error"].includes(process.env.LOG_LEVEL ?? "") ? process.env.LOG_LEVEL : "info") as LogLevel;
const logger = createLogger({
  format: logFormat,
  level: logLevel,
  userText: process.env.LOG_USER_TEXT !== "off",
});

const metrics = new Metrics();
const rpcRequests = metrics.counter("siheng_rpc_requests_total", "RPC 请求总数，按方法与状态码");
const rpcDuration = metrics.histogram("siheng_rpc_duration_ms", "RPC 端到端耗时（毫秒）");
const decisionsTotal = metrics.counter("siheng_decisions_total", "判定结果分布，level 取 green/yellow/red");
const confirmTotal = metrics.counter("siheng_confirm_total", "确认动作结果，outcome 取 executed/rejected/expired");
const idempotencyTotal = metrics.counter("siheng_idempotency_total", "幂等键命中情况，kind 取 first/replayed/interrupted/conflict");
const llmTokens = metrics.counter("siheng_llm_tokens_total", "模型 token 消耗，kind 取 prompt/completion");
const handoffOpen = metrics.gauge("siheng_handoff_open", "尚未结案的人工工单数", () => {
  // 所有已装载账户一起数：只数默认客户会漏掉别人的人命关天的单子。
  let pending = 0;
  let total = 0;
  for (const item of agents.values()) {
    const board = item.handoffBoard.metrics();
    pending += board.pending;
    total += board.opened;
  }
  return [
    { labels: { state: "pending" }, value: pending },
    { labels: { state: "opened" }, value: total },
  ];
});
const rateLimited = metrics.counter("siheng_ratelimit_rejected_total", "被限流拒绝的请求数，按 scope 分");
const buckets: TokenBuckets | undefined = bucketsFromEnv(process.env);

/** 进程自身读数：抓取时现取，不另外开采集线程。 */
metrics.gauge("siheng_process_uptime_seconds", "进程已运行秒数", () => [{ labels: {}, value: process.uptime() }]);
metrics.gauge("siheng_process_rss_bytes", "常驻内存字节数", () => [{ labels: {}, value: process.memoryUsage().rss }]);
metrics.gauge("siheng_audit_chain_length", "审计链长度（启动装载 + 运行期追加）", () => [
  { labels: {}, value: chain.length },
]);
metrics.gauge("siheng_ready", "能否接活：1 就绪，0 未就绪", () => [{ labels: {}, value: stateOrigin === "fallback" ? 0 : 1 }]);


/** 只认结构完整的审计记录：手改坏的行不接进链，否则整条链从装载起就是断的。 */
function isAuditRecord(raw: unknown): raw is AuditRecord {
  if (raw === null || typeof raw !== "object") return false;
  const item = raw as Partial<AuditRecord>;
  return (
    typeof item.seq === "number" &&
    typeof item.hash === "string" &&
    typeof item.prevHash === "string" &&
    typeof item.ts === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.actor === "string"
  );
}

const auditAtBoot = store?.readAudit();
const restoredRecords = (auditAtBoot?.rows ?? []).filter(isAuditRecord);

/**
 * 启动先看「门面账户」的账是否完好：默认客户是演示主账户，它坏了就别开门。
 * 其他客户的账在各自主目录里，装载失败只影响他自己（见 createAgent）。
 */
const bootStore = store?.forUser(DEFAULT_CUSTOMER.userId, {
  holder: DEFAULT_CUSTOMER.name,
  balanceCents: DEFAULT_CUSTOMER.seed.balanceCents,
  availableCents: DEFAULT_CUSTOMER.seed.availableCents,
});
const loadedState = bootStore?.loadState();

/**
 * 状态读不出来就停住，不拿初始余额冒充用户的钱。
 *
 * 「文件被手改坏」和「全新安装」在旧实现里长得一模一样：都是初始余额、都照常开门。
 * 银行口径下前者意味着全部账目口径失效 —— 余额不对、限额累计不对、审计对不上，
 * 而界面上一切正常。所以这里选择不开门。
 *
 * 要带着初始值强行起（演示、恢复演练），显式设 ALLOW_STATE_FALLBACK=1：
 * 让它成为一个有人做过的动作，而不是一次没人发现的意外。
 */
const allowStateFallback = process.env.ALLOW_STATE_FALLBACK === "1";
if (loadedState?.kind === "corrupt" && !allowStateFallback) {
  console.error(`[store] 拒绝启动：${bootStore?.dir}/state.json 存在，但读不出来`);
  console.error(`[store] 原因：${loadedState.reason}`);
  console.error("[store] 这份状态可能被手改过、写盘时断电、或来自另一个版本的格式。");
  console.error("[store] 拿初始余额冒充用户的钱比停住更危险，所以这里不动。");
  console.error("[store] 处理：先备份该文件；确认要从零开始就删掉它；确认要带初始状态强行起：ALLOW_STATE_FALLBACK=1");
  process.exit(78);
}
if (loadedState?.kind === "corrupt") {
  console.warn(`[store] 状态文件读不出来（${loadedState.reason}），已按 ALLOW_STATE_FALLBACK=1 强行启动`);
  console.warn("[store] 当前账户是初始值，不是用户的真实余额 —— /ready 会一直报 503");
}

/**
 * 状态是从哪来的 —— 这件事必须说清楚。
 * fallback 是「有文件但读不出来」，和 fresh / disk 完全是两回事，不能混在一起报。
 */
const stateOrigin: "memory" | "disk" | "fallback" | "fresh" =
  loadedState === undefined
    ? "memory"
    : loadedState.kind === "disk"
      ? "disk"
      : loadedState.kind === "fresh"
        ? "fresh"
        : "fallback";

const chain = new AuditChain(store, restoredRecords);
const settings = readTransportSettings();
const transport = settings.apiKey === "" ? createOfflineTransport() : createHttpTransport(settings);

/** 外部汇率服务：stdio 子进程，默认 3 秒超时，挂了不影响内置工具。 */
const fx = new McpClient("bank-fx", {
  command: process.execPath,
  args: [path.resolve(here, "..", "..", "mcp", "fx-server.mjs")],
  timeoutMs: Number(process.env.MCP_FX_TIMEOUT_MS ?? 3000),
});

/**
 * 外部反欺诈服务：与汇率同一套 stdio 客户端。
 * MCP_RISK_OFF=1 表示「没接这层能力」，判定里不会出现外部证据规则；
 * 接了但调不通（超时/崩溃）走降级，判定把转账抬成需确认 —— 两者不能混为一谈。
 */
const risk =
  process.env.MCP_RISK_OFF === "1"
    ? undefined
    : new McpClient("bank-risk", {
        command: process.execPath,
        args: [path.resolve(here, "..", "..", "mcp", "risk-server.mjs")],
        timeoutMs: Number(process.env.MCP_RISK_TIMEOUT_MS ?? 3000),
      });

/** 账务日口径：业务时区与切分点都从环境读。默认东八区、零点切，与银行常见口径相反时改这里即可。 */
const accountDay: AccountDayConfig = {
  tzOffsetMinutes: Number.isFinite(Number(process.env.BIZ_TZ_OFFSET_MIN)) ? Number(process.env.BIZ_TZ_OFFSET_MIN) : 480,
  cutoffHour: (() => {
    const value = Number(process.env.ACCOUNT_DAY_CUTOFF ?? 0);
    return Number.isFinite(value) && value >= 0 && value <= 23 ? value : 0;
  })(),
};

/**
 * 每个客户一个 Agent 实例。
 *
 * 为什么不是「一个 Agent 管所有账户」：Agent 身上挂着四个内存 Map（待确认票、草稿、
 * 最近收款人、收款人提议），还压着会话快照。让它同时服务多个人，就要给每个方法
 * 都加一个「这次是哪个用户」，漏传一处就是串号 —— 而串号在银行场景里是越权，不是 bug。
 * 一个客户一个实例，隔离由对象边界保证，不靠人记得传参。
 *
 * 审计链**不**按客户拆：一条链、各用户共写，靠 sessionId 前缀区分。链的作用是
 * 「发生过的事按顺序连起来」，按人切开反而拼不回全局时序。
 */
const agents = new Map<string, Agent>();

/** 冷账户上限：内存里最多留这么多 Agent，超了先踢最久没动的（下次从盘上重新载入）。 */
const MAX_CACHED_AGENTS = Number(process.env.MAX_CACHED_AGENTS ?? 200);

/** 单个客户的账读不出来时抛这个 —— 只拒绝该客户，不连累别人继续营业。 */
class StateUnavailable extends Error {}

function createAgent(customer: Customer): Agent {
  const seed = {
    holder: customer.name,
    balanceCents: customer.seed.balanceCents,
    availableCents: customer.seed.availableCents,
  };
  const scoped = store?.forUser(customer.userId, seed);
  const loaded = scoped?.loadState();
  if (loaded?.kind === "corrupt") {
    // 拿初始余额冒充这个人的钱，比拒绝服务更危险：他会看到一笔不属于自己的余额。
    throw new StateUnavailable(`账户状态读不出来：${loaded.reason}`);
  }
  const state = loaded?.kind === "disk" || loaded?.kind === "fresh" ? loaded.state : initialState(Date.now(), seed);
  return new Agent({
  state,
  transport,
  chain,
  fx,
  risk,
  store: scoped,
  accountDay,
  useModel: process.env.USE_MODEL !== "off",
  // 回复改写：模型拿到真实执行结果后再组织一次语言。LLM_NARRATE=off 可关。
  narrate: process.env.LLM_NARRATE !== "off",
  // 循环内最多再发起几次只读查询。默认 1，够回答「余额够不够」这类追问。
  loopSteps: Number.isFinite(Number(process.env.LLM_LOOP_STEPS)) ? Number(process.env.LLM_LOOP_STEPS) : 1,
  // 只给确认有效期，不传阈值：阈值按请求主体的档位从 TIER_POLICY 取，传了就把档位覆盖掉了。
  policy: { confirmTtlSeconds: 120 },
  // 幂等记录保留时长：超时后同一个请求编号可以再用，但不会再回放旧结果。
  idempotencyTtlSeconds: Number.isFinite(Number(process.env.IDEM_TTL_SECONDS)) ? Number(process.env.IDEM_TTL_SECONDS) : 1800,
  hooks: {
    // 调用前：可逆性与来源校验之外的补充拦截。
    beforeTool: ({ tool, slots }) => {
      if (tool === "transfer" && typeof slots.payee === "string" && slots.payee === "") {
        return { allow: false, reason: "收款人为空" };
      }
      return { allow: true };
    },
    // 调用后：真实项目里在这里打点、发通知、写外部审计。
    afterTool: ({ tool, result }) => {
      if (!result.ok) console.log(`[hook] ${tool} 执行失败：${result.error ?? "未知"}`);
    },
  },
  });
}

/**
 * 取（或建）这个客户的 Agent。
 *
 * LRU 用 Map 的插入顺序实现：命中时先删后插，最旧的自然浮到队首。
 * 这样做只是为了不让 10 万个冷账户把内存吃光，**淘汰不等于注销** ——
 * 被踢出去的账户下次进来会从盘上重新载入，账目一个字都不会少。
 */
function agentFor(customer: Customer): Agent {
  const cached = agents.get(customer.userId);
  if (cached !== undefined) {
    agents.delete(customer.userId);
    agents.set(customer.userId, cached);
    return cached;
  }
  const created = createAgent(customer);
  agents.set(customer.userId, created);
  while (agents.size > MAX_CACHED_AGENTS) {
    const oldest = agents.keys().next().value;
    if (oldest === undefined) break;
    agents.delete(oldest);
  }
  return created;
}

/**
 * 身份只从这一处来。
 *
 * 上一版是 `toActor(params[2])` —— 渠道传什么就认什么，等于让客户端自称是别人。
 * 现在令牌换出客户，档位也取目录里的，参数里再传 actor 一律不看。
 */
function actorOf(customer: Customer): Actor {
  return { userId: customer.userId, tier: customer.tier };
}

/**
 * 会话键按客户加前缀，且**只加一次**。
 *
 * 不加前缀的话，u-1002 只要猜中 u-1001 用过的 sessionId，就能接上对方的草稿、
 * 甚至替对方确认一张票。加前缀之后「同一个 sessionId 在两个人身上是两个会话」，
 * 猜到了也没用。
 *
 * 幂等是必须的：chat 返回的 sessionId 已经带前缀了，页面拿着它去 confirm 时会再进来一次，
 * 不判断就变成 `u-1001:u-1001:web:xxx`，两侧键对不上，刚签出的卡就确认不了。
 */
function sessionKey(customer: Customer, sessionId: string): string {
  const prefix = `${customer.userId}:`;
  return sessionId.startsWith(prefix) ? sessionId : prefix + sessionId;
}

/** 阈值覆盖：只认白名单里的数字字段，渠道传别的键一律忽略。演示与压测用。 */
function toPolicy(raw: unknown): Partial<RiskPolicy> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const out: Partial<RiskPolicy> = {};
  const keys: Array<keyof RiskPolicy> = ["singleLimitCents", "dailyLimitCents", "newPayeeRedCents", "frequencyWindowMinutes", "frequencyMaxCount"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** 静态资源：前端构建产物存在就顺带托管，省一个进程。 */
const webDist = path.resolve(here, "..", "..", "web", "dist");

/** 静态资源类型：不映射的话浏览器会拒绝执行脚本。 */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** 一个请求的摸底状态：挂在 res 上，比塞进 trace 上下文干净（上下文只装「谁」，不装「跑到哪」）。 */
interface RequestState {
  path: string;
  startedAt: number;
  method: string;
  recorded: boolean;
}

const requestStates = new WeakMap<import("node:http").ServerResponse, RequestState>();

/**
 * 一次请求只记一次账。
 *
 * 之所以要「只一次」：一个请求可能先被正常 json() 结束，也可能在 catch 里再兜一次，
 * 还可能走到 res.on("close")。三处都记会让 QPS 翻倍 —— 指标说谎比没有指标更糟。
 */
function recordRequest(res: import("node:http").ServerResponse, status: number, error?: string): void {
  const state = requestStates.get(res);
  if (state === undefined || state.recorded) return;
  state.recorded = true;
  if (state.path !== "/rpc") return;
  const elapsed = Number((performance.now() - state.startedAt).toFixed(3));
  rpcRequests.inc({ method: state.method, status: String(status) });
  rpcDuration.observe({ method: state.method }, elapsed);
  const fields: Record<string, unknown> = { status, latencyMs: elapsed };
  if (error !== undefined && error !== "") fields.error = error;
  logger.info("rpc", fields);
}

function json(res: import("node:http").ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  const body = JSON.stringify(payload);
  const failed = typeof payload === "object" && payload !== null && (payload as { ok?: unknown }).ok === false;
  recordRequest(res, status, failed ? String((payload as { error?: unknown }).error ?? "") : undefined);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(body);
}

function handle(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  context: TraceContext,
): void {
  if (req.method === "POST" && req.url === "/rpc") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 65536) req.destroy();
    });
    req.on("end", () => {
      /* 显式再进一次上下文：EventEmitter 的监听器跑在 emit 的上下文里，
         不是在注册它的上下文里。不重新进，traceId 到这一行就断了 ——
         而「断了」的表现是审计里少一个字段，不会报错。 */
      void runWithTrace(context, async () => {
        let body: { method?: unknown; params?: unknown };
        try {
          body = JSON.parse(raw);
        } catch {
          json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
          return;
        }
        const method = typeof body.method === "string" ? body.method : "";
        const params = Array.isArray(body.params) ? body.params : [];
        // 方法名先落进上下文：后面无论走到哪个分支，这条日志都带得出「在办什么」。
        context.method = method;
        annotateTrace({ method });
        const state = requestStates.get(res);
        if (state !== undefined) state.method = method === "" ? "-" : method;

        /**
         * 身份只从令牌来。
         *
         * 没有令牌时落到默认客户，是为了让单用户的旧探针和双击演示不必改；
         * 但它同时意味着「不带令牌 = 林知远」，所以生产环境必须把这一行删掉。
         * 之所以不在这里「猜」一个身份 —— 猜出来的身份等于没有身份。
         */
        const token = String(req.headers["x-siheng-token"] ?? "");
        const customer = token === "" ? DEFAULT_CUSTOMER : customerByToken(token);
        if (customer === null) {
          // 换不出客户就别往下走：既不建 Agent，也不占这个人的配额。
          logger.warn("auth.rejected", { reason: "token-unknown", tokenPresent: token !== "" });
          json(res, 401, { ok: false, error: "令牌无效：换不出客户" });
          return;
        }
        annotateTrace({ userId: customer.userId });

        /**
         * 限流放在建 Agent 之前。
         *
         * 顺序有意义：被拦下的请求不该触发账户装载、不该碰磁盘、不该占内存，
         * 否则限流只挡住了「办事」，没挡住「耗资源」。
         */
        if (buckets !== undefined) {
          const taken = buckets.take(customer.userId);
          if (!taken.ok) {
            rateLimited.inc({ scope: "customer" });
            // Retry-After 用秒，向上取整：给一个「4.2 秒后」的答案等于没说。
            const retrySeconds = Math.max(1, Math.ceil(taken.retryAfterMs / 1000));
            logger.warn("ratelimit.rejected", { userId: customer.userId, retryAfterMs: taken.retryAfterMs });
            json(
              res,
              429,
              { ok: false, error: `请求太频繁：每个客户每分钟 ${Math.round(buckets.refillPerMinute)} 次，请 ${retrySeconds} 秒后再试` },
              { "retry-after": String(retrySeconds) },
            );
            return;
          }
        }

        let agent: Agent;
        try {
          agent = agentFor(customer);
        } catch (error) {
          // 只有这个客户的账出问题，别人照常营业。
          json(res, 503, { ok: false, error: error instanceof StateUnavailable ? error.message : "账户装载失败" });
          return;
        }
        const sid = (index: number): string => sessionKey(customer, String(params[index] ?? ""));
        if (typeof params[0] === "string" && params[0] !== "") annotateTrace({ sessionId: sid(0) });

        try {
          switch (method) {
            case "chat": {
              const text = String(params[1] ?? "");
              const reply = await agent.chat(sid(0), text, actorOf(customer), toPolicy(params[3]), typeof params[4] === "string" ? params[4] : undefined);
              decisionsTotal.inc({ level: reply.decision.level });
              idempotencyTotal.inc({ kind: reply.idempotent ?? "first" });
              if (reply.loop !== undefined) {
                llmTokens.inc({ kind: "prompt" }, reply.loop.promptTokens);
                llmTokens.inc({ kind: "completion" }, reply.loop.completionTokens);
              }
              logger.info("chat", {
                scene: reply.scene,
                // 字段名不能叫 level：那是日志自己的级别，同名会把 INFO 覆盖成 GREEN。
                decision: reply.decision.level,
                rules: reply.decision.hits.map((hit) => hit.rule),
                auditSeq: reply.audit.seq,
                missing: reply.missing,
                intentSource: reply.intentSource,
                loopSteps: reply.loop?.steps ?? 0,
                loopLatencyMs: reply.loop?.latencyMs ?? 0,
                idempotent: reply.idempotent ?? "first",
                // 只放脱敏后的前 80 字：能对上审计里那条记录，又不至于把日志变成账本。
                userText: logText(redact(text)),
              });
              json(res, 200, { ok: true, result: reply });
              return;
            }
            case "confirm": {
              const reply = await agent.confirm(sid(0), String(params[1] ?? ""), typeof params[2] === "string" ? params[2] : undefined);
              decisionsTotal.inc({ level: reply.decision.level });
              idempotencyTotal.inc({ kind: reply.idempotent ?? "first" });
              const executed = reply.execution?.ok === true;
              confirmTotal.inc({ outcome: executed ? "executed" : "rejected" });
              logger.info("confirm", { decision: reply.decision.level, executed, auditSeq: reply.audit.seq });
              json(res, 200, { ok: true, result: reply });
              return;
            }
            case "plan":
              // 只拆解不执行：展示「一句话被拆成了哪几步、每步什么颜色」。
              json(res, 200, { ok: true, result: agent.explainPlan(sid(0), actorOf(customer)) });
              return;
            case "cancel":
              json(res, 200, { ok: true, result: agent.cancel(sid(0)) });
              return;
            case "state":
              // 只返回调用者自己的账户。多客户之后「看谁的账」由令牌决定，参数无权指定。
              json(res, 200, {
                ok: true,
                result: {
                  ...agent.snapshot(),
                  identity: { userId: customer.userId, name: customer.name, tier: customer.tier, tierLabel: TIER_LABEL[customer.tier] },
                },
              });
              return;
            case "directory":
              // 姓名可见、金额不可见：只给名册，不给任何账户数字。
              json(res, 200, {
                ok: true,
                result: {
                  entries: publicDirectory(),
                  me: { userId: customer.userId, name: customer.name, tier: customer.tier, tierLabel: TIER_LABEL[customer.tier] },
                },
              });
              return;
            case "reset":
              json(res, 200, { ok: true, result: agent.reset() });
              return;
            case "audit":
              json(res, 200, {
                ok: true,
                result: agent.auditLog(typeof params[0] === "string" ? sid(0) : undefined, Number(params[1] ?? 20)),
              });
              return;
            case "tamper":
              // 演示接口：默认关闭，只有显式 DEMO_TAMPER=on 才允许改审计。
              if (process.env.DEMO_TAMPER !== "on") {
                json(res, 403, { ok: false, error: "篡改演示接口未开启（需要 DEMO_TAMPER=on）" });
                return;
              }
              json(res, 200, { ok: true, result: agent.tamper(Number(params[0] ?? 0), String(params[1] ?? "（被篡改）")) });
              return;
            case "tick":
              // 调度一拍：把到期的生日礼遇下车。可传 ISO 时间做确定性验收。
              json(res, 200, {
                ok: true,
                result: agent.tick(typeof params[0] === "string" && params[0] !== "" ? new Date(params[0]).getTime() : Date.now()),
              });
              return;
            case "handoffs":
              // 人工侧视角：待处理的有哪些、读数是多少。这是「回写」的入口，没有它就等于只转不办。
              json(res, 200, {
                ok: true,
                result: {
                  rows: agent.handoffBoard.list({
                    state: params[0] === "open" || params[0] === "claimed" || params[0] === "closed" ? params[0] : undefined,
                    sessionId: typeof params[1] === "string" && params[1] !== "" ? sid(1) : undefined,
                    limit: Number(params[2] ?? 20),
                  }),
                  metrics: agent.handoffBoard.metrics(),
                },
              });
              return;
            case "handoff.claim":
              json(res, 200, { ok: true, result: agent.handoffBoard.claim(String(params[0] ?? ""), String(params[1] ?? "未署名")) });
              return;
            case "handoff.close":
              json(res, 200, {
                ok: true,
                result: agent.handoffBoard.close(
                  String(params[0] ?? ""),
                  String(params[1] ?? "no-action") as HandoffResolution,
                  String(params[2] ?? ""),
                  typeof params[3] === "string" ? params[3] : undefined,
                ),
              });
              return;
            case "handoff.sweep":
              // 超时结案：交给调度器每分钟拍一次。结论记 no-action，不假装有人处置过。
              json(res, 200, {
                ok: true,
                result: agent.handoffBoard.sweep(typeof params[0] === "string" && params[0] !== "" ? new Date(params[0]).getTime() : Date.now()),
              });
              return;
            case "health":
              json(res, 200, {
                ok: true,
                result: {
                  track: "pi",
                  model: { ...agent.transportInfo, baseUrl: settings.baseUrl, maxTokens: settings.maxTokens, thinking: settings.thinking },
                  loop: { narrate: process.env.LLM_NARRATE !== "off", maxSteps: Number(process.env.LLM_LOOP_STEPS ?? 1) },
                  usage: transport.usage?.() ?? null,
                  external: { fx: fx.info(), risk: risk === undefined ? { name: "bank-risk", enabled: false } : { ...risk.info(), enabled: true } },
                  accountDay: { ...accountDay, label: accountDay.cutoffHour === 0 ? "自然日零点切" : `${accountDay.cutoffHour} 点切` },
                  uptime: process.uptime(),
                // 运维面上的四件事：怎么追一次请求、指标在哪、日志什么格式、限流开没开。
                // 写进 health 是为了让它出现在监控面板上，而不是只活在 README 里。
                observability: {
                  traceHeader: "x-trace-id",
                  metricsPath: "/metrics",
                  metricsAuth: (process.env.METRICS_TOKEN ?? "") === "" ? "loopback-only" : "bearer",
                  logFormat,
                  logLevel,
                  rateLimit:
                    buckets === undefined
                      ? { enabled: false }
                      : { enabled: true, perMinute: buckets.refillPerMinute, burst: buckets.burst, buckets: buckets.size },
                },
                  // 落盘状态如实报：装载了几条、坏了几行、链是否完整。
                  persistence:
                    store === undefined
                      ? { enabled: false }
                      : {
                          enabled: true,
                          ...store.info(),
                          loadedRecords: restoredRecords.length,
                          corruptLines: auditAtBoot?.corrupt ?? 0,
                          chain: chain.verify(),
                        },
                  // 幂等日志：条数与保留时长。重复提交靠它回放，不靠记忆。
                  idempotency: agent.idempotencyInfo,
                  // 转人工：待处理几张、回写率多少。写进健康检查，等于让它出现在监控面板上。
                  handoff: agent.handoffBoard.metrics(),
                  tiers: (Object.keys(TIER_POLICY) as Array<keyof typeof TIER_POLICY>).map((tier) => ({
                    tier,
                    label: TIER_LABEL[tier],
                    singleLimitCents: TIER_POLICY[tier].singleLimitCents,
                    dailyLimitCents: TIER_POLICY[tier].dailyLimitCents,
                  })),
                },
              });
              return;
            default:
              json(res, 404, { ok: false, error: `未实现的方法：${method}` });
              return;
          }
        } catch (error) {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : "处理失败" });
        }
      });
    });
    return;
  }

  if (req.method === "GET" && existsSync(webDist)) {
    /* 先剥查询串再判断根路径。上一版只对 `"/"` 做了特判，于是 `/?live=1`
       会落到「以目录当文件读」那条路：Windows 上 readFileSync(目录) 抛 EISDIR，
       被外层 catch 成 500；不抛的那次则是 200 + 0 字节，浏览器直接白屏。
       带个参数就白屏，而演示站偏偏要用 `?live=1` 切真进程 —— 所以必须修。 */
    const target = (req.url ?? "/").split("?")[0] || "/";
    const file = path.join(webDist, target === "/" ? "/index.html" : target);
    if (file.startsWith(webDist) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
  }

  json(res, 404, { ok: false, error: "未找到" });
}

/** 审计链校验结果：启动时算一次。运行期只追加，已有记录不会变，链不会自己断也不会自己接上。 */
const chainAtBoot = chain.verify();

/**
 * 探针分两个，不是图省事合成一个。
 *
 * /live 只回答「这个进程还活着吗」：不碰磁盘、不碰状态、退出中也照旧 200。
 * 合成一个的后果是：优雅退出时探针失败，调度以为进程挂了，重启它 ——
 * 于是永远退不干净。
 *
 * /ready 回答「现在派活给它，它接得住吗」：落盘目录写不进去、状态文件读坏了
 * 回落初始值、正在退出，这三种都该摘流量。
 */
const shutdownTimeoutMs = Number.isFinite(Number(process.env.SHUTDOWN_TIMEOUT_MS))
  ? Number(process.env.SHUTDOWN_TIMEOUT_MS)
  : 10000;

const shutdown = new Shutdown({
  timeoutMs: shutdownTimeoutMs,
  close: () => {
    // 停监听 + 关空闲连接：新连接进不来，卡在 keep-alive 上的空连接不会拖住退出。
    server.close();
    server.closeIdleConnections();
  },
});

function handleProbe(pathname: string, res: import("node:http").ServerResponse): void {
  if (pathname === "/live") {
    json(res, 200, { ok: true, alive: true, phase: shutdown.phaseName, uptime: Number(process.uptime().toFixed(3)) });
    return;
  }

  /* 幂等日志是「一个 Agent 一份」的，这里只报汇总。
     早先这里写的是 `agent.idempotencyInfo`，而顶层根本没有 `agent` 这个变量 ——
     /ready 一被打就 ReferenceError，进程直接退。之所以一直没暴露：探针只被人调过 /live，
     CI 的健康检查也接的是 /live。**写了但没人接的东西，等于没写**。 */
  const idempotency = { entries: 0, ttlSeconds: 0, agents: agents.size };
  for (const item of agents.values()) {
    const info = item.idempotencyInfo;
    idempotency.entries += info.entries;
    idempotency.ttlSeconds = info.ttlSeconds;
  }

  const checks: Record<string, unknown> = {
    phase: shutdown.phaseName,
    inflight: shutdown.businessCount,
    stateOrigin,
    audit: { loaded: restoredRecords.length, corruptLines: auditAtBoot?.corrupt ?? 0, ...chainAtBoot },
    idempotency,
  };

  if (shutdown.draining) {
    json(res, 503, { ok: false, ready: false, reason: "正在退出，不再接新请求", checks });
    return;
  }
  if (stateOrigin === "fallback") {
    // 不拦业务，只如实报：进程还在跑，但它记的余额是初始值，不是用户的钱。
    json(res, 503, { ok: false, ready: false, reason: "状态文件存在但读不出来，已回落到初始状态", checks });
    return;
  }
  if (store !== undefined) {
    const writable = store.checkWritable();
    checks.persistence = { enabled: true, dir: store.dir, writable: writable.ok, error: writable.error ?? null };
    if (!writable.ok) {
      json(res, 503, { ok: false, ready: false, reason: `落盘目录不可写：${writable.error ?? "未知"}`, checks });
      return;
    }
  } else {
    checks.persistence = { enabled: false };
  }
  json(res, 200, { ok: true, ready: true, checks });
}

/**
 * 抓取接口放不放开，取决于「谁在抓」。
 *
 * 默认只认回环：本机 curl、docker exec 里的 curl、同 pod 的 sidecar 都能抓。
 * 监控系统从别的机器抓，就必须设 METRICS_TOKEN 并带 Bearer —— 指标里虽然不含
 * 金额和姓名，但请求量、拒绝率、工单积压这些数，本身就是攻击者的地图。
 */
function metricsAllowed(req: import("node:http").IncomingMessage): boolean {
  const expected = process.env.METRICS_TOKEN ?? "";
  if (expected !== "") return String(req.headers.authorization ?? "") === `Bearer ${expected}`;
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function handleMetrics(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  if (!metricsAllowed(req)) {
    logger.warn("metrics.rejected", { remote: req.socket.remoteAddress ?? "unknown" });
    json(res, 401, { ok: false, error: "指标接口需要令牌（METRICS_TOKEN）或从本机访问" });
    return;
  }
  // 渲染失败不抛：抓取端拿到 500 会把整个服务判死，宁可少一行也要给出 200。
  let body = "";
  try {
    body = metrics.render();
  } catch (error) {
    logger.error("metrics.render_failed", { error: error instanceof Error ? error.message : "未知" });
    body = "# metrics render failed\n";
  }
  if ((req.url ?? "").includes("format=json")) {
    json(res, 200, { ok: true, result: metrics.toJSON() });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const server = createServer((req, res) => {
  const pathname = (req.url ?? "").split("?")[0];
  /**
   * traceId 从进门就给。
   *
   * 上游（网关、渠道适配层）已经生成的话就沿用它的 —— 一条链路只有一个 id，
   * 中间再生成一次等于把「跨服务追一笔」这件事做废。只有没有的时候才自己造。
   * 值必须是短十六进制：这是要写进日志、回给客户端的字段，不能是任意字符串。
   */
  const incoming = String(req.headers["x-trace-id"] ?? "");
  const traceId = /^[0-9a-zA-Z-]{8,64}$/.test(incoming) ? incoming : newTraceId();
  res.setHeader("x-trace-id", traceId);
  requestStates.set(res, { path: pathname, startedAt: performance.now(), method: "-", recorded: false });
  const context: TraceContext = { traceId, startedAt: Date.now() };

  runWithTrace(context, () => {
    const isProbe = req.method === "GET" && (pathname === "/live" || pathname === "/ready");

    if (isProbe) {
      // 探针也要登记在途：退出的那几秒里探针还在打，不计数就会被当成「已经没人了」提前退出。
      // 但它单独计，「还有几笔没办完」那个数里不该有它。
      shutdown.track();
      res.on("close", () => shutdown.untrack());
      handleProbe(pathname, res);
      return;
    }

    // 抓取不进业务在途计数：它不读状态、不写盘，不该拖住优雅退出。
    if (req.method === "GET" && pathname === "/metrics") {
      handleMetrics(req, res);
      return;
    }

    if (!shutdown.enter()) {
      json(res, 503, { ok: false, error: "服务正在退出，不再接新请求", phase: shutdown.phaseName });
      return;
    }
    res.on("close", () => shutdown.leave());
    try {
      handle(req, res, context);
    } catch (error) {
      // 兜底：handler 抛出去会让这个请求永远不 close，在途计数就再也回不到零，
      // 退出时会白等到超时。所以这里必须收口。
      const message = error instanceof Error ? error.message : "处理失败";
      if (res.headersSent) {
        res.end();
      } else {
        json(res, 500, { ok: false, error: message });
      }
    }
  });
});

/** 信号接线：SIGTERM 编排系统发，SIGINT 是 Ctrl-C，走同一条软切路径。 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown.begin(signal));
}

server.listen(port, host, () => {
  const primer = agentFor(DEFAULT_CUSTOMER);
  const model = primer.transportInfo.available ? primer.transportInfo.model : "规则模式（未配置模型密钥）";
  const exposed = host === "127.0.0.1" || host === "::1" ? host : `${host}（对外监听）`;
  console.log(`pi 路线已启动：http://${exposed}:${port}/　模型：${model}`);
  console.log(`[probe] GET /live 只看进程活着，GET /ready 看能不能派活　退出等待上限 ${shutdownTimeoutMs}ms`);
  console.log(
    `[obs] 指标 GET /metrics（${(process.env.METRICS_TOKEN ?? "") === "" ? "仅本机可抓" : "需 Bearer 令牌"}）　日志 ${logFormat}　级别 ${logLevel}`,
  );
  console.log(
    `[obs] 限流 ${buckets === undefined ? "已关闭（RATE_LIMIT_PER_MINUTE=0）" : `每客户 ${buckets.refillPerMinute} 次/分钟，突发 ${buckets.burst} 次`}`,
  );
  if (store === undefined) {
    console.log("[store] 落盘已关闭（PERSIST=off），重启即回到初始状态");
  } else {
    const chainState = chain.verify();
    console.log(
      `[store] ${store.dir}　装载审计 ${restoredRecords.length} 条` +
        `${auditAtBoot?.corrupt === undefined || auditAtBoot.corrupt === 0 ? "" : `（坏行 ${auditAtBoot.corrupt} 条已跳过）`}` +
        `　链${chainState.ok ? "完整" : `在第 ${chainState.brokenAt} 条断裂`}　状态${
          stateOrigin === "disk" ? "已从磁盘恢复" : stateOrigin === "fallback" ? "读不出来，按初始值强行启动" : "从初始值开始"
        }`,
    );
  }
  // 预热外部服务：拉起来走一次只读调用，health 里就能如实显示是否可用；失败也不影响启动。
  void fx.call("list_currencies", {}).then((result) => {
    console.log(`[mcp] bank-fx ${result.ok ? "就绪" : `不可用（${result.error ?? "未知"}）`}`);
  });
  if (risk === undefined) {
    console.log("[mcp] bank-risk 已关闭（MCP_RISK_OFF=1），转账不做外部取证");
  } else {
    void risk.call("screen_payee", { name: "小王", amountCents: 10000 }).then((result) => {
      console.log(`[mcp] bank-risk ${result.ok ? "就绪" : `不可用（${result.error ?? "未知"}），转账将按降级策略要求确认`}`);
    });
  }
  // 目录里的客户先全部装进来：调度器只拍「已在内存里」的账户，
  // 冷账户不预装的话，他的生日单永远等不到那一拍。演示规模只有几个人，装得起。
  for (const item of CUSTOMERS) {
    try {
      agentFor(item);
    } catch (error) {
      console.warn(`[boot] ${item.name}（${item.userId}）装载失败：${error instanceof Error ? error.message : "未知"}`);
    }
  }

  // 生日礼遇调度：每 60 秒看一次有没有到期的单子。
  // 用进程内定时器而不是外部 cron，是为了一条命令就能跑起来；
  // unref 是为了不让它把进程钉住无法退出。
  const tickAll = (label: string): void => {
    for (const [userId, item] of agents) {
      for (const task of item.tick().ordered) console.log(`[scheduler] ${label} ${userId}：${task.message}`);
    }
  };
  const timer = setInterval(() => tickAll("每分钟"), 60000);
  timer.unref();
  // 启动先补一拍：进程可能几天没开，错过的时间点要补上。
  tickAll("启动补拍");
});
