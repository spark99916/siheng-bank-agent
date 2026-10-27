# 渠道适配

两个渠道，都只做「收、转、发」三件事，不碰业务判定。

## 通用 webhook

```js
import { startWebhookChannel } from "./generic-webhook.mjs";

startWebhookChannel({
  port: 18140,
  chat: (sessionId, text) => agent.chat(sessionId, text),
});
```

请求与响应。

```
POST /
{ "userId": "u-001", "text": "查一下余额" }

200
{ "reply": "可用余额 38642.50 元", "level": "green", "auditSeq": 1 }
```

十条以内的重复请求会命中缓存，返回同一份结果，不重复执行。

## 企业微信

需要三个环境变量。

```powershell
$env:WECOM_CORP_ID="填写你的企业标识"
$env:WECOM_AGENT_ID="填写你的应用标识"
$env:WECOM_SECRET="填写你的应用密钥"
```

接回调。

```js
import { handleCallback } from "./wecom.mjs";

app.post("/wecom/callback", async (req, res) => {
  const result = await handleCallback(req.body, (sessionId, text) => agent.chat(sessionId, text));
  res.json(result);
});
```

本地演示不开密钥时，第二个参数传 `{ dryRun: true }`，脚本会把要发的包打印到控制台，不真发。

## 会话映射

| 渠道 | sessionId 格式 |
|---|---|
| 通用 webhook | `webhook:{userId}` |
| 企业微信私聊 | `wecom:{userId}` |
| 企业微信群聊 | `wecom:group:{chatId}:{userId}` |

不要用平台消息 ID 当会话标识，会话会被切碎。

## 加一个新渠道

实现两个函数即可。

```ts
function normalize(incoming): { userId, sessionId, text }
function send(userId, text): Promise<void>
```

然后把 `normalize` 的结果交给运行时的 `chat`，把 `chat` 的回复交给 `send`。

在 `CHANGELOG.md` 记一条，在 `docs/04-渠道与交付.md` 的渠道表里加一行。
