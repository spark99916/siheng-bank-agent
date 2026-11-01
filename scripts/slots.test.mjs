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

  // 换一个会话说 —— 这一条验的是「账户里真的转出去过」那一档（30 天），
  // 不是「刚才这几句里刚提过」那一档（15 分钟）。同会话的情形见后面的 recall 用例：
  // 那一档更近，所以是问一句「还是他吗」，不直接开卡。
  const second = await agent.chat("s2-later", "再转 100 元");
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

  const second = await agent.chat("s2-later", "再转 150 元");
  await confirmOnce(agent, "s2-later", second);
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

  const reply = await agent.chat("s6-later", "转 100 元");
  assert.notEqual(reply.confirmation, undefined);
  assert.match(reply.reply, /3 天前/);
  assert.match(reply.reply, /200\.00/, "要念出上次那笔的金额，用户才认得出是哪个人");
});

test("记忆会过期：一个月前的那笔不再当默认值", async () => {
  const { agent, state } = makeAgent();
  await confirmOnce(agent, "s7", await agent.chat("s7", "转给小王 200 元"));
  state.transferLog.at(-1).at = Date.now() - 31 * 86400000;

  const reply = await agent.chat("s7-later", "转 100 元");
  assert.equal(reply.confirmation, undefined, "超期的记忆不该给出确认卡");
  assert.ok(reply.missing.includes("payee"));
  assert.match(reply.reply, /转给谁/);
});

// ---------------------------------------------------------------- 接上一句
//
// 用户的原话：「我先说转 100，你问我转给谁，我说小王；我又说转 200，
// 你又问我转的人是谁。我要的是你问我：这 200 块钱还是转给小王吗？」
//
// 这一组验的就是这一档：同一个会话里刚点过名的人（哪怕那笔还没确认），
// 下一句只说金额时不许从零重问，要接着问「还是他吗」——而且只问，不替他开卡。

test("刚说过的人，下一句只说金额：先问一句「还是他吗」，不出卡", async () => {
  const { agent, state } = makeAgent();
  await agent.chat("r1", "转 100 元");
  const first = await agent.chat("r1", "小王");
  assert.notEqual(first.confirmation, undefined, "补全之后照常出卡");

  const before = state.account.balance;
  const second = await agent.chat("r1", "转 200 元");
  assert.equal(second.confirmation, undefined, "对象是推的，不能直接开卡");
  assert.equal(second.decision.requiresConfirm, false);
  assert.ok(second.missing.includes("payee"));
  assert.match(second.reply, /还是转给「小王」吗/);
  assert.match(second.reply, /200\.00/, "要把这一轮记下的金额念出来");
  // 什么都没动：问一句而已，不碰账。
  assert.equal(state.account.balance, before);
});

test("答「是」：按刚才那个人开卡，金额是本轮说的那个", async () => {
  const { agent, state } = makeAgent();
  await agent.chat("r2", "转给小王 100 元");

  await agent.chat("r2", "转 250 元");
  const card = await agent.chat("r2", "是");
  assert.notEqual(card.confirmation, undefined, "答了是才开卡");
  assert.match(card.reply, /转账给「小王」250\.00 元/);
  assert.match(card.reply, /沿用你上一轮确认过的对象/);
  assert.ok(rulesOf(card).includes("payee-recalled"));

  const before = state.account.balance;
  const done = await confirmOnce(agent, "r2", card);
  assert.equal(state.account.balance, before - 25000);
  assert.equal(state.transferLog.at(-1).payee, "小王");
  assert.equal(state.transferLog.at(-1).amountCents, 25000);
  assert.match(done.reply, /接着上一轮的对象/, "回执里也要留痕");
});

test("答「不是」：老老实实再问一遍人是谁，下一句只说名字也能接住", async () => {
  const { agent } = makeAgent();
  await agent.chat("r3", "转给小王 100 元");
  await agent.chat("r3", "转 200 元");

  const denied = await agent.chat("r3", "不是");
  assert.equal(denied.confirmation, undefined);
  assert.match(denied.reply, /转给谁/);
  assert.match(denied.reply, /200\.00/);

  // 追问之后用户往往只回两个字。这时再说「没听懂」，等于不承认自己刚问过。
  const named = await agent.chat("r3", "小李");
  assert.notEqual(named.confirmation, undefined);
  assert.match(named.reply, /转账给「小李」200\.00 元/);
});

