#!/usr/bin/env node
// 人机协同：转人工按 GB/T 47746—2026 落地。
//
// 国标把转人工分成两类入口：
//   ① 用户主动要人工 —— 入口是权利，不是系统给的恩赐；
//   ② 五类应自动转人工的情形 —— 连续识别失败、用户拒绝智能服务、
//      涉及资金与账户安全、智能响应没把事办成、负面情绪与投诉意向。
//
// 另外三件国标点名的事，这里也要验：
//   · 用户能查到自己那单到哪一步了（切换时同步信息，反过来也一样）；
//   · 结束会话不等于办结 —— 工单继续跟，用户不用一直等着；
//   · 挂单期间 AI 不替这件事动钱。
//
// 运行：node --test scripts/handoff-gb.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../track-pi/src/agent.ts";
import { createOfflineTransport } from "../track-pi/src/transport.ts";
import { AuditChain } from "../shared/rules.ts";
import { initialState } from "../shared/state.ts";
import { HandoffBoard, HandoffRejected, admitReason, slaMinutes } from "../shared/handoff.ts";

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
const TICKET_ID = /H-\d{8}-\d{4}/;

// ── 一、用户主动要人工 ──────────────────────────────────────────────

test("用户说「转人工」：立刻开单，不出确认卡，回话里给工单号与时限", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h1", "转人工");
  assert.equal(reply.confirmation, undefined, "转人工不该出一张业务确认卡");
  assert.equal(reply.scene, "handoff");
  assert.match(reply.reply, TICKET_ID, "必须给工单号 —— 用户要能查");
  assert.match(reply.reply, /分钟/, "必须说时限：多久有人管");
  assert.match(reply.reply, /不用一直等|不用等着/, "会话可以结束，工单继续跟");
  assert.ok(rulesOf(reply).includes("handoff"));
});

test("「转人工」不能被当成转账指令去问「转给谁」", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h2", "转人工");
  assert.doesNotMatch(reply.reply, /转给谁|转多少/, "「转人工」里的「转」不是转账");
  assert.match(reply.reply, TICKET_ID);
});

test("用户主动要人工：没有准入前提（用户说了就算）", async () => {
  const blocked = admitReason("customer-request", {}, { rules: [], level: "green" });
  assert.equal(blocked, null, "转人工是消费者的权利，不该给它加前提");
});

test("工单开出来了，而且挂在审计链上", async () => {
  const { agent } = makeAgent();
  await agent.chat("h3", "我要找人工客服");
  const tickets = agent.handoffBoard.list({ sessionId: "h3" });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].packet.reason, "customer-request");
  assert.ok(tickets[0].packet.audit.seq > 0, "交接包里的审计位置必须指向真实记录");
  assert.ok(tickets[0].packet.rawText.includes("找人工"), "用户原话一字不改地带过去");
});

test("正常转账不会被当成要人工", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h4", "转给小王 100 元");
  assert.equal(reply.scene, "transfer");
  assert.notEqual(reply.confirmation, undefined, "正常转账照常出确认卡");
  assert.equal(agent.handoffBoard.list({ sessionId: "h4" }).length, 0, "不该凭空开单");
});

// ── 二、五类自动触发 ────────────────────────────────────────────────

test("自动触发②：用户拒绝智能服务", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h5", "别跟我机器人说话了，给我转人工");
  assert.equal(reply.scene, "handoff");
  const tickets = agent.handoffBoard.list({ sessionId: "h5" });
  assert.equal(tickets.length, 1);
  assert.ok(["auto-refusal", "customer-request"].includes(tickets[0].packet.reason), "拒绝服务与主动要人都要转，但理由要分清");
});

test("自动触发③：涉及资金与账户安全（疑似盗刷）", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h6", "我的钱被转走了，这不是我的操作");
  assert.equal(reply.scene, "handoff");
  const tickets = agent.handoffBoard.list({ sessionId: "h6" });
  assert.equal(tickets[0].packet.reason, "auto-safety");
  assert.match(reply.reply, /优先处理|冻结/, "安全事件要给止血建议，不能只说「已转人工」");
});

test("安全事件不误伤：挂失、冻结是本项目的正规自助业务，不能把人转走", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h7", "我的卡丢了要挂失");
  assert.notEqual(reply.scene, "handoff", "挂失是自助业务，不是安全事件");
  assert.equal(agent.handoffBoard.list({ sessionId: "h7" }).length, 0);
});

