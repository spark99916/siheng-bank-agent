// Agent 循环的机制单测：用一个假传输层喂确定的响应，验边界而不是验模型。
// 真模型的行为由 scripts/live-agent.mjs 回答，两者不要混。

import assert from "node:assert/strict";
import { test } from "node:test";
import { runLoop } from "../track-pi/src/loop.ts";
import { createHttpTransport, readTransportSettings } from "../track-pi/src/transport.ts";

/** 假传输层：按顺序吐出预设响应，并记下每次调用看到的请求。 */
function scripted(replies, seen = []) {
  let index = 0;
  return {
    model: "scripted",
    available: true,
    seen,
    async complete(messages, tools) {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools: tools.map((tool) => tool.name) });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return {
        content: reply.content ?? "",
        toolCalls: reply.toolCalls ?? [],
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 1,
      };
    },
  };
}

const toolCall = (name, args = "{}") => ({ toolCalls: [{ id: `c-${name}`, name, arguments: args }] });

test("循环：模型给答复即停止，种子步骤被回灌成 assistant + tool 两条消息", async () => {
  const transport = scripted([{ content: "你本月花了 123.00 元。" }]);
  const result = await runLoop({
    transport,
    system: "系统提示",
    user: "这个月花了多少",
    tools: [],
    seed: { tool: "analyze_bills", args: "{}", result: "本月合计 123.00 元" },
    runTool: async () => ({ ok: true, text: "" }),
  });

  assert.equal(result.stopReason, "final");
  assert.equal(result.finalText, "你本月花了 123.00 元。");
  assert.equal(result.toolTurns, 0);
  // 种子进入消息：assistant 带 tool_calls，紧接着一条 role=tool 的结果。
  const sent = transport.seen[0].messages;
  assert.equal(sent.length, 4);
  assert.equal(sent[2].role, "assistant");
  assert.equal(sent[2].toolCalls[0].name, "analyze_bills");
  assert.equal(sent[3].role, "tool");
  assert.equal(sent[3].toolCallId, "seed-0", "工具结果必须挂在种子的那次调用 id 上，否则模型对不上号");
  assert.match(sent[3].content, /123\.00/);
});

test("循环：模型连续调工具时，执行结果被回灌进下一轮", async () => {
  const transport = scripted([
    toolCall("query_balance"),
    toolCall("analyze_bills"),
    { content: "余额 38642.50 元，本月支出见账单。" },
  ]);
  const executed = [];
  const result = await runLoop({
    transport,
    system: "s",
    user: "u",
    tools: [{ name: "query_balance", description: "", parameters: {} }],
    maxSteps: 3,
    runTool: async (name, args) => {
      executed.push(`${name}:${args}`);
      return { ok: true, text: `${name} 的结果` };
    },
  });

  assert.equal(result.stopReason, "final");
  assert.deepEqual(executed, ["query_balance:{}", "analyze_bills:{}"]);
  assert.equal(result.toolTurns, 2);
  // 第三次调用时，前面两次的工具结果都已经在消息里。
  const lastMessages = transport.seen[2].messages;
  assert.ok(lastMessages.some((message) => message.role === "tool" && message.content === "query_balance 的结果"));
  assert.ok(lastMessages.some((message) => message.role === "tool" && message.content === "analyze_bills 的结果"));
});

test("循环：步数用尽强制收口，不会无限转", async () => {
  const transport = scripted([toolCall("query_balance")]);
  const result = await runLoop({
    transport,
    system: "s",
    user: "u",
    tools: [{ name: "query_balance", description: "", parameters: {} }],
    maxSteps: 2,
    runTool: async () => ({ ok: true, text: "结果" }),
  });

  assert.equal(result.stopReason, "max-steps");
  assert.equal(result.toolTurns, 2);
  // 名额用尽那一次必须不带工具：只给「说人话」的机会，模型没法再拖。
  assert.equal(transport.seen.at(-1).tools.length, 0);
});

test("循环：白名单外的工具被拒绝，拒绝原因回灌给模型", async () => {
  const transport = scripted([toolCall("transfer", '{"payee":"小王","amountCents":100}'), { content: "这需要你确认后才能转账。" }]);
  let ran = false;
  const result = await runLoop({
    transport,
    system: "s",
    user: "u",
    tools: [{ name: "transfer", description: "", parameters: {} }],
    maxSteps: 2,
    canCall: (name) => name !== "transfer",
    runTool: async () => {
      ran = true;
      return { ok: true, text: "" };
    },
  });

  assert.equal(ran, false, "被拒绝的工具不允许真的执行");
  assert.equal(result.steps[0].rejected, true);
  const rejection = transport.seen[1].messages.find((message) => message.role === "tool");
  assert.match(rejection.content, /被拒绝/);
  assert.equal(result.stopReason, "final");
});

test("循环：传输层报错如实上报，不伪装成空答复", async () => {
  const transport = {
    model: "broken",
    available: true,
    async complete() {
      throw new Error("模型返回 401：invalid api key");
    },
  };
  const result = await runLoop({ transport, system: "s", user: "u", tools: [], runTool: async () => ({ ok: true, text: "" }) });
  assert.equal(result.stopReason, "error");
  assert.match(result.error, /401/);
  assert.equal(result.finalText, "");
});