test("直接回一个名字：当场换人，卡上不写「沿用」", async () => {
  const { agent } = makeAgent();
  await agent.chat("r4", "转给小王 100 元");
  await agent.chat("r4", "转 300 元");

  const card = await agent.chat("r4", "小李");
  assert.notEqual(card.confirmation, undefined);
  assert.match(card.reply, /转账给「小李」300\.00 元/);
  assert.doesNotMatch(card.reply, /沿用/, "人是用户亲口说的，没什么可交代的");
  assert.ok(!rulesOf(card).includes("payee-recalled"));
});

test("问出那句之后隔了 15 分钟：不算数了，重新问人", async () => {
  const { agent } = makeAgent();
  await agent.chat("r5", "转给小王 100 元");

  const real = Date.now;
  try {
    Date.now = () => real() + 16 * 60000;
    const later = await agent.chat("r5", "转 200 元");
    assert.equal(later.confirmation, undefined);
    assert.match(later.reply, /转给谁/);
    assert.doesNotMatch(later.reply, /还是转给/);
  } finally {
    Date.now = real;
  }
});

test("记忆只在会话内：换个会话说，不接着别人的对象", async () => {
  const { agent } = makeAgent();
  await agent.chat("r6a", "转给小王 100 元");

  const other = await agent.chat("r6b", "转 200 元");
  assert.equal(other.confirmation, undefined);
  assert.match(other.reply, /转给谁/);
  assert.doesNotMatch(other.reply, /小王/);
});

// ---------------------------------------------------------------- 代词指代
//
// 用户的原话：「我先转给一个人 1000 元，因为金额太大且不在通讯录内需要手机
// 验证。于是我说我转给他 200 元，系统给出的提示是——转给对象是谁？」
//
// 「他」就是上一句刚指过的人。修两件事：被拦的那笔（恰恰最可能被改金额重试）
// 也要进会话记忆；「转给他／她／那个人」这类指代认出来之后和「转 200 元」
// 走同一条补全链 —— 该问的「还是他吗」一句不少，绝不因为用了代词就开卡。

test("代词正则：认得出「转给他」，不误伤「转给他们」", async () => {
  const { mentionsPronounPayee } = await import("../shared/rules.ts");
  assert.equal(mentionsPronounPayee("转给他 200 元"), true);
  assert.equal(mentionsPronounPayee("我转给她 500"), true);
  assert.equal(mentionsPronounPayee("转给对方"), true);
  assert.equal(mentionsPronounPayee("转给他们报销"), false, "「他们」后面跟着汉字，不是指代单个人");
  assert.equal(mentionsPronounPayee("转给小王 200 元"), false, "真名不需要代词通道");
  assert.equal(mentionsPronounPayee("查一下余额"), false);
});

test("上一笔被拦（没出卡）：「转给他 200 元」接得住，先问「还是他吗」", async () => {
  const { agent, state } = makeAgent();
  const big = await agent.chat("p1", "转给小王 1000 元");
  assert.equal(big.decision.blocked, true, "新收款人超红线，被拦");
  assert.equal(big.confirmation, undefined, "被拦的笔不出卡 —— 记忆却不能跟着丢");

  const before = state.account.balance;
  const next = await agent.chat("p1", "转给他 200 元");
  assert.match(next.reply, /还是转给「小王」吗/, "他，就是上一句刚指过的人");
  assert.match(next.reply, /200\.00/);
  assert.equal(state.account.balance, before, "问一句而已，不碰账");

  // 答「是」之后照常走确认卡；200 元没过红线，但黄卡照样要确认。
  const card = await agent.chat("p1", "是");
  assert.notEqual(card.confirmation, undefined);
  assert.match(card.reply, /转账给「小王」200\.00 元/);
  assert.ok(rulesOf(card).includes("payee-recalled"));
});

test("换个会话用「他」：接的是账户历史里真转过的人，卡上写明来源", async () => {
  const { agent } = makeAgent();
  const first = await agent.chat("p2", "转给小王 100 元");
  await confirmOnce(agent, "p2", first);

  const second = await agent.chat("p3", "转给他 200 元");
  assert.notEqual(second.confirmation, undefined, "历史档有据可查，直接出卡");
  assert.match(second.reply, /转账给「小王」200\.00 元/);
  assert.ok(rulesOf(second).includes("payee-defaulted"), "来源必须写在卡上");
});

