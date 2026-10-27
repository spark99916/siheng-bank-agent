# 路线 B：pi 三段式

按 pi 的架构范式抽离的最小实现。三段职责清晰，加能力只加钩子，不改主循环。

## 三段是什么

| 段 | 文件 | 只负责 |
|---|---|---|
| Agent | `src/agent.ts` | 状态、事件、循环、钩子调度 |
| Transport | `src/transport.ts` | 发请求、收结果、超时、离线回退 |
| Extension | `src/rules.ts` + 钩子 | 意图、判定、令牌、审计 |

加上 `src/state.ts` 放领域数据与工具执行，`src/index.ts` 做接线。

## 与官方包的关系

这份实现按 pi-agent-core 的 `AgentOptions` 对齐，想换成官方包时替换三处即可。

| 本包 | 官方包对应 |
|---|---|
| `transport.complete()` | `streamFn` |
| `hooks.beforeTool` | `beforeToolCall` |
| `hooks.afterTool` | `afterToolCall` |

状态对象 `AgentState`、消息转换 `convertToLlm`、上下文改写 `transformContext` 的语义与官方一致。

不直接用官方包的原因：官方 `StreamFn` 要求返回 `AssistantMessageEventStream`，接第三方 OpenAI 兼容接口需要额外适配层。学习阶段先跑通范式，接生产再换。

## 跑起来

```powershell
cd track-pi
npm start
```

默认 `http://127.0.0.1:18150`。

没配模型密钥时自动进入规则模式，六类说法仍能演示。配了密钥则规则优先、模型兜底。

```powershell
$env:DEEPSEEK_API_KEY="你的密钥"
$env:LLM_MODEL="deepseek-flash"
npm start
```

## 接口

HTTP 单入口 `/rpc`，POST，body 是 `{ method, params }`。

| method | params | 说明 |
|---|---|---|
| `chat` | `[sessionId, text]` | 一次对话 |
| `confirm` | `[sessionId, token]` | 确认待办 |
| `cancel` | `[sessionId]` | 取消待办 |
| `state` | `[]` | 账户快照 |
| `audit` | `[sessionId?, limit?]` | 审计记录与链校验 |
| `health` | `[]` | 健康检查 |

## 钩子怎么写

加一条拦截规则，不动主循环。

```ts
new Agent({
  // ...
  hooks: {
    beforeTool: ({ tool, slots }) => {
      if (tool === "transfer" && (slots.amountCents as number) > 300000) {
        return { allow: false, reason: "自定义阈值：超过 3000 元需柜面" };
      }
      return { allow: true };
    },
  },
});
```

加一个埋点也是同一处。

```ts
afterTool: ({ tool, result }) => {
  metrics.push({ tool, ok: result.ok, at: Date.now() });
},
```

## 魔改建议

按这个顺序改，每次改完跑一遍对话。

一、换工具集：改 `state.ts` 的 `executeTool` 分支与 `rules.ts` 的 `SPECS`。

二、换判定：改 `rules.ts` 的 `evaluate`，记得每条规则带名字。

三、接模型：换 `transport.ts` 的 `createHttpTransport` 里的地址与模型名。

四、加场景：加一条规则分支，加一个工具，加一条判定画像。三处都改，不要只改一处。

## 注意

`Agent.chat` 里所有分支都写了审计，新增分支必须补上，否则链会断。

判定与执行必须分开。判定只看意图与状态，执行只改数据，不许在判定里写数据。

模型返回的工具名要过白名单。`specOf` 查不到就直接丢弃，不要猜。
