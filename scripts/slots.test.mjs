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
import { executeTool, initialState } from "../shared/state.ts";

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
  // 卡上要说清三件事：这不是你说的、凭什么补上（哪一笔、多少）、要改怎么改。
  assert.match(second.reply, /不是你这轮说的/);
  assert.match(second.reply, /上次转账/);
  assert.match(second.reply, /要换人/);
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

test("沿用的依据要念全：上次转给谁、多少、什么时候", async () => {
  const { agent, state } = makeAgent();
  await confirmOnce(agent, "s6", await agent.chat("s6", "转给小王 200 元"));
  // 把这笔挪到 3 天前，验证「多久以前」是照着真实时间说的，不是硬编码。
  state.transferLog.at(-1).at = Date.now() - 3 * 86400000;

  const reply = await agent.chat("s6", "转 100 元");
  assert.notEqual(reply.confirmation, undefined);
  assert.match(reply.reply, /3 天前/);
  assert.match(reply.reply, /200\.00/, "要念出上次那笔的金额，用户才认得出是哪个人");
});

test("记忆会过期：一个月前的那笔不再当默认值", async () => {
  const { agent, state } = makeAgent();
  await confirmOnce(agent, "s7", await agent.chat("s7", "转给小王 200 元"));
  state.transferLog.at(-1).at = Date.now() - 31 * 86400000;

  const reply = await agent.chat("s7", "转 100 元");
  assert.equal(reply.confirmation, undefined, "超期的记忆不该给出确认卡");
  assert.ok(reply.missing.includes("payee"));
  assert.match(reply.reply, /转给谁/);
});

test("改口换人：上一张卡跟着作废，不能点着旧卡把钱转给已经放弃的人", async () => {
  const { agent, state } = makeAgent();
  const first = await agent.chat("s8", "转给小王 100 元");
  assert.notEqual(first.confirmation, undefined);

  // 换成新收款人且越过首次红线：这一句办不成，但意图已经变了。
  const second = await agent.chat("s8", "转给小李 600 元");
  assert.equal(second.decision.level, "red");
  assert.equal(second.confirmation, undefined);

  const stale = await agent.confirm("s8", first.confirmation.token);
  assert.match(stale.reply, /没有待确认的操作|令牌不匹配/);
  assert.equal(state.transferLog.filter((item) => item.payee === "小王").length, 0, "旧卡不能再转出去");
});

test("回了「我自己」，上一张卡也一起作废", async () => {
  const { agent, state } = makeAgent();
  const first = await agent.chat("s9", "转给小王 100 元");
  assert.notEqual(first.confirmation, undefined);

  const self = await agent.chat("s9", "我自己");
  assert.equal(self.decision.level, "red");

  const stale = await agent.confirm("s9", first.confirmation.token);
  assert.match(stale.reply, /没有待确认的操作|令牌不匹配/);
  assert.equal(state.transferLog.length, 0);
});

test("确认之后的回执要留一句：这个收款人是补上的", async () => {
  const { agent } = makeAgent();
  await confirmOnce(agent, "s10", await agent.chat("s10", "转给小王 100 元"));
  const second = await agent.chat("s10", "转 50 元");
  const done = await confirmOnce(agent, "s10", second);
  assert.match(done.reply, /按上次转账补上的/, "事后翻记录要能看出当时是怎么定的");
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

// ── 转给自己：业务不成立，不是风险高 ──────────────────────────────
// 这一组是补一个真实缺口：在此之前「转给我自己 100 元」「转给林知远 100 元」
// 都能出确认卡、确认后真扣钱 —— 钱在自己账上转一圈，余额不变，却留下一条
// 转账流水，把当天的日累计与频次额度占掉。

test("转给自己（自称）：判红、不给确认卡、不动账", async () => {
  const { agent, state } = makeAgent();
  const before = state.account.balance;
  const reply = await agent.chat("s7", "转给我自己 100 元");
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined, "不能给确认机会");
  assert.ok(rulesOf(reply).includes("self-transfer"));
  assert.equal(state.account.balance, before, "不能动账");
  assert.equal(state.transferLog.length, 0, "也不能留下流水");
});

test("转给本人姓名：同样拦，不靠「叫我自己」这种说法才拦得住", async () => {
  const { agent, state } = makeAgent();
  const reply = await agent.chat("s8", `转给${state.account.holder} 200 元`);
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined);
  assert.ok(rulesOf(reply).includes("self-transfer"));
});