test("只会说「转给他」没说金额：不猜数，接着问金额", async () => {
  const { agent } = makeAgent();
  await agent.chat("p4", "转给小王 100 元");

  const reply = await agent.chat("p4", "那转给他呢");
  assert.equal(reply.confirmation, undefined);
  assert.match(reply.reply, /转多少/, "缺什么问什么，金额不能替用户编");
});

test("在「还是他吗」的语境里说「我自己」：照样判红，不出卡", async () => {
  const { agent } = makeAgent();
  await agent.chat("r7", "转给小王 100 元");
  await agent.chat("r7", "转 200 元");

  const card = await agent.chat("r7", "我自己");
  assert.equal(card.decision.level, "red");
  assert.equal(card.confirmation, undefined);
  assert.match(card.reply, /不能作为收款人/);
});

test("在「还是他吗」的语境里换人（带「转给」两个字）：金额接着上一句，不再重问", async () => {
  const { agent, state } = makeAgent();
  await agent.chat("c1", "转给小王 100 元");
  const offer = await agent.chat("c1", "转 200 元");
  assert.match(offer.reply, /还是转给「小王」吗/);

  // 用户的原话场景：先转给 AA 一笔，再说「转 200 元」，系统问「还是转给 AA 吗」，
  // 用户答「转给 B」—— 问的是人，答的也只是人，金额是上一句自己说过的。
  // 两句话合起来槽位就齐了，再问一遍「转多少」等于不承认自己刚问过什么。
  const card = await agent.chat("c1", "转给小李");
  assert.notEqual(card.confirmation, undefined, "槽位已齐，该出确认卡了");
  assert.match(card.reply, /转账给「小李」200\.00 元/);
  assert.ok(!rulesOf(card).includes("payee-recalled"), "人是用户亲口换的，不算沿用");

  const before = state.account.balance;
  const done = await confirmOnce(agent, "c1", card);
  assert.equal(state.account.balance, before - 20000, "确认后按上一句说的 200 元执行");
  assert.equal(state.transferLog.at(-1).payee, "小李");
  assert.equal(state.transferLog.at(-1).amountCents, 20000);
});

test("换人的同时说了新金额：按新数算，不沿用上一句的", async () => {
  const { agent } = makeAgent();
  await agent.chat("c2", "转给小王 100 元");
  await agent.chat("c2", "转 200 元");
  const card = await agent.chat("c2", "转给小李 300 元");
  assert.notEqual(card.confirmation, undefined);
  assert.match(card.reply, /转账给「小李」300\.00 元/, "原文里有新数就按新数，不能串");
});

test("在「还是他吗」的语境里只回一个新数：是在改金额，重新问一句而不是没听懂", async () => {
  const { agent } = makeAgent();
  await agent.chat("c3", "转给小王 100 元");
  const offer = await agent.chat("c3", "转 200 元");
  assert.match(offer.reply, /还是转给「小王」吗/);

  const again = await agent.chat("c3", "500");
  assert.equal(again.confirmation, undefined, "仍然只问不开卡，决定权在用户");
  assert.match(again.reply, /还是转给「小王」吗/, "人没换，重新确认的对象还是他");
  assert.match(again.reply, /500\.00/, "新数要念进问句里");
  assert.ok(!/没把握准|没听懂/.test(again.reply), "孤零零一个数不是没听懂，是在答话");
});

test("「五百」是数不是人名：在问金额的语境里不能把它当收款人开卡", async () => {
  const { agent } = makeAgent();
  await agent.chat("c4", "转给小王 100 元");
  await agent.chat("c4", "转 200 元");
  const again = await agent.chat("c4", "五百");
  assert.equal(again.confirmation, undefined);
  assert.match(again.reply, /还是转给「小王」吗/);
  assert.match(again.reply, /500\.00/, "中文数字「五百」要按改过的金额读");
  assert.doesNotMatch(again.reply, /「五百」/, "数字不是人名，绝不能开卡");
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
  const second = await agent.chat("s10-later", "转 50 元");
  const done = await confirmOnce(agent, "s10-later", second);
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
