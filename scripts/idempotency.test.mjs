#!/usr/bin/env node
// 一次性核销 + 幂等键的单测。
//
// 验的是「重试」这件事：网络断了、用户连点两下、进程崩在半路，
// 系统必须答得出「这笔到底办没办」，而不是闷头再办一遍。
//
// 运行：node --test scripts/idempotency.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../track-pi/src/agent.ts";
import { createOfflineTransport } from "../track-pi/src/transport.ts";
import { AuditChain } from "../shared/rules.ts";
import { IdempotencyLog, fingerprintOf, validRequestId } from "../shared/idempotency.ts";
import { initialState } from "../shared/state.ts";

/** 规则模式：不调模型、不改写文案，断言才对得上确定的事实。 */
function makeAgent(options = {}) {
  // 审计出口与幂等出口是两件事：前者只追加行，后者原子覆盖整份快照。
  const chain = new AuditChain(options.auditSink);
  const agent = new Agent({
    state: options.state ?? initialState(),
    transport: createOfflineTransport(),
    chain,
    useModel: false,
    narrate: false,
    // 幂等日志走的仍是 FileStore 那套接口；测试里用内存假件代替。
    store: options.sink,
    ...(options.idempotencyTtlSeconds === undefined ? {} : { idempotencyTtlSeconds: options.idempotencyTtlSeconds }),
  });
  return { agent, chain };
}

const SID = "test-session";

/** 内存假存储：只实现 Agent 真正会调到的那几个方法，状态与会话不落盘。 */
function memoryStore() {
  const blob = new Map();
  return {
    blob,
    readIdempotency: () => (blob.has("idem") ? JSON.parse(blob.get("idem")) : null),
    saveIdempotency: (snapshot) => blob.set("idem", JSON.stringify(snapshot)),
    saveState: () => {},
    saveSessions: () => {},
    readSessions: () => null,
  };
}

test("同一张票、同一个请求编号，连确认两次只转一笔", async () => {
  const { agent, chain } = makeAgent();
  const before = agent.state.account.balance;

  const first = await agent.chat(SID, "给小李转 100 元");
  assert.equal(first.decision.level, "yellow");
  const token = first.confirmation?.token;
  assert.equal(typeof token, "string");

  const ok = await agent.confirm(SID, token, "req-confirm-0001");
  assert.match(ok.reply, /已向/);
  assert.equal(agent.state.account.balance, before - 10000);

  // 网络断了用户又点一次：回放首次结果，钱一分不再动。
  const again = await agent.confirm(SID, token, "req-confirm-0001");
  assert.equal(again.idempotent, "replayed");
  assert.match(again.reply, /没有重复执行/);
  assert.equal(agent.state.account.balance, before - 10000);

  const decisions = chain.list(SID, 50).map((item) => item.decision);
  assert.equal(decisions.filter((item) => item === "confirmed").length, 1, "只应有一笔真实执行");
  assert.equal(decisions.filter((item) => item === "idempotency_replay").length, 1, "重复的那次应留下回放记录");
});

test("不带请求编号时退化为旧行为：第二次确认被告知没有待确认的操作", async () => {
  const { agent } = makeAgent();
  const first = await agent.chat(SID, "给小王转 100 元");
  const token = first.confirmation?.token;
  assert.equal(typeof token, "string");

  const ok = await agent.confirm(SID, token);
  assert.match(ok.reply, /已向/);
  const again = await agent.confirm(SID, token);
  assert.equal(again.idempotent, undefined);
  assert.match(again.reply, /没有待确认的操作/);
});

test("同一个请求编号换了内容：拒绝，不执行也不回放", async () => {
  const { agent } = makeAgent();
  const before = agent.state.account.balance;
  const first = await agent.chat(SID, "给小李转 100 元", undefined, undefined, "req-chat-same-key");
  assert.equal(first.decision.level, "yellow");

  const second = await agent.chat(SID, "给小李转 900 元", undefined, undefined, "req-chat-same-key");
  assert.equal(second.idempotent, "conflict");
  assert.match(second.reply, /请求编号/);
  assert.equal(agent.state.account.balance, before, "冲突的请求不应动钱");
});

