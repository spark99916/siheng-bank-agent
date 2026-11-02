#!/usr/bin/env node
// 登记簿式写入：会话快照、幂等日志、转人工工单三份文件的并发写保护。
//
// 这三份文件以前是「整份覆盖」：两个写者各写各的，后写的把先写的那份整个抹掉，
// 而且不留任何痕迹 —— 不像账本丢账会表现为余额对不上。
//
// 抹掉一条幂等记录的代价特别大：同一个请求编号会被当成新请求再办一次，钱扣两次，
// 事后还查不出来（文件好好的，只是少了一行）。
//
// 验三件事：
//   一、合并规则本身是对的（同键取更终的状态、未结案永不丢、坏数据不进来）；
//   二、两个写者各写一份，盘上两份都在（这正是整份覆盖会丢的）；
//   三、坏文件不删也不覆盖：旁存一份留证，再写新档。
//
// 运行：node --test scripts/ledger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileStore } from "../shared/persist.ts";
import { IdempotencyLog, mergeIdempotencySnapshot } from "../shared/idempotency.ts";
import { HandoffBoard, mergeHandoffSnapshot } from "../shared/handoff.ts";
import { mergeSessionsSnapshot } from "../track-pi/src/agent.ts";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "siheng-ledger-"));
}

const MERGE_OPTS = { ttlMs: 1800_000, maxEntries: 500, now: Date.now() };

const record = (key, state = "inflight", updatedAt = Date.now()) => ({
  key,
  method: "chat",
  sessionId: "s1",
  fingerprint: "fp-0123456789abcdef",
  state,
  createdAt: updatedAt - 1000,
  updatedAt,
});

const ticket = (id, state = "open", createdAt = Date.now()) => ({
  packet: {
    id,
    createdAt,
    reason: "suspended-funds",
    sessionId: "s1",
    actor: "u-1001/standard",
    rawText: "转给小王 100 元",
    intent: { tool: "transfer", slots: { payee: "小王" }, slotOrigin: {} },
    decision: { level: "red", rules: ["idempotency"], summary: "执行中断" },
    executed: { done: false, action: "未知" },
    requestId: "req-00000001",
    audit: { seq: 1, hash: "abc" },
    suspendedCents: null,
    advice: "核账",
    entry: "session:s1",
  },
  state,
  ...(state === "closed" ? { closedAt: createdAt + 10, resolution: "no-action" } : {}),
});

const sessionRecord = (sessionId, at, content = {}, deleted = false) => ({
  sessionId,
  at,
  deleted,
  pending: content.pending ?? null,
  drafts: content.drafts ?? null,
});

// ── 一、合并规则 ────────────────────────────────────────────────────

test("幂等合并：不同编号都留着，一条都不能少", () => {
  const merged = mergeIdempotencySnapshot(
    { version: 1, records: [record("key-aaaaaaa-1")] },
    { version: 1, records: [record("key-bbbbbbb-2")] },
    MERGE_OPTS,
  );
  assert.equal(merged.records.length, 2, "两份各一条，合并后必须是两条");
});

test("幂等合并：同一个编号取更终的状态（别人办完了就不能还停在 inflight）", () => {
  const merged = mergeIdempotencySnapshot(
    { version: 1, records: [record("key-aaaaaaa-1", "done")] },
    { version: 1, records: [record("key-aaaaaaa-1", "inflight")] },
    MERGE_OPTS,
  );
  assert.equal(merged.records.length, 1);
  assert.equal(merged.records[0].state, "done", "终态优先：done 赢过 inflight");
});

test("幂等合并：failed 也是终态，但输给 done（钱已经动了的那份优先）", () => {
  const merged = mergeIdempotencySnapshot(
    { version: 1, records: [record("key-aaaaaaa-1", "failed")] },
    { version: 1, records: [record("key-aaaaaaa-1", "done")] },
    MERGE_OPTS,
  );
  assert.equal(merged.records[0].state, "done");
});

test("幂等合并：过期记录清掉、条数按上限收（文件不能无限长）", () => {
  const now = Date.now();
  const old = record("key-aaaaaaa-1", "done", now - 10_000_000);
  const merged = mergeIdempotencySnapshot(
    { version: 1, records: [old] },
    { version: 1, records: [record("key-bbbbbbb-2", "done", now)] },
    { ttlMs: 1000, maxEntries: 10, now },
  );
  assert.equal(merged.records.length, 1, "过期的清掉");
  assert.equal(merged.records[0].key, "key-bbbbbbb-2");
});

test("幂等合并：坏数据不进来（缺字段、状态不认识的一律丢）", () => {
  const merged = mergeIdempotencySnapshot(
    { version: 1, records: [{ key: "key-aaaaaaa-1" }, { key: 123, state: "done" }, null] },
    { version: 1, records: [record("key-bbbbbbb-2")] },
    MERGE_OPTS,
  );
  assert.equal(merged.records.length, 1, "只留完整的那条");
  assert.equal(merged.records[0].key, "key-bbbbbbb-2");
});

