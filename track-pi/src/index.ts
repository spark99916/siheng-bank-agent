import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import type { Actor, RiskPolicy } from "../../shared/rules.ts";
import { AuditChain, DEFAULT_ACTOR, TIER_LABEL, TIER_POLICY } from "../../shared/rules.ts";
import type { AuditRecord } from "../../shared/rules.ts";
import { McpClient } from "../../shared/mcp-client.ts";
import { FileStore } from "../../shared/persist.ts";
import { initialState } from "../../shared/state.ts";
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
const state = store?.readState() ?? initialState();
const chain = new AuditChain(store, restoredRecords);
const settings = readTransportSettings();
const transport = settings.apiKey === "" ? createOfflineTransport() : createHttpTransport(settings);

/** 外部汇率服务：stdio 子进程，默认 3 秒超时，挂了不影响内置工具。 */
const fx = new McpClient("bank-fx", {
  command: process.execPath,
  args: [path.resolve(here, "..", "..", "mcp", "fx-server.mjs")],
  timeoutMs: Number(process.env.MCP_FX_TIMEOUT_MS ?? 3000),
});

const agent = new Agent({
  state,
  transport,
  chain,
  fx,
  store,
  useModel: process.env.USE_MODEL !== "off",
  // 只给确认有效期，不传阈值：阈值按请求主体的档位从 TIER_POLICY 取，传了就把档位覆盖掉了。
  policy: { confirmTtlSeconds: 120 },
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

const server = createServer((req, res) => {
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
              result: await agent.chat(String(params[0] ?? ""), String(params[1] ?? ""), toActor(params[2]), toPolicy(params[3])),
            });
            return;
          case "confirm":
            json(res, 200, { ok: true, result: await agent.confirm(String(params[0] ?? ""), String(params[1] ?? "")) });
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
          case "health":
            json(res, 200, {
              ok: true,
              result: {
                track: "pi",
                model: agent.transportInfo,
                external: fx.info(),
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
});

server.listen(port, "127.0.0.1", () => {
  const model = agent.transportInfo.available ? agent.transportInfo.model : "规则模式（未配置模型密钥）";
  console.log(`pi 路线已启动：http://127.0.0.1:${port}/　模型：${model}`);
  if (store === undefined) {
    console.log("[store] 落盘已关闭（PERSIST=off），重启即回到初始状态");
  } else {
    const chainState = chain.verify();
    console.log(
      `[store] ${store.dir}　装载审计 ${restoredRecords.length} 条` +
        `${auditAtBoot?.corrupt === undefined || auditAtBoot.corrupt === 0 ? "" : `（坏行 ${auditAtBoot.corrupt} 条已跳过）`}` +
        `　链${chainState.ok ? "完整" : `在第 ${chainState.brokenAt} 条断裂`}　状态${store.readState() === null ? "从初始值开始" : "已从磁盘恢复"}`,
    );
  }
  // 预热外部服务：拉起来走一次只读调用，health 里就能如实显示是否可用；失败也不影响启动。
  void fx.call("list_currencies", {}).then((result) => {
    console.log(`[mcp] bank-fx ${result.ok ? "就绪" : `不可用（${result.error ?? "未知"}）`}`);
  });
});
