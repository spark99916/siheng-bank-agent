#!/usr/bin/env node
// 规则单元测试：只测纯函数，不起服务、不碰网络。用 node 内置 test runner，不引依赖。
// 运行：node --test scripts/rules.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AuditChain,
  DEFAULT_ACTOR,
  evaluate,
  extractAmount,
  extractPayee,
  groundIntent,
  issueTicket,
  parseIntent,
  parsePlan,
  resolvePolicy,
  verifyTicket,
} from "../shared/rules.ts";
import { initialState } from "../shared/state.ts";

const actor = (tier) => ({ userId: `u-${tier}`, tier });

/** 一句话 → 意图 → 判定，走的是和服务里同一条路径。 */
function decide(text, state = initialState(), options = {}) {
  const intent = parseIntent(text, state);
  return { intent, decision: evaluate(intent, state, { actor: DEFAULT_ACTOR, ...options }) };
}

const rulesOf = (decision) => decision.hits.map((hit) => hit.rule);
const hitOf = (decision, rule) => decision.hits.find((hit) => hit.rule === rule);

// ------------------------------------------------------------------ 意图解析

test("金额：口语中文数字要按千位折算", () => {
  assert.equal(extractAmount("转给小王 三千五"), 350000);
  assert.equal(extractAmount("转给小王 五百块"), 50000);
  assert.equal(extractAmount("转 1.5 万"), 1500000);
  assert.equal(extractAmount("转 100 元"), 10000);
});

test("金额：手机号不能被当成金额", () => {
  assert.equal(extractAmount("转给 13800138000 五百"), 50000);
});

test("收款人：手机号先映射通讯录，映射不到就不猜", () => {
  const state = initialState();
  assert.equal(extractPayee("转给 13800138000 五百", state), "小王");
  assert.equal(extractPayee("转给张三 100 元", state), "张三");
  assert.equal(extractPayee("转给 19900001111 100 元", state), null);
});

test("意图：按备注转账要标出来源，不能当可信收款人", () => {
  const state = initialState();
  const intent = parseIntent("按备注转给张三 100 元", state);
  assert.equal(intent.tool, "transfer");
  assert.equal(intent.slots.payeeSource, "remark");
});

test("意图：卡号当收款人只保留前四后四", () => {
  const state = initialState();
  const intent = parseIntent("转 100 元到 6222020000000000", state);
  assert.equal(intent.slots.payeeSource, "card-number");
  assert.equal(intent.slots.payeeMasked, "6222****0000");
});

// ------------------------------------------------------------------ 判定规则

test("规则 single-limit：detail 里必须有本次金额与限额两个数字", () => {
  const { decision } = decide("转给小王 5000 元");
  const hit = hitOf(decision, "single-limit");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /5000\.00/);
  assert.match(hit.detail, /1000\.00/);
  assert.equal(decision.blocked, true);
  assert.equal(decision.level, "red");
});

test("规则 daily-limit：日累计要把已发生的流水算进去", () => {
  const state = initialState();
  state.transferLog.push({ payee: "刘洋", amountCents: 90000, at: Date.now() });
  state.transferLog.push({ payee: "李四", amountCents: 90000, at: Date.now() });
  // 已转 1800 元，再转 1300 元合计 3100 元，超过 3000 元日累计。
  const { decision } = decide("转给小王 1300 元", state);
  const hit = hitOf(decision, "daily-limit");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /1800\.00/);
  assert.match(hit.detail, /3000\.00/);
});

test("规则 new-payee：首次收款人超过红线判红，未超判黄", () => {
  const over = decide("转给小王 800 元").decision;
  assert.equal(over.level, "red");
  assert.ok(rulesOf(over).includes("new-payee"));

  const under = decide("转给小王 400 元").decision;
  assert.equal(under.level, "yellow");
  assert.ok(rulesOf(under).includes("new-payee"));
});

test("规则 new-payee：转过一次就不再算首次", () => {
  const state = initialState();
  state.transferLog.push({ payee: "小王", amountCents: 100, at: Date.now() - 86400000 });
  const { decision } = decide("转给小王 800 元", state);
  assert.ok(!rulesOf(decision).includes("new-payee"));
});

test("规则 frequency：窗口内反复转账达到上限即拦", () => {
  const state = initialState();
  state.transferLog.push({ payee: "刘洋", amountCents: 100, at: Date.now() });
  state.transferLog.push({ payee: "刘洋", amountCents: 100, at: Date.now() });
  const intent = { scene: "transfer", tool: "transfer", slots: { payee: "刘洋", amountCents: 10000 }, missing: [], confidence: 1 };
  const decision = evaluate(intent, state, { actor: DEFAULT_ACTOR });
  const hit = hitOf(decision, "frequency");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /10 分钟/);
  assert.equal(decision.blocked, true);
});

test("规则 irreversibility：不可撤销但允许确认的抬到黄", () => {
  const { decision } = decide("转给小王 400 元");
  const hit = hitOf(decision, "reversibility");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /400\.00/);
  assert.equal(decision.level, "yellow");
  assert.equal(decision.requiresConfirm, true);
});