test("工单合并：别人的单不丢，未结案的一张都不能被上限清掉", () => {
  const mine = [ticket("H-20261101-0001"), ticket("H-20261101-0002", "closed")];
  const theirs = [ticket("H-20261101-0003")];
  const merged = mergeHandoffSnapshot(
    { version: 1, tickets: theirs },
    { version: 1, tickets: mine },
    { limit: 2 },
  );
  const ids = merged.tickets.map((item) => item.packet.id);
  assert.ok(ids.includes("H-20261101-0003"), "别人开的那张必须在");
  assert.ok(ids.includes("H-20261101-0001"), "未结案的不许被上限挤掉");
  assert.equal(merged.tickets.filter((item) => item.state !== "closed").length, 2, "两张未结案都留着");
});

test("工单合并：同一张单取更靠前的状态（别人结案了我这份还开着就是不对）", () => {
  const merged = mergeHandoffSnapshot(
    { version: 1, tickets: [ticket("H-20261101-0001", "closed")] },
    { version: 1, tickets: [ticket("H-20261101-0001", "open")] },
    { limit: 10 },
  );
  assert.equal(merged.tickets.length, 1);
  assert.equal(merged.tickets[0].state, "closed");
});

test("工单合并：交接包缺字段的坏单不进来", () => {
  const broken = ticket("H-20261101-0009");
  broken.packet.rawText = "";
  const merged = mergeHandoffSnapshot(
    { version: 1, tickets: [broken] },
    { version: 1, tickets: [ticket("H-20261101-0001")] },
    { limit: 10 },
  );
  assert.equal(merged.tickets.length, 1);
  assert.equal(merged.tickets[0].packet.id, "H-20261101-0001");
});

test("会话合并：不同会话互不覆盖，同一个会话取最新的一条", () => {
  const merged = mergeSessionsSnapshot(
    { version: 2, records: [sessionRecord("s1", 100, { pending: { kind: "single" } }), sessionRecord("s2", 100, { drafts: { tool: "transfer" } })] },
    { version: 2, records: [sessionRecord("s1", 200, { pending: { kind: "plan" } }), sessionRecord("s3", 200, { drafts: { tool: "query_balance" } })] },
  );
  const byId = new Map(merged.records.map((item) => [item.sessionId, item]));
  assert.equal(byId.size, 3, "三个会话都在：别人的不能被我抹掉");
  assert.equal(byId.get("s1").pending.kind, "plan", "同一个会话取更新的那条");
  assert.equal(byId.get("s2").drafts.tool, "transfer");
});

test("会话合并：墓碑能表达「这个会话被清掉了」，不会被旧记录复活", () => {
  const merged = mergeSessionsSnapshot(
    { version: 2, records: [sessionRecord("s1", 100, { pending: { kind: "single" } })] },
    { version: 2, records: [sessionRecord("s1", 200, {}, true)] },
  );
  assert.equal(merged.records.length, 1);
  assert.equal(merged.records[0].deleted, true, "墓碑更新，旧的确认卡不该被并回来");
});

// ── 二、两个写者各写一份，盘上两份都在 ────────────────────────────────

test("负向验证：不合并真的会丢（整份覆盖，后写的抹掉先写的）", () => {
  const dir = tempDir();
  const file = path.join(dir, "idempotency.json");
  // 旧写法：各自整份覆盖
  writeFileSync(file, JSON.stringify({ version: 1, records: [record("key-aaaaaaa-1")] }));
  writeFileSync(file, JSON.stringify({ version: 1, records: [record("key-bbbbbbb-2")] }));
  const rows = JSON.parse(readFileSync(file, "utf8")).records;
  assert.equal(rows.length, 1, "整份覆盖下先写的那条真的没了 —— 这就是问题本身");
  assert.equal(rows[0].key, "key-bbbbbbb-2");
});

test("幂等日志：两个写者各记一条，盘上两条都在，写方也接回了对方那条", () => {
  const dir = tempDir();
  const logA = new IdempotencyLog(new FileStore(dir));
  const logB = new IdempotencyLog(new FileStore(dir));

  logA.begin("key-aaaaaaa-1", "chat", "s1", "fp-0123456789abcdef");
  logB.begin("key-bbbbbbb-2", "chat", "s2", "fp-0123456789abcdef");

  const rows = JSON.parse(readFileSync(path.join(dir, "idempotency.json"), "utf8")).records;
  assert.equal(rows.length, 2, "两份都在，一条都不能少");

  // A 再写一次（模拟下一次业务动作），不能把 B 的那条抹掉
  logA.begin("key-ccccccc-3", "chat", "s3", "fp-0123456789abcdef");
  const after = JSON.parse(readFileSync(path.join(dir, "idempotency.json"), "utf8")).records;
  assert.equal(after.length, 3, "A 再写一次之后仍是三条");

  // A 必须接回 B 的记录：不然 A 会以为 B 那笔还没开始
  assert.equal(logA.lookup("key-bbbbbbb-2", "chat", "s2", "fp-0123456789abcdef").kind, "interrupted");
});