test("循环：模型返回空内容算失败，不当作成功答复", async () => {
  const transport = scripted([{ content: "   " }]);
  const result = await runLoop({ transport, system: "s", user: "u", tools: [], runTool: async () => ({ ok: true, text: "" }) });
  assert.equal(result.stopReason, "empty");
  assert.equal(result.finalText, "");
});

test("传输层：没有密钥时 available 为假，调用方据此退回规则模式", () => {
  const transport = createHttpTransport({
    baseUrl: "https://example.invalid/v1",
    apiKey: "",
    model: "deepseek-flash",
    timeoutMs: 1000,
    thinking: false,
    maxTokens: 100,
    retries: 0,
  });
  assert.equal(transport.available, false);
});

test("传输层：内部消息形状被正确翻译成 OpenAI 线格式", async () => {
  // 直接校验 toWire 的产物：字段名错了，模型就看不到工具结果，循环会静默退化。
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const transport = createHttpTransport({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "deepseek-flash",
      timeoutMs: 1000,
      thinking: false,
      maxTokens: 100,
      retries: 0,
    });
    await transport.complete(
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "query_balance", arguments: "{}" }] },
        { role: "tool", content: "余额 100.00 元", toolCallId: "call-1" },
      ],
      [{ name: "query_balance", description: "", parameters: {} }],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const wire = captured[0].messages;
  assert.equal(wire[2].tool_calls[0].type, "function");
  assert.equal(wire[2].tool_calls[0].function.name, "query_balance");
  assert.equal(wire[2].content, null, "带工具调用时 content 必须是 null，不是空串");
  assert.equal(wire[3].tool_call_id, "call-1");
  assert.equal(captured[0].thinking.type, "disabled");
});

test("传输层：429 会重试，4xx 鉴权失败不重试", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "好" } }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const transport = createHttpTransport({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "deepseek-flash",
      timeoutMs: 1000,
      thinking: false,
      maxTokens: 100,
      retries: 1,
    });
    const reply = await transport.complete([{ role: "user", content: "u" }], []);
    assert.equal(reply.content, "好");
    assert.equal(attempts, 2);
    assert.equal(transport.usage().calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 401 只打一次，且错误信息里带响应体，方便区分「密钥错」与「模型名错」。
  let authAttempts = 0;
  globalThis.fetch = async () => {
    authAttempts += 1;
    return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  };
  try {
    const transport = createHttpTransport({
      baseUrl: "https://example.invalid/v1",
      apiKey: "k",
      model: "deepseek-flash",
      timeoutMs: 1000,
      thinking: false,
      maxTokens: 100,
      retries: 2,
    });
    await assert.rejects(() => transport.complete([{ role: "user", content: "u" }], []), /401/);
    assert.equal(authAttempts, 1, "鉴权失败重试没有意义，只会放大问题");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------- 官方契约

/** 临时改环境变量，跑完必须还原：否则后面的用例会读到上一个用例留下的配置。 */
function withEnv(patch, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("配置默认值：关思考、base_url 不带 /v1、输出预算够改写", () => {
  withEnv(
    { LLM_API_KEY: "k", LLM_THINKING: undefined, LLM_BASE_URL: undefined, LLM_MAX_TOKENS: undefined },
    () => {
      const settings = readTransportSettings();
      // 抽槽与改写都不需要推理，默认开着只是白付 reasoning token 的钱与延迟。
      assert.equal(settings.thinking, false);
      // 官方文档给的 base_url 就是 https://api.deepseek.com；带 /v1 是历史兼容写法。
      assert.equal(settings.baseUrl, "https://api.deepseek.com");
      assert.equal(settings.maxTokens, 1600);
    },
  );
});

test("配置：开思考时把输出预算抬到装得下 reasoning", () => {
  withEnv({ LLM_API_KEY: "k", LLM_THINKING: "on", LLM_MAX_TOKENS: "800" }, () => {
    const settings = readTransportSettings();
    assert.equal(settings.thinking, true);
    // 思考模式下 reasoning 先于 content 消耗预算，800 会直接拿到空 content + finish_reason=length。
    assert.ok(settings.maxTokens >= 2048, `思考模式 maxTokens 太小：${settings.maxTokens}`);
  });
});

test("思考模式下不发 tool_choice=required（官方明确会 400）", async () => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const transport = createHttpTransport({
      baseUrl: "https://api.deepseek.com",
      apiKey: "k",
      model: "deepseek-flash",
      timeoutMs: 1000,
      thinking: true,
      maxTokens: 3000,
      retries: 0,
    });
    await transport.complete([{ role: "user", content: "u" }], [{ name: "query_balance", description: "", parameters: {} }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(captured[0].tool_choice, "auto", "思考模式 + required 会被官方接口拒绝");
  assert.equal(captured[0].thinking, undefined, "开着思考就不该再显式传 disabled");
});