test("回复里不能说「人脸验证后办理」—— 转给自己不是验证能解决的", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s9", "转给本人 50 元");
  assert.match(reply.reply, /账户互转/);
  assert.ok(!/人脸验证/.test(reply.reply), "这句话会让人以为多验一次就能办");
  assert.ok(!/需确认/.test(reply.reply));
});

test("执行层兜底：绕开判定直接调转账工具，也必须被拦住", () => {
  const state = initialState();
  const before = state.account.balance;
  const result = executeTool("transfer", { payee: "我自己", amountCents: 10000 }, state);
  assert.equal(result.ok, false);
  assert.equal(state.account.balance, before);
});

test("只说金额时的追问：用「请问」，不用「还差」", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s10", "转 100 元");
  assert.deepEqual(reply.missing, ["payee"]);
  assert.equal(reply.confirmation, undefined);
  assert.match(reply.reply, /请问/, "问人要像在跟人说话");
  assert.match(reply.reply, /转给谁/);
  assert.ok(!/还差/.test(reply.reply), "「还差」读起来像在挑毛病，不是在问人");
  assert.ok(!/没听懂/.test(reply.reply));
});

test("分两轮说「我自己」：不能回「没听懂」，要说清这件事不成立", async () => {
  const { agent, state } = makeAgent();
  const before = state.account.balance;
  await agent.chat("s11", "转 100 元");
  const reply = await agent.chat("s11", "我自己");
  assert.ok(!/没听懂/.test(reply.reply), "这是一句明确的收款人主张，不是没听懂");
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined, "这张令旗不该签发");
  assert.ok(rulesOf(reply).includes("self-transfer"));
  assert.match(reply.reply, /账户本人|不成立/);
  assert.equal(state.account.balance, before, "不能动账");
  assert.equal(state.transferLog.length, 0, "也不能留下流水");
});

test("分两轮说本人姓名：同样不成立，不是「没听清这个人」", async () => {
  const { agent, state } = makeAgent();
  await agent.chat("s12", "转 100 元");
  const reply = await agent.chat("s12", state.account.holder);
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined);
  assert.ok(rulesOf(reply).includes("self-transfer"));
});

test("分两轮说「本人」：也算本人，别当成普通收款人放过去", async () => {
  const { agent, state } = makeAgent();
  const before = state.account.balance;
  await agent.chat("s13", "转 100 元");
  const reply = await agent.chat("s13", "本人");
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined);
  assert.equal(state.account.balance, before);
});

test("分两轮补的是真人（小王）：仍然正常出确认卡，不能误伤", async () => {
  const { agent } = makeAgent();
  await agent.chat("s14", "转 100 元");
  const reply = await agent.chat("s14", "小王");
  assert.equal(reply.decision.level, "yellow");
  assert.notEqual(reply.confirmation, undefined, "补一个真人就该走到确认这一步");
});

test("已经签出确认卡之后再回「我自己」：也要讲明不成立，不能说没把握准", async () => {
  const { agent } = makeAgent();
  await agent.chat("s15", "转给小王 100 元");
  const reply = await agent.chat("s15", "我自己");
  assert.ok(!/没把握准|没听懂/.test(reply.reply), "这句话的意思很明确，不是没听懂");
  assert.equal(reply.decision.level, "red");
  assert.ok(rulesOf(reply).includes("self-transfer"));
  assert.match(reply.reply, /账户本人|不成立/);
});

test("上来就只说一句「我自己」：同样讲明不成立", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("s16", "我自己");
  assert.equal(reply.decision.level, "red");
  assert.equal(reply.confirmation, undefined);
  assert.ok(!/没把握准|没听懂/.test(reply.reply));
});
