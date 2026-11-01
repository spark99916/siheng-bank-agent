/**
 * 转人工的三项卡口。
 *
 * 这三项在 PPT 上都很好写，好写的东西最容易被写成「目标」而不是「行为」：
 *   ① 交接包完整率 100%  → 缺字段开不出单
 *   ② 回写率 100%        → 开得出就必须结得掉，超时也结，但不假装办完了
 *   ③ 误转率            → 按原因设准入条件，不该转的路径根本产生不了工单
 *
 * 每个 test 都是在打脸某一句「我们会做到」：
 * 如果这里写的用例照实现反着写一遍还是绿的，那说明卡口没接上。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HandoffBoard, HandoffRejected, admitReason, missingPacketFields } from "../shared/handoff.ts";

/** 内存落盘：验证「写得进、读得回」，不依赖文件系统。 */
function memSink() {
  const box = { data: null };
  return {
    readHandoffs: () => box.data,
    saveHandoffs: (snapshot) => {
      box.data = snapshot;
    },
    raw: () => box.data,
  };
}

/** 一份完整的「钱可能已经动了」交接包。各用例只改自己关心的那一个字段。 */
function packet(over = {}) {
  return {
    reason: "suspended-funds",
    sessionId: "s1",
    actor: "u-1/standard",
    rawText: "转给小王 500 元",
    intent: { tool: "chat", slots: {}, slotOrigin: {} },
    decision: { level: "red", rules: ["idempotency"], summary: "执行中断，结果未知" },
    executed: { done: false, action: "未知：进程在办到一半时中断" },
    requestId: "req-12345678",
    audit: { seq: 7, hash: "a1b2c3d4" },
    suspendedCents: null,
    advice: "用幂等编号核对这笔是否已动账",
    entry: "session:s1",
    ...over,
  };
}

const SUSPENDED = { idemState: "inflight", rules: ["idempotency"], level: "red" };

// ---------------------------------------------------------------- 交接包完整率

test("完整的交接包能开单，工单号按日期与序号生成", () => {
  const board = new HandoffBoard(memSink());
  const ticket = board.open(packet({ createdAt: new Date(2026, 10, 1, 10, 0, 0).getTime() }), SUSPENDED);
  assert.match(ticket.packet.id, /^H-20261101-0001$/);
  assert.equal(ticket.state, "open");
  assert.equal(board.metrics().packetCompleteRate, 1);
});

test("缺原话就开不出单 —— 人工看不到原话只能从头问一遍", () => {
  const board = new HandoffBoard(memSink());
  assert.throws(
    () => board.open(packet({ rawText: "" }), SUSPENDED),
    (error) => error instanceof HandoffRejected && error.missing.includes("rawText"),
  );
  assert.equal(board.size, 0, "被拒的包不能留下半张工单");
});

test("缺审计位置也开不出单 —— 人工据此去链上定位", () => {
  const board = new HandoffBoard(memSink());
  assert.throws(() => board.open(packet({ audit: undefined }), SUSPENDED), HandoffRejected);
});

test("requestId 必须显式写 null 才允许，不能靠「没填」蒙过去", () => {
  const board = new HandoffBoard(memSink());
  // undefined = 忘了填，拒绝；null = 明确写了「这笔没有编号」，允许（但准入条件会再拦一道）
  assert.ok(missingPacketFields(packet({ requestId: undefined })).includes("requestId"));
  assert.ok(!missingPacketFields(packet({ requestId: null })).includes("requestId"));
});

test("悬空金额 0 与 null 都合法，但含义不同：0 是「确认没悬空」，null 是「不知道」", () => {
  const board = new HandoffBoard(memSink());
  const zero = board.open(packet({ suspendedCents: 0, requestId: "req-00000001", createdAt: 1767236400000 }), SUSPENDED);
  assert.equal(zero.packet.suspendedCents, 0);
  assert.ok(missingPacketFields(packet({ suspendedCents: undefined })).includes("suspendedCents"));
});

test("被拒的开单记进 rejectedOpens，完整率随之下降 —— 指标不是自己填的", () => {
  const board = new HandoffBoard(memSink());
  board.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  for (const broken of [packet({ actor: "" }), packet({ entry: "" })]) {
    assert.throws(() => board.open(broken, SUSPENDED), HandoffRejected);
  }
  const metrics = board.metrics();
  assert.equal(metrics.opened, 1);
  assert.equal(metrics.rejectedOpens, 2);
  assert.equal(metrics.packetCompleteRate, Number((1 / 3).toFixed(4)));
});

// ---------------------------------------------------------------- 准入条件（防误转）

test("suspended-funds：幂等记录不是 inflight 就不许开，钱没动不算悬空", () => {
  const blocked = admitReason("suspended-funds", packet(), { idemState: "done", rules: [], level: "red" });
  assert.match(blocked, /inflight/);
  assert.equal(admitReason("suspended-funds", packet(), SUSPENDED), null);
});

