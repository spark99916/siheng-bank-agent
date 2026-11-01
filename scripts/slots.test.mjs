#!/usr/bin/env node
// 转账槽位的多轮补全：少一样就追问，补齐之后必须确认。
//
// 验的是三件事：
//   一、对象和金额缺一个就问，而且问的时候要把已经记下的那个复述一遍；
//   二、补全之后不能直接执行，必须出一张写着「转给谁、多少」的确认卡；
//   三、只说金额不说人，可以沿用上次收款人，但必须让用户看见「这是系统推的」。
//
// 运行：node --test scripts/slots.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../track-pi/src/agent.ts";
import { createOfflineTransport } from "../track-pi/src/transport.ts";
import { AuditChain } from "../shared/rules.ts";
import { initialState } from "../shared/state.ts";

/** 规则模式：不调模型，断言才对得上确定的事实。 */
function makeAgent() {
  const state = initialState();
  const agent = new Agent({
    state,
    transport: createOfflineTransport(),
    chain: new AuditChain(),
    useModel: false,
    narrate: false,
  });
  return { agent, state };
}

const rulesOf = (reply) => reply.decision.hits.map((hit) => hit.rule);

/** 一路确认到底，返回确认后的回复。 */
async function confirmOnce(agent, sessionId, reply) {
  assert.notEqual(reply.confirmation, undefined, "这一步应该出确认卡");
  return agent.confirm(sessionId, reply.confirmation.token);
}

test("两样都没说：追问，并把要什么说清楚", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s1", "我要转账");
  assert.deepEqual(reply.missing, ["payee", "amountCents"]);
  assert.equal(reply.confirmation, undefined, "缺参数时不能出确认卡");
  assert.match(reply.reply, /转给谁/);
  assert.match(reply.reply, /转多少/);
});

test("补了人没补钱：追问金额，且复述已经记下的人", async () => {
  const { agent } = makeAgent();
  await agent.chat("s1", "我要转账");
  const reply = await agent.chat("s1", "转给小王");
  assert.deepEqual(reply.missing, ["amountCents"]);
  assert.match(reply.reply, /小王/, "要把已记下的收款人念出来，用户才知道刚才那句被接住了");
  assert.match(reply.reply, /转多少/);
});

test("只说了一个名字（不带「转」字）：草稿里也能接住", async () => {
  const { agent } = makeAgent();
  await agent.chat("s1", "我要转账");
  const reply = await agent.chat("s1", "小王");
  assert.deepEqual(reply.missing, ["amountCents"], "通讯录里的人名要能认出来");
  assert.match(reply.reply, /小王/);
});

test("补上金额之后：出确认卡，把对象和金额念清楚", async () => {
  const { agent } = makeAgent();
  await agent.chat("s1", "我要转账");
  await agent.chat("s1", "转给小王");
  const reply = await agent.chat("s1", "300");
  assert.notEqual(reply.confirmation, undefined, "补齐后必须确认，不能直接转");
  assert.equal(reply.decision.requiresConfirm, true);
  assert.ok(rulesOf(reply).includes("slot-completed"), "确认卡上要标明这是分两轮补的");
  assert.match(reply.reply, /收款人\s*小王/);
  assert.match(reply.reply, /300\.00/);
});

test("确认之后钱才动：金额从余额里扣掉，且只扣一次", async () => {
  const { agent, state } = makeAgent();
  const before = state.account.balance;
  await agent.chat("s1", "我要转账");
  await agent.chat("s1", "转给小王");
  const pending = await agent.chat("s1", "300");
  assert.equal(state.account.balance, before, "出确认卡的时候不能动账");

  const done = await confirmOnce(agent, "s1", pending);
  assert.equal(state.account.balance, before - 30000);
  assert.match(done.reply, /300\.00/);

  // 同一张票不能再用第二次。
  const again = await agent.confirm("s1", pending.confirmation.token);
  assert.match(again.reply, /没有待确认的操作|令牌/);
});

test("转过一次之后只说金额：默认上次收款人，但必须确认", async () => {
  const { agent } = makeAgent();
  const first = await agent.chat("s2", "转给小王 100 元");
  await confirmOnce(agent, "s2", first);

  const second = await agent.chat("s2", "再转 100 元");
  assert.notEqual(second.confirmation, undefined, "默认对象也必须确认");
  assert.equal(second.decision.requiresConfirm, true);
  assert.ok(rulesOf(second).includes("payee-defaulted"), "卡上要写明对象是推出来的");
  assert.match(second.reply, /上次收款人/);
  assert.match(second.reply, /小王/);
  assert.match(second.reply, /100\.00/);
});

test("默认补上的对象要真的能执行，钱转到那个名下的金额也对", async () => {
  const { agent, state } = makeAgent();
  const first = await agent.chat("s2", "转给小王 100 元");
  await confirmOnce(agent, "s2", first);
  const before = state.account.balance;

  const second = await agent.chat("s2", "再转 150 元");
  await confirmOnce(agent, "s2", second);
  assert.equal(state.account.balance, before - 15000);
  assert.equal(state.transferLog.at(-1).payee, "小王");
  assert.equal(state.transferLog.at(-1).amountCents, 15000);
});

test("从来没转过就说「再转 100 元」：不能凭空造一个人，老实追问", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s3", "再转 100 元");
  assert.equal(reply.confirmation, undefined);
  assert.ok(reply.missing.includes("payee"));
  assert.match(reply.reply, /转给谁/);
});

test("一次说全的转账：不用补槽位，也不该多出一条「补全」提示", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s4", "转给小王 100 元");
  const rules = rulesOf(reply);
  assert.ok(!rules.includes("slot-completed"));
  assert.ok(!rules.includes("payee-defaulted"));
  // 转账本身判黄，本来就要确认 —— 这一点没有因为本次改动而改变。
  assert.equal(reply.decision.requiresConfirm, true);
});

test("多步计划里的转账：也要念出对象和金额，推出来的对象同样要标明", async () => {
  const { agent } = makeAgent();
  const first = await agent.chat("s5", "转给小王 100 元");
  await confirmOnce(agent, "s5", first);

  const reply = await agent.chat("s5", "再转 100 元，顺便查下余额");
  assert.equal(reply.scene, "plan");
  assert.notEqual(reply.confirmation, undefined);
  assert.match(reply.reply, /转账（小王，100\.00 元）/, "整链授权前必须看见每一步转到谁、多少钱");
  assert.ok(rulesOf(reply).includes("payee-defaulted"));
});

test("计划里缺参数的转账不拆计划：回到单步追问，不签一张没写对象的支票", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s6", "我要转账，顺便查下余额");
  assert.notEqual(reply.scene, "plan");
  assert.equal(reply.confirmation, undefined, "缺参数时绝不能出确认卡");
});
