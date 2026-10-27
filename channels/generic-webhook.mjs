#!/usr/bin/env node
// 通用 webhook 渠道：任何能发 HTTP 的平台都能接。
// 渠道只做三件事：验签、去重、转发。业务判定一律在后端，渠道层不掺和。

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

/** 幂等窗口：同一条消息五分钟内只处理一次。 */
const IDEMPOTENT_MS = 5 * 60 * 1000;

/**
 * 启动 webhook 渠道。
 * @param {{ port?: number, chat: (sessionId: string, text: string, userId: string) => Promise<any>, host?: string, secret?: string }} options
 */
export function startWebhookChannel(options) {
  const port = options.port ?? 18140;
  const host = options.host ?? "127.0.0.1";
  const secret = options.secret ?? process.env.WEBHOOK_SECRET ?? "";

  const seen = new Map();

  /** 验签：没配密钥就放行并在启动日志里标出来；配了就必须对得上。 */
  function verify(raw, header) {
    if (secret === "") return { ok: true, unsigned: true };
    if (typeof header !== "string" || header === "") return { ok: false, reason: "缺少 x-signature" };
    const expect = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
    const left = Buffer.from(expect, "utf8");
    const right = Buffer.from(header, "utf8");
    if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "签名不匹配" };
    return { ok: true, unsigned: false };
  }

  const reply = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      reply(res, 405, { error: "只接受 POST" });
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 32768) req.destroy();
    });

    req.on("end", async () => {
      const check = verify(raw, req.headers["x-signature"]);
      if (!check.ok) {
        reply(res, 401, { error: check.reason });
        return;
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        reply(res, 400, { error: "请求体不是合法 JSON" });
        return;
      }

      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (userId === "" || text === "") {
        reply(res, 400, { error: "userId 与 text 都不能为空" });
        return;
      }

      // 幂等：平台给了 messageId 就用它，没给才按「用户 + 文本」兜底。
      const key =
        typeof body.messageId === "string" && body.messageId !== "" ? `id:${body.messageId}` : `text:${userId}:${text}`;
      const now = Date.now();
      for (const [item, value] of seen) {
        if (now - value.at > IDEMPOTENT_MS) seen.delete(item);
      }
      const cached = seen.get(key);
      if (cached !== undefined) {
        reply(res, 200, { ...cached.value, deduped: true });
        return;
      }

      const sessionId = typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : `webhook:${userId}`;
      try {
        const result = await options.chat(sessionId, text, userId);
        const payload = {
          reply: result.reply ?? "",
          level: result.decision?.level ?? "unknown",
          auditSeq: result.audit?.seq ?? 0,
        };
        seen.set(key, { at: now, value: payload });
        reply(res, 200, payload);
      } catch (error) {
        // 上游超时或报错时如实返回 502，不自己编一个结果。
        reply(res, 502, { error: error instanceof Error ? error.message : "上游处理失败" });
      }
    });
  });

  server.listen(port, host, () => {
    console.log(
      `webhook 渠道已启动：http://${host}:${port}/　验签：${secret === "" ? "未配置 WEBHOOK_SECRET（仅演示）" : "HMAC-SHA256"}`,
    );
  });

  return server;
}
