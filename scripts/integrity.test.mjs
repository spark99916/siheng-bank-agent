#!/usr/bin/env node
// 数据完整性的回归测试：三条被实证过的缺口，一条都不许再犯。
//
// 这份测试的来历很具体 —— 三条缺口都是先**实测**复现出来的，不是读代码猜的：
//
//   ① 手改 state.json 的余额 → 重启后照常开门，余额变成任意数字，审计链毫无察觉
//   ② 删掉审计文件最后几行 → chain 仍报 ok:true、corruptLines:0，钱扣了但审计查不到
//   ③ 把一条幂等记录的 state 字段改坏 → 记录被静默丢弃，同一 requestId 不再被拦为重放
//
// 每条缺口都有一个「负向验证」：把修法拆掉，测试必须失败。
// 只写正向测试的保证不算保证 —— 改代码的人会把它改坏，而改坏时不会有任何报错。
//
// 运行：node --test scripts/integrity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileStore } from "../shared/persist.ts";
import { initialState } from "../shared/state.ts";
import { canonicalJson, checkIntegrity, digestOf } from "../shared/integrity.ts";
import { RejectionLog } from "../shared/rejections.ts";
import { mergeIdempotencySnapshot } from "../shared/idempotency.ts";
import { mergeHandoffSnapshot } from "../shared/handoff.ts";

function freshStore() {
  return new FileStore(mkdtempSync(path.join(tmpdir(), "bank-integrity-")));
}

function statePath(store) {
  return path.join(store.dir, "state.json");
}

// ── 保证 3：状态自摘要 ──────────────────────────────────────────────

test("摘要：写入后自带 integrity 字段，摘要是对正文算的", () => {
  const store = freshStore();
  store.saveState(initialState());
  const raw = JSON.parse(readFileSync(statePath(store), "utf8"));
  assert.equal(raw.integrity.algo, "sha256");
  assert.equal(typeof raw.integrity.digest, "string");
  assert.equal(raw.integrity.digest.length, 64);

  // 摘要是对「去掉 integrity 之后的正文」算的
  const body = { ...raw };
  delete body.integrity;
  assert.equal(digestOf(body), raw.integrity.digest);
});

