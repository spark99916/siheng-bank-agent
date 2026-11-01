import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import type { AccountDayConfig, Actor, RiskPolicy } from "../../shared/rules.ts";
import { AuditChain, DEFAULT_ACTOR, TIER_LABEL, TIER_POLICY } from "../../shared/rules.ts";
import type { AuditRecord } from "../../shared/rules.ts";
import { McpClient } from "../../shared/mcp-client.ts";
import { FileStore } from "../../shared/persist.ts";
import { initialState } from "../../shared/state.ts";
import { Shutdown } from "./lifecycle.ts";
import { createHttpTransport, createOfflineTransport, readTransportSettings } from "./transport.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 18150);

/**
 * 落盘开关：PERSIST=off 退回纯内存（一次性演示、压测用）。
 * 默认写 data/（已在 .gitignore 里），路径可用 DATA_DIR 改。
 */
const persistOn = process.env.PERSIST !== "off";
const dataDir = process.env.DATA_DIR ?? path.resolve(here, "..", "..", "data");
const store = persistOn ? new FileStore(dataDir) : undefined;

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

/** 装配：状态、审计、传输、代理。三段式的接线都在这里，一眼看完。 */
const loadedState = store?.loadState();

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
  console.error(`[store] 拒绝启动：${store?.dir}/state.json 存在，但读不出来`);
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

const state = loadedState === undefined || loadedState.kind === "corrupt" ? initialState() : loadedState.state;

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

const agent = new Agent({
  state,
  transport,
  chain,
  fx,
  risk,
  store,
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

/** 主体解析：渠道传来的身份只当数据用，档位不认识就退回普通档，不猜。 */
function toActor(raw: unknown): Actor {
  if (raw === null || typeof raw !== "object") return DEFAULT_ACTOR;
  const input = raw as { userId?: unknown; tier?: unknown };
  const userId = typeof input.userId === "string" && input.userId !== "" ? input.userId : DEFAULT_ACTOR.userId;
  const tier = input.tier === "standard" || input.tier === "gold" || input.tier === "private" ? input.tier : DEFAULT_ACTOR.tier;
  return { userId, tier };
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

function json(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  if (req.method === "POST" && req.url === "/rpc") {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 65536) req.destroy();
    });
    req.on("end", async () => {
      let body: { method?: unknown; params?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
        return;
      }
      const method = typeof body.method === "string" ? body.method : "";
      const params = Array.isArray(body.params) ? body.params : [];
      try {
        switch (method) {
          case "chat":
            json(res, 200, {
              ok: true,
              result: await agent.chat(
                String(params[0] ?? ""),
                String(params[1] ?? ""),
                toActor(params[2]),
                toPolicy(params[3]),
                typeof params[4] === "string" ? params[4] : undefined,
              ),
            });
            return;
          case "confirm":
            json(res, 200, {
              ok: true,
              result: await agent.confirm(String(params[0] ?? ""), String(params[1] ?? ""), typeof params[2] === "string" ? params[2] : undefined),
            });
            return;
          case "plan":
            // 只拆解不执行：展示「一句话被拆成了哪几步、每步什么颜色」。
            json(res, 200, { ok: true, result: agent.explainPlan(String(params[0] ?? ""), toActor(params[1])) });
            return;
          case "cancel":
            json(res, 200, { ok: true, result: agent.cancel(String(params[0] ?? "")) });
            return;
          case "state":
            json(res, 200, { ok: true, result: agent.snapshot() });
            return;
          case "reset":
            json(res, 200, { ok: true, result: agent.reset() });
            return;
          case "audit":
            json(res, 200, {
              ok: true,
              result: agent.auditLog(typeof params[0] === "string" ? params[0] : undefined, Number(params[1] ?? 20)),
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
    return;
  }

  if (req.method === "GET" && existsSync(webDist)) {
    const target = req.url === "/" || req.url === undefined ? "/index.html" : req.url.split("?")[0];
    const file = path.join(webDist, target);
    if (file.startsWith(webDist) && existsSync(file) && !file.endsWith("/")) {
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

  const checks: Record<string, unknown> = {
    phase: shutdown.phaseName,
    inflight: shutdown.businessCount,
    stateOrigin,
    audit: { loaded: restoredRecords.length, corruptLines: auditAtBoot?.corrupt ?? 0, ...chainAtBoot },
    idempotency: agent.idempotencyInfo,
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

const server = createServer((req, res) => {
  const pathname = (req.url ?? "").split("?")[0];
  const isProbe = req.method === "GET" && (pathname === "/live" || pathname === "/ready");

  if (isProbe) {
    // 探针也要登记在途：退出的那几秒里探针还在打，不计数就会被当成「已经没人了」提前退出。
    // 但它单独计，「还有几笔没办完」那个数里不该有它。
    shutdown.track();
    res.on("close", () => shutdown.untrack());
    handleProbe(pathname, res);
    return;
  }

  if (!shutdown.enter()) {
    json(res, 503, { ok: false, error: "服务正在退出，不再接新请求", phase: shutdown.phaseName });
    return;
  }
  res.on("close", () => shutdown.leave());
  try {
    handle(req, res);
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

/** 信号接线：SIGTERM 编排系统发，SIGINT 是 Ctrl-C，走同一条软切路径。 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown.begin(signal));
}

server.listen(port, "127.0.0.1", () => {
  const model = agent.transportInfo.available ? agent.transportInfo.model : "规则模式（未配置模型密钥）";
  console.log(`pi 路线已启动：http://127.0.0.1:${port}/　模型：${model}`);
  console.log(`[probe] GET /live 只看进程活着，GET /ready 看能不能派活　退出等待上限 ${shutdownTimeoutMs}ms`);
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
  // 生日礼遇调度：每 60 秒看一次有没有到期的单子。
  // 用进程内定时器而不是外部 cron，是为了一条命令就能跑起来；
  // unref 是为了不让它把进程钉住无法退出。
  const timer = setInterval(() => {
    for (const item of agent.tick().ordered) console.log(`[scheduler] ${item.message}`);
  }, 60000);
  timer.unref();
  // 启动先补一拍：进程可能几天没开，错过的时间点要补上。
  for (const item of agent.tick().ordered) console.log(`[scheduler] ${item.message}`);
});