test("suspended-funds：没有幂等编号直接拒 —— 否则人工与用户会各办一次", () => {
  const blocked = admitReason("suspended-funds", packet({ requestId: null }), SUSPENDED);
  assert.match(blocked, /幂等编号/);
  const board = new HandoffBoard(memSink());
  assert.throws(() => board.open(packet({ requestId: null }), SUSPENDED), HandoffRejected);
});

test("manual-only：工具不是不可撤销的，就不该占用人工", () => {
  const blocked = admitReason("manual-only", packet({ reason: "manual-only", requestId: null }), {
    irreversible: false,
    rules: [],
    level: "red",
  });
  assert.match(blocked, /不可撤销/);
  assert.equal(
    admitReason("manual-only", packet({ reason: "manual-only", requestId: null }), { irreversible: true, rules: [], level: "red" }),
    null,
  );
});

test("evidence-gap：没命中证据不足类规则，就不属于补材料场景", () => {
  const blocked = admitReason("evidence-gap", packet({ reason: "evidence-gap", requestId: null }), { rules: ["amount-limit"], level: "red" });
  assert.match(blocked, /证据不足/);
  assert.equal(
    admitReason("evidence-gap", packet({ reason: "evidence-gap", requestId: null }), { rules: ["aml-evidence-gap"], level: "red" }),
    null,
  );
});

test("capability：有悬空资金时不许按「能力不足」转出，必须先对账", () => {
  const blocked = admitReason("capability", packet({ reason: "capability", requestId: null }), {
    idemState: "inflight",
    rules: [],
    level: "red",
  });
  assert.match(blocked, /先对账/);
});

test("未知原因一律拒 —— 白名单之外的东西不能进工单池", () => {
  assert.match(admitReason("whatever", packet(), SUSPENDED), /未知/);
});

// ---------------------------------------------------------------- 回写闭环

test("开单 → 认领 → 结案：回写率到 100%", () => {
  const board = new HandoffBoard(memSink());
  const { packet: opened } = board.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  board.claim(opened.id, "客服-张三");
  const closed = board.close(opened.id, "confirmed", "已核对：该笔已转出，未重复办理", "客服-张三");
  assert.equal(closed.state, "closed");
  assert.equal(closed.resolution, "confirmed");
  assert.equal(closed.claimedBy, "客服-张三");
  const metrics = board.metrics();
  assert.equal(metrics.writeBackRate, 1);
  assert.equal(metrics.pending, 0);
});

test("开单未结案时回写率必须小于 1 —— 不许把待办算成已办", () => {
  const board = new HandoffBoard(memSink());
  board.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  board.open(packet({ createdAt: 1767236400000, requestId: "req-87654321" }), SUSPENDED);
  board.close(board.list()[0].packet.id, "released", "已退回");
  const metrics = board.metrics();
  assert.equal(metrics.opened, 2);
  assert.equal(metrics.writeBackRate, 0.5);
  assert.equal(metrics.pending, 1);
});

test("重复结案被拒 —— 否则回写率可以靠重复点刷新", () => {
  const board = new HandoffBoard(memSink());
  const { packet: opened } = board.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  board.close(opened.id, "released", "已退回");
  assert.throws(() => board.close(opened.id, "confirmed", "又结一次"), HandoffRejected);
});

test("给不存在的工单结案被拒 —— 没开过单就不能回写", () => {
  const board = new HandoffBoard(memSink());
  assert.throws(() => board.close("H-20261101-9999", "released", "无中生有"), HandoffRejected);
});

test("处置结论必须是白名单里的四个之一，不许写「已处理」这种含糊话", () => {
  const board = new HandoffBoard(memSink());
  const { packet: opened } = board.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  assert.throws(() => board.close(opened.id, "已处理", ""), HandoffRejected);
  assert.throws(() => board.close(opened.id, "done", ""), HandoffRejected);
});

// ---------------------------------------------------------------- 超时结案

test("超时无人处置：结案成 no-action 并写明「仍需跟进」，不假装办完了", () => {
  const board = new HandoffBoard(memSink(), { timeoutSeconds: 60 });
  const created = Date.now() - 120000;
  board.open(packet({ createdAt: created }), SUSPENDED);
  const swept = board.sweep(Date.now());
  assert.equal(swept.length, 1);
  assert.equal(swept[0].resolution, "no-action");
  assert.match(swept[0].note, /无人处置/);
  assert.match(swept[0].note, /仍需人工跟进/);
  // 结案了，所以回写率是 100%；但自动结案数被单独计数，不会被当成「有人办过」。
  const metrics = board.metrics();
  assert.equal(metrics.writeBackRate, 1);
  assert.equal(metrics.autoClosed, 1);
});

