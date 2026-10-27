#!/usr/bin/env node
// 通用 webhook 渠道：任何能发 HTTP 的平台都能接。

import { createServer } from "node:http";

/**
 * 启动 webhook 渠道。
 * @param {{ port?: number, chat: (sessionId: string, text: string) => Promise<unknown>, host?: string }} options
 */
export function startWebhookChannel(options) {
  const port = options.port ?? 18140;
  const host = options.host ?? "127.0.0.1";

  /** 去重表：同一条消息十秒内只处理一次。 */
  const seen = new Map();

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "只接受 POST" }));
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 32768) req.destroy();
    });

    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "请求体不是合法 JSON" }));
        return;
      }

      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (userId === "" || text === "") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "userId 与 text 都不能为空" }));
        return;
      }

      const dedupeKey = `${userId}:${text}`;
      const cached = seen.get(dedupeKey);
      if (cached !== undefined && Date.now() - cached.at < 10000) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(cached.value));
        return;
      }

      const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : `webhook:${userId}`;
      try {
        const reply = await options.chat(sessionId, text);
        const payload = {
          reply: reply.reply ?? "",
          level: reply.decision?.level ?? "unknown",
          auditSeq: reply.audit?.seq ?? 0,
        };
        seen.set(dedupeKey, { at: Date.now(), value: payload });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "处理失败" }));
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`webhook 渠道已启动：http://${host}:${port}/`);
  });

  return server;
}