test("自动触发⑤：负面情绪与投诉意向 —— 先安抚再交人，不争辩", async () => {
  const { agent } = makeAgent();
  const reply = await agent.chat("h8", "你们乱扣钱，我要投诉");
  assert.equal(reply.scene, "handoff");
  const tickets = agent.handoffBoard.list({ sessionId: "h8" });
  assert.equal(tickets[0].packet.reason, "auto-negative");
  assert.match(reply.reply, /没有执行任何操作/, "先给事实：这一轮没动账");
  assert.doesNotMatch(reply.reply, /不是我们的责任|系统不会错|请注意措辞/, "情绪面前不辩解");
  assert.match(reply.reply, TICKET_ID);
});

test("自动触发①：连续识别失败 —— 数到阈值就换人，不再追问第三次", async () => {
  const { agent } = makeAgent();
  const first = await agent.chat("h9", "今天天气怎么样");
  assert.match(first.reply, /没把握准/, "第一次没听懂是正常交流");
  assert.equal(agent.handoffBoard.list({ sessionId: "h9" }).length, 0, "第一次还不该开单");

  const second = await agent.chat("h9", "你们家显卡怎么那么贵");
  assert.equal(second.scene, "handoff", "连续第二次还听不懂就该换人");
  const tickets = agent.handoffBoard.list({ sessionId: "h9" });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].packet.reason, "auto-failure");
  assert.match(second.reply, /抱歉/, "要先道歉，别再让人重复");
  assert.match(second.reply, /查余额|转账/, "告诉用户还能办什么");
});

test("听懂一次就把「连续没听懂」清零", async () => {
  const { agent } = makeAgent();
  await agent.chat("h10", "今天天气怎么样");
  await agent.chat("h10", "查一下余额");
  const again = await agent.chat("h10", "明天天气怎么样");
  assert.match(again.reply, /没把握准/, "中间听懂过一次，计数要重来");
  assert.equal(agent.handoffBoard.list({ sessionId: "h10" }).length, 0);
});

test("自动触发④：连续追问没办成 —— 问到第三轮换人", async () => {
  const { agent } = makeAgent();
  await agent.chat("h11", "我要转账");
  await agent.chat("h11", "转给小王");
  const third = await agent.chat("h11", "小王");
  assert.equal(third.scene, "handoff", "追问到第三轮还缺东西，该换人");
  const tickets = agent.handoffBoard.list({ sessionId: "h11" });
  assert.equal(tickets[0].packet.reason, "auto-timeout");
});

// ── 三、准入：前提不成立就开不出单 ──────────────────────────────────

test("准入卡口：连续失败没到阈值，开不出自动转人工的单", () => {
  const blocked = admitReason("auto-failure", {}, { rules: [], level: "green", failStreak: 1 });
  assert.ok(blocked !== null, "不该转的时候要挡住");
  assert.match(blocked, /阈值/);
});

test("准入卡口：没有负面情绪，开不出情绪那一档的单", () => {
  assert.ok(admitReason("auto-negative", {}, { rules: [], level: "green" }) !== null);
  assert.equal(admitReason("auto-negative", {}, { rules: [], level: "green", negative: true }), null);
});

test("准入卡口：没拒绝智能服务，开不出拒绝那一档的单", () => {
  assert.ok(admitReason("auto-refusal", {}, { rules: [], level: "green" }) !== null);
  assert.equal(admitReason("auto-refusal", {}, { rules: [], level: "green", userRefused: true }), null);
});

// ── 四、查进度 ──────────────────────────────────────────────────────

test("用户能查到自己那单到哪一步了", async () => {
  const { agent } = makeAgent();
  const opened = await agent.chat("h12", "转人工");
  const id = opened.reply.match(TICKET_ID)[0];

  const status = await agent.chat("h12", "我那个工单到哪了");
  assert.match(status.reply, new RegExp(id), "要报得出工单号");
  assert.match(status.reply, /已受理|处理中/, "要说清状态");
  assert.match(status.reply, /分钟/, "要说清时限");
  assert.equal(agent.handoffBoard.list({ sessionId: "h12" }).length, 1, "查进度不该再开一张单");
});

test("没有工单时问进度：说清没有，并告诉怎么转", async () => {
  const { agent } = makeAgent();
  const status = await agent.chat("h13", "我的工单进度");
  assert.match(status.reply, /没有转人工的工单|没有工单/);
  assert.match(status.reply, /转人工/, "告诉他怎么找到人");
});