test("还没到超时的不动它", () => {
  const board = new HandoffBoard(memSink(), { timeoutSeconds: 7200 });
  board.open(packet({ createdAt: Date.now() }), SUSPENDED);
  assert.equal(board.sweep(Date.now()).length, 0);
  assert.equal(board.metrics().pending, 1);
});

// ---------------------------------------------------------------- 落盘与复原

test("落盘后重新装载：工单还在，状态与结论都在", () => {
  const sink = memSink();
  const first = new HandoffBoard(sink);
  const { packet: opened } = first.open(packet({ createdAt: 1767236400000 }), SUSPENDED);
  first.close(opened.id, "confirmed", "已核对");

  const second = new HandoffBoard(sink);
  const restored = second.get(opened.id);
  assert.ok(restored !== undefined, "重启后工单不能凭空消失");
  assert.equal(restored.state, "closed");
  assert.equal(restored.resolution, "confirmed");
  assert.equal(restored.packet.rawText, "转给小王 500 元");
});

test("盘上是半坏的工单：整条丢，不做「尽量救回来」", () => {
  const sink = memSink();
  sink.saveHandoffs({
    version: 1,
    tickets: [
      { packet: packet({ createdAt: 1767236400000 }), state: "open" },
      // 缺 rawText 的半坏记录：救回来会让人以为已经有人接了
      { packet: { ...packet(), rawText: "" }, state: "open" },
      { packet: packet({ id: "H-20261101-0003" }), state: "已关闭" },
    ],
  });
  const board = new HandoffBoard(sink);
  assert.equal(board.size, 1);
});

// ---------------------------------------------------------------- 与 Agent 接线

/**
 * 端到端：盘上留一条 inflight（模拟上次崩在办到一半），
 * 同一个请求编号再来 —— 必须答「结果未知 + 一个真实存在的工单号」，而不是一句空话。
 */
test("执行中断时真的开出一张工单，工单号回给用户且能查到", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { FileStore } = await import("../shared/persist.ts");
  const { IdempotencyLog, fingerprintOf } = await import("../shared/idempotency.ts");
  const { Agent } = await import("../track-pi/src/agent.ts");
  const { AuditChain } = await import("../shared/rules.ts");
  const { initialState } = await import("../shared/state.ts");
  const { createOfflineTransport } = await import("../track-pi/src/transport.ts");

  const dir = mkdtempSync(path.join(tmpdir(), "bank-handoff-"));
  const store = new FileStore(dir);
  const key = "req-crash-0001";
  const text = "转给小王 500 元";

  // 上一次跑到这里进程没了：inflight 已落盘，但没有结果。
  new IdempotencyLog(store).begin(key, "chat", "s1", fingerprintOf("chat", "s1", text));

  const chain = new AuditChain();
  const agent = new Agent({ state: initialState(), transport: createOfflineTransport(), chain, store, useModel: false, narrate: false });

  const reply = await agent.chat("s1", text, { userId: "u-1", tier: "standard" }, undefined, key);
  assert.equal(reply.idempotent, "interrupted");
  assert.ok(reply.handoff !== undefined, "必须带工单信息回来");
  assert.match(String(reply.handoff.id), /^H-\d{8}-\d{4}$/, "工单号要能被人念出来");
  assert.match(reply.reply, new RegExp(String(reply.handoff.id)), "回复里要出现工单号，否则用户拿什么去问");

  const ticket = agent.handoffBoard.get(String(reply.handoff.id));
  assert.ok(ticket !== undefined);
  assert.equal(ticket.packet.reason, "suspended-funds");
  assert.equal(ticket.packet.rawText, text, "原话一字不改地带过去");
  assert.equal(ticket.packet.requestId, key, "幂等编号必须带过去，否则人工和用户会各办一次");
  assert.equal(ticket.packet.suspendedCents, null, "不知道动了多少就写不知道，不写 0");

  // 开单这件事本身也要进审计链，否则「转过人工」查不到。
  const opened = agent.auditLog("s1", 20).records.filter((row) => row.decision === "handoff_opened");
  assert.equal(opened.length, 1);
  assert.match(opened[0].result, new RegExp(String(reply.handoff.id)));

  // 结案后回写率到 100%，工单落盘后重启仍在。
  agent.handoffBoard.close(String(reply.handoff.id), "confirmed", "已核对：该笔未执行，账户余额未变");
  assert.equal(agent.handoffBoard.metrics().writeBackRate, 1);
  const reloaded = new Agent({ state: initialState(), transport: createOfflineTransport(), chain: new AuditChain(), store, useModel: false, narrate: false });
  assert.equal(reloaded.handoffBoard.get(String(reply.handoff.id))?.resolution, "confirmed");
});
