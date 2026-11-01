#!/usr/bin/env node
// 状态装载的单测：三种结果必须分得开。
//
// 验的是「坏状态会不会被当成全新安装」这件事。以前两者都是 null，
// 于是文件被手改坏之后，程序拿初始余额照常开门 —— 界面正常、账目全错。
//
// 运行：node --test scripts/state-guard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileStore, checkState } from "../shared/persist.ts";
import { initialState } from "../shared/state.ts";

/** 每个用例一个独立目录：装载结果依赖磁盘上有什么，不能互相污染。 */
function freshStore() {
  return new FileStore(mkdtempSync(path.join(tmpdir(), "bank-guard-")));
}

function writeState(store, value) {
  writeFileSync(path.join(store.dir, "state.json"), typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

test("目录里没有状态文件：fresh，从初始值开始", () => {
  const loaded = freshStore().loadState();
  assert.equal(loaded.kind, "fresh");
  assert.equal(loaded.state.account.balance, initialState().account.balance);
});

test("正常写入再读回：disk，金额一致", () => {
  const store = freshStore();
  const state = initialState();
  // 两个字段一起改：只动 balance 会让 available 大于它，正好撞上下面那条不变量。
  state.account.balance = 4234567;
  state.account.available = 4234567;
  store.saveState(state);
  const loaded = store.loadState();
  assert.equal(loaded.kind, "disk");
  assert.equal(loaded.state.account.balance, 4234567);
});

test("半个 JSON：corrupt，并说明是解析失败", () => {
  const store = freshStore();
  writeState(store, '{"account":{"balance":100');
  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt");
  assert.match(loaded.reason, /合法 JSON/);
});

test("余额写成了字符串：corrupt，指出是哪个字段", () => {
  const store = freshStore();
  const state = initialState();
  writeState(store, { ...state, account: { ...state.account, balance: "很多钱" } });
  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt");
  assert.match(loaded.reason, /balance 不是数字/);
});

test("余额不是整数分：corrupt —— 全项目金额只用整数分", () => {
  const store = freshStore();
  const state = initialState();
  writeState(store, { ...state, account: { ...state.account, balance: 3.7 } });
  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt");
  assert.match(loaded.reason, /整数分/);
});

test("可用额度大于余额：corrupt —— available 是扣掉预锁之后的数，反了就是账错", () => {
  const store = freshStore();
  const state = initialState();
  writeState(store, { ...state, account: { ...state.account, balance: 100, available: 200 } });
  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt");
  assert.match(loaded.reason, /大于 balance/);
});

test("集合字段不是数组：corrupt，并报出字段名", () => {
  const store = freshStore();
  const state = initialState();
  writeState(store, { ...state, cards: "三张卡" });
  const loaded = store.loadState();
  assert.equal(loaded.kind, "corrupt");
  assert.match(loaded.reason, /cards 不是数组/);
});

test("读不出来时不再静默回落：readState 仍返回 null，但 loadState 报 corrupt", () => {
  const store = freshStore();
  writeState(store, "not json at all");
  assert.equal(store.readState(), null);
  assert.equal(store.loadState().kind, "corrupt");
});

test("上一版写的文件照样能读：缺的是新字段，不是坏数据", () => {
  // v1.6.1 之前的 state.json：没有 collections / birthdayGifts，
  // 持仓只有 id / productId / amountCents 三个字段。
  const store = freshStore();
  const state = initialState();
  const legacy = { ...state, holdings: [{ id: "h1", productId: "wm-001", amountCents: 500000 }] };
  delete legacy.collections;
  delete legacy.birthdayGifts;
  writeState(store, legacy);

  const loaded = store.loadState();
  assert.equal(loaded.kind, "disk", "老文件不能因为少字段被拒");
  assert.deepEqual(loaded.state.collections, []);
  assert.deepEqual(loaded.state.birthdayGifts, []);
  const holding = loaded.state.holdings[0];
  assert.equal(holding.accruedMilliCents, 0, "缺的按刚买入、零收益补齐");
  assert.equal(typeof holding.boughtAt, "number", "不能让 undefined 流进金额计算");
  assert.equal(holding.amountCents, 500000);
});

test("纯函数直接查：返回原因而不是 null", () => {
  const bad = checkState({ account: { balance: 1, available: 1 } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /contacts 不是数组/);

  const good = checkState(initialState());
  assert.equal(good.ok, true);
});