test("规则 irreversible：挂失与赎回连确认都不给", () => {
  const gold = decide("挂失我的卡", initialState(), { actor: actor("gold") }).decision;
  assert.ok(rulesOf(gold).includes("irreversible"));
  assert.equal(gold.blocked, true);

  const redeem = decide("把理财全部赎回", initialState(), { actor: actor("gold") }).decision;
  assert.ok(rulesOf(redeem).includes("irreversible"));
  assert.equal(redeem.blocked, true);
});

test("规则 payee-from-remark：备注里的名字不是可信来源", () => {
  const { decision } = decide("按备注转给张三 100 元");
  assert.ok(rulesOf(decision).includes("payee-from-remark"));
  assert.equal(decision.blocked, true);
});

test("规则 payee-from-card-number：卡号无法核验户名", () => {
  const { decision } = decide("转 100 元到 6222020000000000");
  const hit = hitOf(decision, "payee-from-card-number");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /6222\*\*\*\*0000/);
  assert.equal(decision.blocked, true);
});

test("规则 tool-whitelist：不在白名单的工具直接红", () => {
  const intent = { scene: "x", tool: "drop_database", slots: {}, missing: [], confidence: 1 };
  const decision = evaluate(intent, initialState(), { actor: DEFAULT_ACTOR });
  assert.equal(decision.blocked, true);
  assert.equal(rulesOf(decision)[0], "tool-whitelist");
});

// ------------------------------------------------------------------ 权限分级

test("档位：同一笔钱在不同档位下阈值不同", () => {
  assert.equal(resolvePolicy(actor("standard")).singleLimitCents, 100000);
  assert.equal(resolvePolicy(actor("gold")).singleLimitCents, 500000);
  assert.equal(resolvePolicy(actor("private")).singleLimitCents, 5000000);
  // 显式覆盖优先于档位默认值
  assert.equal(resolvePolicy(actor("gold"), { singleLimitCents: 50000 }).singleLimitCents, 50000);
});

test("档位：同一句「转给小王 800 元」普通客户红、金卡黄", () => {
  const standard = decide("转给小王 800 元", initialState(), { actor: actor("standard") }).decision;
  const gold = decide("转给小王 800 元", initialState(), { actor: actor("gold") }).decision;
  assert.equal(standard.level, "red");
  assert.equal(gold.level, "yellow");
  assert.ok(rulesOf(standard).includes("actor-tier"));
});

test("档位：达不到 minTier 的业务判红并说明第几档", () => {
  const { decision } = decide("把理财全部赎回", initialState(), { actor: actor("standard") });
  const hit = hitOf(decision, "tier-insufficient");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /第 1 档/);
  assert.match(hit.detail, /第 2 档/);
});

// ------------------------------------------------------------------ 理财适当性

test("规则 suitability：产品风险高于承受等级判红", () => {
  const { decision } = decide("买进取成长股票 5000 元", initialState(), { actor: actor("gold") });
  const hit = hitOf(decision, "suitability");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /风险等级 4/);
  assert.match(hit.detail, /承受等级 2/);
});

test("规则 min-amount：低于起购金额判红", () => {
  // 安享固收 90 天起购 1000 元，买 100 元不够。
  const { decision } = decide("买安享固收 90 天 100 元", initialState(), { actor: actor("gold") });
  assert.ok(rulesOf(decision).includes("min-amount"));
});

// ------------------------------------------------------------------ 幻觉防护

test("幻觉防护：模型编的金额必须被拦下来", () => {
  const state = initialState();
  const fabricated = { scene: "transfer", tool: "transfer", slots: { payee: "小王", amountCents: 500000 }, missing: [], confidence: 0.9 };
  const grounded = groundIntent(fabricated, "转给小王 500 元", state);
  assert.equal(grounded.grounded, false);
  assert.match(grounded.grounding, /5000\.00/);
  assert.match(grounded.grounding, /500\.00/);

  const decision = evaluate(grounded, state, { actor: DEFAULT_ACTOR });
  assert.ok(rulesOf(decision).includes("grounding"));
  assert.equal(decision.blocked, true);
});

test("幻觉防护：模型编的收款人必须被拦下来", () => {
  const state = initialState();
  const fabricated = { scene: "transfer", tool: "transfer", slots: { payee: "王五", amountCents: 10000 }, missing: [], confidence: 0.9 };
  const grounded = groundIntent(fabricated, "转给小王 100 元", state);
  assert.equal(grounded.grounded, false);
  assert.match(grounded.grounding, /王五/);
});

test("幻觉防护：参数与原文一致则放行，不误伤", () => {
  const state = initialState();
  const honest = { scene: "transfer", tool: "transfer", slots: { payee: "小王", amountCents: 10000 }, missing: [], confidence: 0.9 };
  const grounded = groundIntent(honest, "转给小王 100 元", state);
  assert.equal(grounded.grounded, true);
  const decision = evaluate(grounded, state, { actor: DEFAULT_ACTOR });
  assert.ok(!rulesOf(decision).includes("grounding"));
});