test("认领与结案之后，状态要跟着变", async () => {
  const { agent } = makeAgent();
  const opened = await agent.chat("h14", "转人工");
  const id = opened.reply.match(TICKET_ID)[0];
  agent.handoffBoard.claim(id, "演示客服");
  const status = await agent.chat("h14", "工单状态");
  assert.match(status.reply, /处理中/);
  assert.match(status.reply, /演示客服/, "谁在办要说出来");
});

// ── 五、挂单期间不占群 ──────────────────────────────────────────────

test("钱可能已经动账时（未结的 suspended-funds 工单）：同一笔钱不许再动", async () => {
  const { agent, state } = makeAgent();
  // 直接开一张「资金悬空」的工单：正常路径要靠幂等 inflight 才开得出来，
  // 这里用同样的入口造一张，验的是「有未结工单时 AI 还会不会动钱」。
  agent.handoffBoard.open(
    {
      reason: "suspended-funds",
      sessionId: "h15",
      actor: "u-1001/standard",
      rawText: "转给小王 100 元",
      intent: { tool: "transfer", slots: {}, slotOrigin: {} },
      decision: { level: "red", rules: ["idempotency"], summary: "执行中断" },
      executed: { done: false, action: "未知" },
      requestId: "req-00000001",
      audit: { seq: 1, hash: "abc" },
      suspendedCents: null,
      advice: "核账",
      entry: "session:h15",
    },
    { idemState: "inflight", rules: ["idempotency"], level: "red" },
  );

  const before = state.account.balance;
  const reply = await agent.chat("h15", "转给小李 200 元");
  assert.equal(reply.decision.blocked, true, "两边都动一次，最坏是转出去两次");
  assert.equal(reply.confirmation, undefined, "不该出卡");
  assert.equal(state.account.balance, before, "账不能动");
  assert.match(reply.reply, /核对|工单/, "要说清为什么停");
});

test("其它原因的未结工单：业务照办，但这笔必须再确认一次", async () => {
  const { agent } = makeAgent();
  await agent.chat("h16", "转人工");
  const reply = await agent.chat("h16", "转给小王 100 元");
  assert.equal(reply.decision.blocked, false, "用户还想办别的事，不该拦死");
  assert.notEqual(reply.confirmation, undefined, "照常出确认卡");
  assert.ok(rulesOf(reply).includes("handoff-hold"), "卡上要写明有未结工单");
  assert.match(reply.reply, /H-\d{8}-\d{4}/, "把工单号写出来");
});

test("工单结案之后，降权自动解除", async () => {
  const { agent } = makeAgent();
  const opened = await agent.chat("h17", "转人工");
  const id = opened.reply.match(TICKET_ID)[0];
  agent.handoffBoard.close(id, "confirmed", "已核实");
  const reply = await agent.chat("h17", "转给小王 100 元");
  assert.ok(!rulesOf(reply).includes("handoff-hold"), "结案了就该恢复正常");
});

// ── 六、时限 ────────────────────────────────────────────────────────

test("每一类转人工都有处理时限，且钱相关的最短", () => {
  assert.equal(slaMinutes("suspended-funds"), 15);
  assert.equal(slaMinutes("auto-safety"), 15);
  assert.equal(slaMinutes("customer-request"), 60);
  assert.equal(slaMinutes("auto-negative"), 60);
  assert.equal(slaMinutes("evidence-gap"), 240);
});

test("超时结案按这一类的时限算，不是一律两小时", () => {
  const board = new HandoffBoard(undefined, { timeoutSeconds: 7200 });
  const ticket = {
    packet: {
      id: "H-20261102-0001",
      createdAt: Date.now() - 20 * 60_000,
      reason: "suspended-funds",
      sessionId: "s1",
      actor: "u-1001/standard",
      rawText: "转给小王 100 元",
      intent: { tool: "transfer", slots: {}, slotOrigin: {} },
      decision: { level: "red", rules: ["idempotency"], summary: "执行中断" },
      executed: { done: false, action: "未知" },
      requestId: "req-00000001",
      audit: { seq: 1, hash: "abc" },
      suspendedCents: null,
      advice: "核账",
      entry: "session:s1",
    },
    state: "open",
  };
  board.get = () => ticket;
  board.list = () => [ticket];
  board.tickets.set(ticket.packet.id, ticket);
  const swept = board.sweep(Date.now());
  assert.equal(swept.length, 1, "20 分钟还没人处理，超了 15 分钟的时限，该结案");
  assert.equal(ticket.resolution, "no-action");
});

test("开单失败要说清原因，不吞异常", () => {
  const board = new HandoffBoard(undefined);
  assert.throws(
    () => board.open({}, { rules: [], level: "green" }),
    HandoffRejected,
  );
});