test("查询类请求同样只办一次", async () => {
  const { agent, chain } = makeAgent();
  const first = await agent.chat(SID, "查一下余额", undefined, undefined, "req-query-0001");
  const again = await agent.chat(SID, "查一下余额", undefined, undefined, "req-query-0001");
  assert.equal(again.idempotent, "replayed");
  assert.equal(again.reply, `${first.reply}\n（同一笔请求重复提交，系统回放首次结果，没有重复执行）`);

  const queried = chain.list(SID, 50).filter((item) => item.tool === "query_balance" || item.decision === "query");
  assert.equal(queried.length, 1, "重复查询不应重复执行工具");
});

test("落盘记录重启后仍能回放，不必依赖内存", async () => {
  const store = memoryStore();

  const first = makeAgent({ sink: store });
  const chat = await first.agent.chat(SID, "给小李转 100 元");
  const token = chat.confirmation?.token;
  await first.agent.confirm(SID, token, "req-persist-0001");
  assert.equal(first.agent.state.account.balance, initialState().account.balance - 10000);

  // 模拟进程重启：新 Agent、新状态，只接回同一份幂等日志。
  const second = makeAgent({ sink: store });
  assert.equal(second.agent.state.account.balance, initialState().account.balance, "状态本身是新的，靠日志判重");
  const replay = await second.agent.confirm(SID, token, "req-persist-0001");
  assert.equal(replay.idempotent, "replayed");
  assert.equal(second.agent.state.account.balance, initialState().account.balance, "重启后不能按记忆再执行一遍");
});

test("崩在执行中间：盘上是 inflight，重试不重做而是转人工", async () => {
  const store = memoryStore();
  store.saveIdempotency({
    version: 1,
    records: [
      {
        key: "req-crashed-0001",
        method: "confirm",
        sessionId: SID,
        fingerprint: fingerprintOf("confirm", SID, "any-token"),
        state: "inflight",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  });
  const { agent, chain } = makeAgent({ sink: store });
  const before = agent.state.account.balance;

  const reply = await agent.confirm(SID, "any-token", "req-crashed-0001");
  assert.equal(reply.idempotent, "interrupted");
  assert.match(reply.reply, /结果未知/);
  assert.equal(agent.state.account.balance, before, "结果未知时绝不能重做");
  assert.equal(chain.list(SID, 10).at(-1)?.decision, "idempotency_interrupted");
});

test("幂等日志自身：编号格式、指纹冲突、过期淘汰", () => {
  assert.equal(validRequestId("abc"), undefined, "太短的不收");
  assert.equal(validRequestId("has space 1234"), undefined, "不合法字符不收");
  assert.equal(validRequestId(undefined), undefined);
  assert.equal(validRequestId("req-12345678"), "req-12345678");

  const log = new IdempotencyLog(undefined);
  const fp = fingerprintOf("confirm", SID, "t");
  log.begin("req-unit-0001", "confirm", SID, fp);
  assert.equal(log.lookup("req-unit-0001", "confirm", SID, fp).kind, "interrupted");
  assert.equal(log.lookup("req-unit-0001", "confirm", SID, fingerprintOf("confirm", SID, "other")).kind, "conflict");
  assert.equal(log.lookup("req-unit-0001", "chat", SID, fp).kind, "conflict");

  log.finish("req-unit-0001", { reply: "ok" });
  const replay = log.lookup("req-unit-0001", "confirm", SID, fp);
  assert.equal(replay.kind, "replay");

  // 过期：把时间往前推，复原时应当整条丢掉。
  const stale = {
    readIdempotency: () => ({
      version: 1,
      records: [
        {
          key: "req-stale-0001",
          method: "chat",
          sessionId: SID,
          fingerprint: fp,
          state: "done",
          createdAt: 1,
          updatedAt: 1,
          reply: { reply: "旧结果" },
        },
      ],
    }),
    saveIdempotency: () => {},
  };
  const restored = new IdempotencyLog(stale, { ttlSeconds: 60 });
  assert.equal(restored.size, 0, "过期记录不接回");
});