// ------------------------------------------------------------------ 外部证据

const evidence = (level, hits = [], extra = {}) => ({ level, hits, source: "external", ...extra });

test("外部证据：高风险直接判红，并把命中的条目写进 detail", () => {
  const { decision } = decide("转给张三 300 元", initialState(), { evidence: evidence("high", ["在涉诈账户名单内", "近 90 天被举报 3 次"], { advice: "人工复核" }) });
  assert.equal(decision.level, "red");
  assert.equal(decision.blocked, true);
  const hit = hitOf(decision, "external-risk");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /涉诈账户名单/);
  assert.match(hit.detail, /人工复核/);
});

test("外部证据：中风险抬到需确认，低风险只记一条不改颜色", () => {
  const medium = decide("转给刘洋 300 元", initialState(), { evidence: evidence("medium", ["近 30 天有 2 笔退款争议"]) }).decision;
  assert.ok(rulesOf(medium).includes("external-risk"));
  assert.equal(medium.requiresConfirm, true);

  const withoutRisk = decide("转给小王 300 元").decision;
  const withLow = decide("转给小王 300 元", initialState(), { evidence: evidence("low") }).decision;
  assert.equal(withLow.level, withoutRisk.level);
  assert.match(hitOf(withLow, "external-risk").detail, /未命中风险特征/);
});

test("外部证据：不可用时降级为需确认，不当作「没查到风险」", () => {
  const { decision } = decide("转给小王 100 元", initialState(), {
    evidence: { level: "low", hits: [], source: "degraded", reason: "external_timeout" },
  });
  const hit = hitOf(decision, "external-degraded");
  assert.ok(hit !== undefined);
  assert.match(hit.detail, /external_timeout/);
  assert.equal(decision.requiresConfirm, true);
  assert.ok(!rulesOf(decision).includes("external-risk"));
});

test("外部证据：不传给非转账业务", () => {
  const { decision } = decide("查一下余额", initialState(), { evidence: evidence("high", ["不该出现"]) });
  assert.ok(!rulesOf(decision).includes("external-risk"));
  assert.ok(!rulesOf(decision).includes("external-degraded"));
  assert.equal(decision.level, "green");
});

// ------------------------------------------------------------------ 任务规划

test("计划：条件式先查余额，再带守卫转账", () => {
  const plan = parsePlan("查一下余额够不够转给小王 400 元", initialState());
  assert.ok(plan !== null);
  assert.equal(plan.kind, "conditional");
  assert.equal(plan.steps[0].intent.tool, "query_balance");
  assert.equal(plan.steps[1].intent.tool, "transfer");
  assert.equal(plan.steps[1].guard, "balance-sufficient");
});

test("计划：顺序式按连接词切句", () => {
  const plan = parsePlan("先查一下余额，然后把云端音乐取消", initialState());
  assert.ok(plan !== null);
  assert.equal(plan.kind, "sequential");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[1].intent.tool, "cancel_subscription");
});

test("计划：单句不该被拆成计划", () => {
  assert.equal(parsePlan("转给小王 100 元", initialState()), null);
  assert.equal(parsePlan("查一下余额", initialState()), null);
});

// ------------------------------------------------------------------ 令牌与审计

test("确认令牌：错令牌、跨会话、过期都不通过", () => {
  const ticket = issueTicket("s1", "transfer", { payee: "小王", amountCents: 100 }, 120);
  assert.equal(verifyTicket(ticket, "s1", ticket.token).ok, true);
  assert.equal(verifyTicket(ticket, "s1", "另一个令牌").ok, false);
  assert.equal(verifyTicket(undefined, "s1", ticket.token).ok, false);
  const expired = { ...ticket, expiresAt: Date.now() - 1 };
  const result = verifyTicket(expired, "s1", expired.token);
  assert.equal(result.ok, false);
  assert.match(result.reason, /过期/);
});

test("审计链：改掉一条结论就断在那一位置", () => {
  const chain = new AuditChain();
  const first = chain.append({ sessionId: "s", userText: "a", tool: "query_balance", decision: "auto_execute", level: "green", rules: [], result: "ok" });
  const second = chain.append({ sessionId: "s", userText: "b", tool: "query_balance", decision: "auto_execute", level: "green", rules: [], result: "ok" });
  assert.equal(first.seq, 1);
  assert.equal(chain.verify().ok, true);

  chain.tamper(second.seq, "改过的结论");
  const check = chain.verify();
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, second.seq);
});

test("审计链：actor 参与哈希，改主体也会断链", () => {
  const chain = new AuditChain();
  chain.append({ sessionId: "s", actor: "u-1/standard", userText: "a", tool: "query_balance", decision: "auto_execute", level: "green", rules: [], result: "ok" });
  assert.equal(chain.verify().ok, true);
  const record = chain.list()[0];
  record.actor = "u-2/private";
  assert.equal(chain.verify().ok, false);
});
