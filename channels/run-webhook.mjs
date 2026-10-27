#!/usr/bin/env node
// 通用 webhook 渠道的启动器：把消息转发给已在跑的智能体，自己不做任何业务判定。
// 用法：node channels/run-webhook.mjs
// 环境变量：WEBHOOK_PORT（默认 18140）、AGENT_RPC（默认 http://127.0.0.1:18150/rpc）

import { startWebhookChannel } from "./generic-webhook.mjs";

const upstream = process.env.AGENT_RPC ?? "http://127.0.0.1:18150/rpc";
const port = Number(process.env.WEBHOOK_PORT ?? 18140);

/** 只做转发：文本进、智能体的原始结果出。颜色由判定层给，渠道层不参与。 */
async function chat(sessionId, text) {
  const response = await fetch(upstream, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "chat", params: [sessionId, text] }),
  });
  const payload = await response.json();
  if (payload.ok !== true) throw new Error(payload.error ?? "上游返回失败");
  return payload.result;
}

startWebhookChannel({ port, chat });