test("摘要：规范化 JSON 与键序无关（否则误报）", () => {
  const a = { x: 1, y: { b: 2, a: 1 } };
  const b = { y: { a: 1, b: 2 }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(digestOf(a), digestOf(b));
});

test("摘要：数组顺序必须保留（顺序本身是信息）", () => {
  const a = { list: [1, 2, 3] };
  const b = { list: [3, 2, 1] };
  assert.notEqual(digestOf(a), digestOf(b));
});

test("缺口①已堵：手改余额会被查出，状态判为 corrupt", () => {
  /* 这条是实测复现过的：改完余额重启，/ready 报 200，余额变成 999999.99。
     结构和内洽性都合法（available <= balance），只查结构是查不出来的。 */
  const store = freshStore();
  store.saveState(initialState());

  const raw = JSON.parse(readFileSync(statePath(store), "utf8"));
  raw.account.balance = 99999999;
  raw.account.available = 99999999;
  writeFileSync(statePath(store), JSON.stringify(raw), "utf8");

  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt", "手改余额必须被查出");
  assert.match(loaded.reason, /摘要/);
});

test("摘要：改任何字段都算改（不只是余额）", () => {
  const store = freshStore();
  store.saveState(initialState());
  const raw = JSON.parse(readFileSync(statePath(store), "utf8"));
  raw.contacts[0].name = "陌生人";
  writeFileSync(statePath(store), JSON.stringify(raw), "utf8");
  assert.equal(store.loadState().kind, "corrupt");
});

test("摘要：老盘没有 integrity 字段不算坏（不拿新规则杀旧数据）", () => {
  const store = freshStore();
  const legacy = initialState();
  delete legacy.integrity;
  writeFileSync(statePath(store), JSON.stringify(legacy), "utf8");

  const loaded = store.loadState();
  assert.equal(loaded.kind, "disk", "老盘要能读进来");
});

test("摘要：integrity 字段本身被改坏也算不一致（不能当成「没有」）", () => {
  const store = freshStore();
  store.saveState(initialState());
  const raw = JSON.parse(readFileSync(statePath(store), "utf8"));
  raw.integrity.digest = "0".repeat(64);
  writeFileSync(statePath(store), JSON.stringify(raw), "utf8");
  assert.equal(store.loadState().kind, "corrupt");
});

test("摘要：认不出的算法不能当成通过", () => {
  const body = { a: 1 };
  const raw = { ...body, integrity: { algo: "md5", digest: digestOf(body) } };
  const result = checkIntegrity(raw);
  assert.equal(result.kind, "mismatch", "换算法绕不过去");
});

// ── 保证 2：链头锚点 ────────────────────────────────────────────────

test("锚点：追加审计记录后写出锚点，记着链头长什么样", () => {
  const store = freshStore();
  store.append({ seq: 1, hash: "h1" });
  store.append({ seq: 2, hash: "h2" });

  const head = store.readAuditHead();
  assert.equal(head.seq, 2);
  assert.equal(head.hash, "h2");
  assert.equal(head.count, 2);
});

test("锚点：首次运行没有锚点是正常的（不是坏）", () => {
  assert.equal(freshStore().readAuditHead(), null);
});

test("缺口②已堵：锚点与盘上条数对不上，说明尾部被截断", () => {
  /* 这条是实测复现过的：砍掉审计最后一行（正是「转账执行」那条），
     chain 仍报 ok:true、brokenAt:null、corruptLines:0 —— 完全查不出来。
     现在靠锚点能查出来：锚点记着 2 条，盘上只有 1 条。 */
  const store = freshStore();
  store.append({ seq: 1, hash: "h1" });
  store.append({ seq: 2, hash: "h2" });

  // 删掉最后一行（模拟整行删除）
  const file = path.join(store.dir, "audit.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  writeFileSync(file, `${lines[0]}\n`, "utf8");

  const head = store.readAuditHead();
  const actual = store.readAudit().rows.length;
  assert.equal(head.count, 2, "锚点仍记着 2 条");
  assert.equal(actual, 1, "盘上只剩 1 条");
  assert.equal(head.count - actual, 1, "少了一条 —— 正是截断的信号");
});

test("锚点：链头哈希对不上，说明最后一条被改过", () => {
  const store = freshStore();
  store.append({ seq: 1, hash: "h1" });
  store.append({ seq: 2, hash: "h2" });

  const file = path.join(store.dir, "audit.jsonl");
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  const tampered = JSON.parse(lines[1]);
  tampered.hash = "被改过的哈希";
  writeFileSync(file, `${lines[0]}\n${JSON.stringify(tampered)}\n`, "utf8");

  const head = store.readAuditHead();
  const last = store.readAudit().rows.at(-1);
  assert.notEqual(head.hash, last.hash, "链头哈希对不上");
});

test("锚点：清空审计时锚点一起清（否则会以为链被截断）", () => {
  const store = freshStore();
  store.append({ seq: 1, hash: "h1" });
  store.dropAudit();
  assert.equal(store.readAuditHead(), null);
  assert.equal(store.readAudit().rows.length, 0);
});

// ── 保证 4：坏条目计数与留证 ────────────────────────────────────────

test("幂等：字段坏的条目被计数，不再静默丢弃", () => {
  const rejections = new RejectionLog();
  const disk = {
    version: 1,
    records: [
      { key: "req-good-0001", method: "chat", sessionId: "s", fingerprint: "f", state: "done", createdAt: Date.now(), updatedAt: Date.now() },
      { key: "req-bad-00001", method: "chat", sessionId: "s", fingerprint: "f", state: "corrupted", createdAt: Date.now(), updatedAt: Date.now() },
    ],
  };
  const merged = mergeIdempotencySnapshot(disk, { version: 1, records: [] }, {
    ttlMs: 60000, maxEntries: 100, now: Date.now(), rejections,
  });
  assert.equal(merged.records.length, 1, "坏条目不进正式数据");
  assert.equal(rejections.total, 1, "但必须被计数");
  assert.equal(rejections.countOf("idempotency"), 1);
  assert.match(rejections.list()[0].reason, /状态不认识/);
  assert.equal(rejections.list()[0].item.key, "req-bad-00001", "留证里要能看出丢的是哪一条");
});

test("幂等：丢弃的原文要能看清是哪个请求编号", () => {
  const rejections = new RejectionLog();
  mergeIdempotencySnapshot({ version: 1, records: [{ key: "坏", state: "done" }] }, { version: 1, records: [] }, {
    ttlMs: 60000, maxEntries: 100, now: Date.now(), rejections,
  });
  assert.equal(rejections.total, 1);
  assert.match(rejections.list()[0].reason, /编号/);
});

test("工单：字段坏的工单被计数（它可能是未结案的）", () => {
  const rejections = new RejectionLog();
  const broken = { state: "open", packet: { id: "H-20261102-0001", reason: "suspended-funds", suspendedCents: "不是数字" } };
  mergeHandoffSnapshot({ version: 1, tickets: [broken] }, { version: 1, tickets: [] }, { limit: 100, rejections });
  assert.equal(rejections.countOf("handoff"), 1, "丢一张未结工单必须留证");
  assert.equal(rejections.list()[0].item.packet.id, "H-20261102-0001");
});

test("留证：写进 .rejected-*.json，含原文与原因", () => {
  const store = freshStore();
  store.rejections.reject("idempotency", "状态不认识：corrupted", { key: "req-bad-00001", state: "corrupted" });
  store.preserveRejected("idempotency");

  const file = path.join(store.dir, ".rejected-idempotency-0.json");
  assert.ok(existsSync(file), "留证文件必须落地");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.scope, "idempotency");
  assert.equal(saved.count, 1);
  assert.equal(saved.entries[0].item.key, "req-bad-00001");
  assert.match(saved.entries[0].reason, /状态不认识/);
});

test("留证：没有丢弃就不写文件（不留噪音）", () => {
  const store = freshStore();
  store.preserveRejected("idempotency");
  assert.equal(existsSync(path.join(store.dir, ".rejected-idempotency-0.json")), false);
});

test("留证：计数跨 store 汇总（客户账上的丢弃也要被看见）", () => {
  /* 幂等记录按客户分目录。只报根 store 的计数，就等于漏掉了
     所有客户账上的丢弃 —— 而恰恰是那里的幂等记录最要紧（丢一条，钱可能扣两次）。 */
  const root = freshStore();
  const user = root.forUser("u-1001");
  root.rejections.reject("audit", "审计行坏了", {});
  user.rejections.reject("idempotency", "状态不认识", {});
  user.rejections.reject("idempotency", "状态不认识", {});

  const counts = root.rejectionCounts();
  assert.equal(counts.audit, 1);
  assert.equal(counts.idempotency, 2, "两个 store 的同一类要加起来");
});

test("留证：汇总只算自己的子树，别把别的 store 算进来", () => {
  /* 汇总口径必须清楚：一个根 store 的读数不能被另一个无关 store 污染 ——
     否则运维面板上的数字会随时间漂移，没人说得清它代表什么。 */
  const first = freshStore();
  const second = freshStore();
  first.rejections.reject("audit", "x", {});
  second.rejections.reject("audit", "y", {});

  assert.equal(first.rejectionCounts().audit, 1, "只看得到自己的");
  assert.equal(second.rejectionCounts().audit, 1);
});

// ── 保证 5：坏文件留证 + 落盘只认文件名 ─────────────────────────────

test("落盘：只接受文件名，传绝对路径要报得清楚", () => {
  /* 这是一个真 bug：writeJson 收到绝对路径时，path.join 会把它再拼一遍目录，
     变成 dir\C:\... 这种怪路径，报 EPERM 完全看不出是「传了绝对路径」。
     修法是在 pathOf 统一拦一道，报「只接受文件名」。 */
  const store = freshStore();
  const absolute = path.join(store.dir, "state.json");
  assert.throws(() => store.pathOf(absolute), /只接受文件名/);
});

test("落盘：坏文件旁存留证，新档照样能写", () => {
  const store = freshStore();
  writeFileSync(path.join(store.dir, "sessions.json"), "{不是合法 JSON", "utf8");
  store.saveSessions({ version: 2, records: [] });
  assert.ok(existsSync(path.join(store.dir, "sessions.json")), "新档写成了");
  const preserved = readdirSync(store.dir).filter((name) => name.includes(".bad-"));
  assert.ok(preserved.length > 0, "坏文件被旁存留证，没有被直接删掉");
});
