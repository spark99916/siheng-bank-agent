import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { AuditChain, DEFAULT_RISK_POLICY } from "../../shared/rules.ts";
import { McpClient } from "../../shared/mcp-client.ts";
import { initialState } from "../../shared/state.ts";
import { createHttpTransport, createOfflineTransport, readTransportSettings } from "./transport.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 18150);

/** 装配：状态、审计、传输、代理。三段式的接线都在这里，一眼看完。 */
const state = initialState();
const chain = new AuditChain();
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
  useModel: process.env.USE_MODEL !== "off",
  policy: { ...DEFAULT_RISK_POLICY, confirmTtlSeconds: 120 },
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
            json(res, 200, { ok: true, result: await agent.chat(String(params[0] ?? ""), String(params[1] ?? "")) });
            return;
          case "confirm":
            json(res, 200, { ok: true, result: await agent.confirm(String(params[0] ?? ""), String(params[1] ?? "")) });
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
            json(res, 200, { ok: true, result: agent.auditLog(params[0] as string | undefined, Number(params[1] ?? 20)) });
            return;
          case "health":
            json(res, 200, { ok: true, result: { track: "pi", model: agent.transportInfo, external: fx.info(), uptime: process.uptime() } });
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
  // 预热外部服务：拉起来走一次只读调用，health 里就能如实显示是否可用；失败也不影响启动。
  void fx.call("list_currencies", {}).then((result) => {
    console.log(`[mcp] bank-fx ${result.ok ? "就绪" : `不可用（${result.error ?? "未知"}）`}`);
  });
});