test("转人工工单：两个写者各开一张，盘上两张都在", () => {
  const dir = tempDir();
  const boardA = new HandoffBoard(new FileStore(dir));
  const boardB = new HandoffBoard(new FileStore(dir));

  const ctx = { idemState: "inflight", rules: ["idempotency"], level: "red" };
  boardA.open(ticket("H-20261101-0001").packet, ctx);
  boardB.open(ticket("H-20261101-0002").packet, ctx);

  const rows = JSON.parse(readFileSync(path.join(dir, "handoff.json"), "utf8")).tickets;
  assert.equal(rows.length, 2, "两张单都在：一张单被抹掉就等于一件事从账上消失了");

  // A 再写一次（结案或认领），不能把 B 的单抹掉
  boardA.claim("H-20261101-0001", "演示客服");
  const after = JSON.parse(readFileSync(path.join(dir, "handoff.json"), "utf8")).tickets;
  assert.equal(after.length, 2);
  assert.ok(after.some((item) => item.packet.id === "H-20261101-0002"));
});

test("会话快照：两个写者各写一个会话，盘上两个都在", () => {
  const dir = tempDir();
  const storeA = new FileStore(dir);
  const storeB = new FileStore(dir);

  storeA.saveSessions({ version: 2, records: [sessionRecord("s1", Date.now(), { pending: { kind: "single" } })] }, mergeSessionsSnapshot);
  storeB.saveSessions({ version: 2, records: [sessionRecord("s2", Date.now(), { drafts: { tool: "transfer" } })] }, mergeSessionsSnapshot);

  const raw = JSON.parse(readFileSync(path.join(dir, "sessions.json"), "utf8"));
  assert.equal(raw.records.length, 2, "两个会话都在");
  assert.deepEqual(raw.records.map((item) => item.sessionId).sort(), ["s1", "s2"]);
});

// ── 三、坏文件：旁存留证，再写新档 ──────────────────────────────────

test("坏文件不删也不直接覆盖：旁存一份留证，新档照样能写", () => {
  const dir = tempDir();
  const file = path.join(dir, "sessions.json");
  writeFileSync(file, "{ 这不是合法 JSON");

  const store = new FileStore(dir);
  store.saveSessions({ version: 2, records: [sessionRecord("s1", Date.now(), { pending: { kind: "single" } })] }, mergeSessionsSnapshot);

  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.records.length, 1, "新档是好的");
  const kept = readdirSync(dir).filter((name) => name.startsWith("sessions.json.bad-"));
  assert.equal(kept.length, 1, "坏的那份留了证，不能悄悄消失");
  assert.match(readFileSync(path.join(dir, kept[0]), "utf8"), /不是合法 JSON/);
});

// ── 四、回归：账本那套保护没被带坏 ──────────────────────────────────

test("作废的确认卡不会从盘上复活：改口换人之后旧令牌必须失效", async () => {
  const dir = tempDir();
  const { Agent } = await import("../track-pi/src/agent.ts");
  const { createOfflineTransport } = await import("../track-pi/src/transport.ts");
  const { AuditChain } = await import("../shared/rules.ts");
  const { initialState } = await import("../shared/state.ts");

  const agent = new Agent({
    state: initialState(),
    transport: createOfflineTransport(),
    chain: new AuditChain(),
    useModel: false,
    narrate: false,
    store: new FileStore(dir),
  });

  const card = await agent.chat("s1", "转给小王 100 元");
  assert.ok(typeof card.confirmation?.token === "string", "先出一张确认卡");

  // 改口换人：这张卡当场作废
  const changed = await agent.chat("s1", "转给小李 600 元");
  assert.equal(changed.confirmation, undefined, "换人且越过红线，判红不出新卡");

  const stale = await agent.confirm("s1", card.confirmation.token);
  assert.match(stale.reply, /没有待确认的操作|令牌/, "旧令牌确认不了");

  // 盘上也不能留着这张作废的卡 —— 合并写最危险的地方就在这里
  const raw = readFileSync(path.join(dir, "sessions.json"), "utf8");
  assert.ok(!raw.includes(card.confirmation.token), "作废的票不该还在盘上");
});

test("账本仍然按版本校验冲突（这次改的是另外三份文件）", () => {
  const dir = tempDir();
  // 版本对不上时必须抛，而不是默默覆盖
  writeFileSync(path.join(dir, "state.json"), JSON.stringify({ revision: 9 }));
  const store = new FileStore(dir);
  assert.throws(() => store.saveState({ revision: 5 }), /已被改过/);
});
