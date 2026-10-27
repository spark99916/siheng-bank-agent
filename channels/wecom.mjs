#!/usr/bin/env node
// 企业微信渠道：回调收发、access_token 缓存、去重、dry-run 模式。

/** token 缓存：企业微信 access_token 有效期两小时，提前五分钟刷新。 */
let tokenCache = { value: "", expiresAt: 0 };

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 取 access_token。
 * 缺密钥时抛错，调用方据此切到 dry-run。
 */
export async function getAccessToken() {
  const corpId = readEnv("WECOM_CORP_ID");
  const secret = readEnv("WECOM_SECRET");
  if (corpId === "" || secret === "") {
    throw new Error("缺少 WECOM_CORP_ID 或 WECOM_SECRET");
  }
  if (tokenCache.value !== "" && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const response = await fetch(url);
  const data = await response.json();
  if (data.errcode !== 0 || typeof data.access_token !== "string") {
    throw new Error(`取 token 失败：${data.errmsg ?? "未知原因"}`);
  }
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 7200) - 300) * 1000,
  };
  return tokenCache.value;
}

/**
 * 发文本消息。
 * dryRun 为真时只打印要发的包，不真发，用于本地演示。
 */
export async function sendText({ userId, text, dryRun = false }) {
  const agentId = readEnv("WECOM_AGENT_ID");
  const body = {
    touser: userId,
    msgtype: "text",
    agentid: Number(agentId || 0),
    text: { content: text },
  };
  if (dryRun) {
    console.log("[dry-run] 发送内容：", JSON.stringify(body, null, 2));
    return { ok: true, dryRun: true };
  }
  const token = await getAccessToken();
  const response = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (data.errcode !== 0) {
    throw new Error(`发送失败：${data.errmsg ?? "未知原因"}`);
  }
  return { ok: true, msgId: data.msgid };
}

/**
 * 归一化企业微信回调。
 * 返回 null 表示这条消息不该处理（非文本、缺字段）。
 */
export function normalizeCallback(body) {
  if (body === null || typeof body !== "object") return null;
  const text = typeof body.Content === "string" ? body.Content.trim() : "";
  const from = typeof body.FromUserName === "string" ? body.FromUserName.trim() : "";
  if (text === "" || from === "") return null;
  return { userId: from, sessionId: `wecom:${from}`, text };
}

/**
 * 处理一次回调：归一化、调运行时、回消息。
 * dryRun 时只打印，不真发。
 */
export async function handleCallback(body, chat, options = {}) {
  const request = normalizeCallback(body);
  if (request === null) return { ok: false, reason: "不是可处理的文本消息" };
  const reply = await chat(request.sessionId, request.text);
  const content = `${reply.reply}\n\n判定：${reply.decision?.level ?? "未知"}　审计编号：${reply.audit?.seq ?? 0}`;
  await sendText({ userId: request.userId, text: content, dryRun: options.dryRun === true });
  return { ok: true, sessionId: request.sessionId, level: reply.decision?.level ?? "unknown" };
}
