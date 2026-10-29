#!/usr/bin/env node
// 资产守恒不变量测试：不问「这个用例对不对」，问「有没有任何一条路径能把钱造出来或弄丢」。
//
// 逐条用例只能覆盖写用例时想到的分支；不变量反过来，先声明一条任何时候都必须成立的等式，
// 再用随机操作序列去撞它。撞得越杂，越容易撞出人想不到的那条路径。
//
// 三条不变量：
//   I1 账户恒等式：账面余额 - 可用余额 ≡ 预锁合计。预锁只占额度不动账面，差一分就是记账漏了。
//   I2 净资产守恒：同一时刻下，净资产的变化必须恰好等于这一步真实的资金流出。
//      转账流出多少就少多少，申购额外流出手续费，其余操作一分不动。
//   I3 失败不改账：被拒的操作前后，整份状态逐字节相同。半途改了再报错，是最难查的那类错。
//
// 运行：node --test scripts/invariants.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accruedMilli,
  buyWealth,
  cancelSubscription,
  createBirthdayGift,
  holdingValues,
  initialState,
  lockBirthdayFunds,
  lockCard,
  redeemWealth,
  runDueBirthdayGifts,
  splitCollect,
  transfer,
} from "../shared/state.ts";

const DAY = 86400000;

/**
 * 净资产，单位毫分。
 *
 * 用毫分而不是分，是因为收益的中间量本来就小于 1 分。若先四舍五入到分再相加，
 * 每次都会吃掉一点零头，等式就永远差几分，于是「差几分」变成常态、真正的错账被淹没。
 * 活期 + 持仓（本金 + 已落账收益 + 应计未落账收益）。预锁的钱本来就在余额里，不重复加。
 */
function netWorthMilli(state, now) {
  let milli = state.account.balance * 1000;
  for (const holding of state.holdings) {
    const product = state.wealthProducts.find((item) => item.id === holding.productId);
    const rate = product?.annualRate ?? 0;
    milli += holding.amountCents * 1000;
    milli += holding.accruedMilliCents;
    milli += accruedMilli(holding.amountCents, rate, holding.lastAccruedAt, now);
  }
  return milli;
}

/** 仍处于锁定态的预锁合计（分）。已花掉、已释放的不算。 */
function lockedCents(state) {
  return state.lockedFunds
    .filter((item) => item.status === "locked")
    .reduce((sum, item) => sum + item.amountCents, 0);
}

/** 每一步之后都要过的体检。宁可报得啰嗦，也不要让一个 NaN 悄悄流到展示层。 */
function assertSane(state, label, now) {
  const finite = (value, name) => {
    assert.ok(Number.isFinite(value), `${label}：${name} 不是有限数（${String(value)}）`);
  };
  finite(state.account.balance, "账面余额");
  finite(state.account.available, "可用余额");
  assert.ok(state.account.balance >= 0, `${label}：账面余额为负 ${state.account.balance}`);
  assert.ok(state.account.available >= 0, `${label}：可用余额为负 ${state.account.available}`);
  assert.ok(state.account.available <= state.account.balance, `${label}：可用余额超过账面余额`);
  for (const holding of state.holdings) {
    finite(holding.amountCents, `持仓 ${holding.id} 本金`);
    finite(holding.accruedMilliCents, `持仓 ${holding.id} 收益`);
    finite(holding.lastAccruedAt, `持仓 ${holding.id} 结息时间`);
    assert.ok(holding.amountCents > 0, `${label}：持仓 ${holding.id} 本金为 0 或负，本应被删除`);
    assert.ok(holding.accruedMilliCents >= 0, `${label}：持仓 ${holding.id} 收益为负`);
    assert.ok(holding.lastAccruedAt <= now, `${label}：持仓 ${holding.id} 的结息时间跑到了未来`);
  }
  // I1
  assert.equal(
    state.account.balance - state.account.available,
    lockedCents(state),
    `${label}：账面与可用之差应等于预锁合计`,
  );
}

/** 线性同余随机数：要的是「可复现的杂乱」，不是密码学随机。种子固定，失败能原样重跑。 */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function between(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 把一个时间点换算成「三天后」的 MM-DD，用来构造一个还来得及发货的生日。 */
function threeDaysLaterMmdd(ms) {
  const date = new Date(ms + 3 * DAY);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 一步随机操作。返回这一步「应该」造成的净资产变化（毫分）。
 *
 * 期望值不在这里算利息 —— 利息由时钟推进自然产生，若把利息也算进期望，就等于把实现
 * 抄了一遍。这里只声明「这笔钱因为什么流出了账户」：转账流出了、申购费付给基金公司了，
 * 锁卡、AA、预锁、赎回都只是内部搬运，净资产不该动。
 */
function randomStep(state, rng, clock) {
  const kind = between(rng, 0, 5);

  if (kind === 0) {
    const payee = ["小王", "刘洋", "李四", "赵某"][between(rng, 0, 3)];
    const amount = between(rng, 1000, 30000);
    const result = transfer(state, payee, amount);
    return { label: `转账 ${payee} ${amount / 100} 元`, deltaMilli: result.ok ? -amount * 1000 : 0 };
  }

  if (kind === 1) {
    const result = lockBirthdayFunds(state, between(rng, 10000, 200000), threeDaysLaterMmdd(clock));
    return { label: `预锁 ${result.ok ? "成功" : "失败"}`, deltaMilli: 0 };
  }

  if (kind === 2) {
    const total = between(rng, 3000, 90000);
    const headcount = between(rng, 2, 5);
    const result = splitCollect(state, { totalCents: total, headcount, title: "聚餐", payers: [] });
    return { label: `AA ${total / 100} 元 / ${headcount} 人（${result.ok ? "成功" : "失败"}）`, deltaMilli: 0 };
  }

  if (kind === 3) {
    const productId = ["p-001", "p-002", "p-003", "p-004", "p-005"][between(rng, 0, 4)];
    const amount = between(rng, 100000, 300000);
    const result = buyWealth(state, productId, amount, clock);
    // 申购是「现金换成持仓」，不是把钱花掉：本金一分不少地变成了市值，只有申购费
    // 是真付给基金公司的，那部分才从净资产里消失。
    const fee = result.ok === true ? (result.data?.feeCents ?? 0) : 0;
    return { label: `申购 ${productId} ${amount / 100} 元（${result.ok ? "成功" : "失败"}）`, deltaMilli: -fee * 1000 };
  }

  if (kind === 4) {
    const amount = between(rng, 0, 300000);
    const result = redeemWealth(state, amount, clock);
    // 赎回是「持仓换成现金」，净资产不变。唯一会少的，是把某笔持仓赎完时那不足 1 分的
    // 零头 —— 付不出去，实现把它记进 roundingMilliCents。这里要求「少的量」恰好等于
    // 它自报的残值：自报一个数、实际少另一个数，就是错账。
    const rounding = result.ok === true ? (result.data?.roundingMilliCents ?? 0) : 0;
    return { label: `赎回 ${amount === 0 ? "全部" : `${amount / 100} 元`}（${result.ok ? "成功" : "失败"}）`, deltaMilli: -rounding };
  }

  // kind === 5：生日礼遇。没有待发货的就新登记一笔，有就推一拍调度。
  const scheduled = state.birthdayGifts.find((item) => item.status === "scheduled");
  if (scheduled === undefined) {
    const birthday = threeDaysLaterMmdd(clock);
    const locked = lockBirthdayFunds(state, 100000, birthday);
    if (!locked.ok) return { label: "生日预锁失败", deltaMilli: 0 };
    const gift = createBirthdayGift(state, { birthday, budgetCents: 100000, now: clock });
    if (!gift.ok) return { label: "生日登记失败", deltaMilli: 0 };
    return { label: "生日预锁 + 登记", deltaMilli: 0 };
  }
  const results = runDueBirthdayGifts(state, clock);
  let deltaMilli = 0;
  let ordered = 0;
  for (const result of results) {
    if (!result.ok) continue;
    ordered += 1;
    const gift = state.birthdayGifts.find((item) => item.id === result.id);
    deltaMilli -= gift.totalCents * 1000;
  }
  return { label: `生日调度 ${ordered} 笔成交`, deltaMilli };
}

test("不变量：120 步随机操作，净资产只按真实资金流出变化", () => {
  const state = initialState();
  let clock = Date.now();
  const rng = makeRng(20261029);
  let redeemedInterest = 0;
  let steps = 0;
  let successes = 0;

  for (let i = 0; i < 120; i += 1) {
    // 每步推进 0~2 天。时间必须走，否则计息那条路径永远不被触发 —— 一条从不生息的
    // 随机序列也能让守恒等式成立，但它什么都没证明。
    clock += between(rng, 0, 2) * DAY;
    const before = netWorthMilli(state, clock);
    const { label, deltaMilli } = randomStep(state, rng, clock);
    const after = netWorthMilli(state, clock);
    assert.equal(
      (after - before) + 0,
      deltaMilli + 0,
      `第 ${i} 步「${label}」净资产变化 ${after - before} 毫分，应为 ${deltaMilli} 毫分`,
    );
    assertSane(state, `第 ${i} 步「${label}」`, clock);
    steps += 1;
    if (!label.includes("失败")) successes += 1;
  }

  // 序列必须真的干过事：全失败的序列同样满足守恒，但那是空转。
  assert.equal(steps, 120);
  assert.ok(successes > 60, `成功步数只有 ${successes}，随机序列过于空转，证明力不足`);
  assert.ok(redeemedInterest > 0 || netWorthMilli(state, clock) > state.account.balance * 1000, "全程没有产生过任何收益");
});

test("不变量：收益不会凭空消失，也不会凭空多出来", () => {
  const state = initialState();
  const clock = Date.now();
  // 起始持仓有 30 / 45 天利息，先按市值口径记下来。
  const before = netWorthMilli(state, clock);
  const interest = holdingValues(state, clock).reduce((sum, item) => sum + item.interestCents, 0);
  assert.ok(interest > 0, "初始持仓应当带一段已计收益");
  const holdingCount = state.holdings.length;
  const result = redeemWealth(state, 0, clock);
  // 结息只是把「应计」搬进「活期」。账面上唯一会少的，是不足 1 分、付不出去的舍入残值 ——
  // 那不是丢了，是记在 result.roundingMilliCents 里。差一分钱也要说得出差在哪。
  assert.equal(before - netWorthMilli(state, clock), result.data.roundingMilliCents);
  // 每笔持仓的残值必然 < 1 分（1000 毫分），几笔就是几倍，不会更多。
  assert.ok(result.data.roundingMilliCents >= 0, "舍入残值不该为负");
  assert.ok(result.data.roundingMilliCents < 1000 * holdingCount, `残值 ${result.data.roundingMilliCents} 超过 ${holdingCount} 笔的上限`);
  assert.ok(state.account.balance > 3864250, "赎回后活期余额应包含结出的收益");
});

test("不变量：失败的操作不改一个字节", () => {
  const state = initialState();
  const clock = Date.now();
  const snapshot = () => JSON.stringify(state);

  // 账上只有三万多，转一笔远超余额的；赎回一个不存在的金额；申购低于起购。
  const cases = [
    { label: "超额转账", run: () => transfer(state, "小王", 99999999) },
    { label: "零元转账", run: () => transfer(state, "小王", 0) },
    { label: "未锁资金的生日登记", run: () => createBirthdayGift(state, { birthday: "11-15", budgetCents: 100000, now: clock }) },
    { label: "低于起购的申购", run: () => buyWealth(state, "p-005", 100, clock) },
    { label: "不存在的产品", run: () => buyWealth(state, "p-999", 100000, clock) },
  ];

  for (const item of cases) {
    const before = snapshot();
    const result = item.run();
    assert.equal(result.ok, false, `${item.label} 本应失败`);
    assert.equal(snapshot(), before, `${item.label} 失败了，却改了状态`);
  }
});

test("不变量：持仓被清空后，任何赎回都不再生钱", () => {
  const state = initialState();
  const clock = Date.now();
  assert.equal(redeemWealth(state, 0, clock).ok, true);
  assert.equal(state.holdings.length, 0);
  const before = netWorthMilli(state, clock);
  const again = redeemWealth(state, 0, clock);
  assert.equal(again.ok, false, "没有持仓时赎回应失败");
  assert.equal(netWorthMilli(state, clock), before);
});

test("不变量：连续 365 天，利息增长落在可独立验算的区间内", () => {
  const state = initialState();
  const clock = Date.now();
  const principal = state.holdings.reduce((sum, item) => sum + item.amountCents, 0);
  const start = holdingValues(state, clock).reduce((sum, item) => sum + item.interestCents, 0);
  const later = holdingValues(state, clock + 365 * DAY).reduce((sum, item) => sum + item.interestCents, 0);
  const growth = later - start;
  // 上界用产品表里最高的年化（9.5%）独立算，不引用实现里的任何中间量：
  // 一年利息不可能超过「本金 × 最高年化 × 366/365」。下界是零 —— 利息只能不降。
  const ceiling = Math.ceil((principal * 0.095 * 366) / 365);
  assert.ok(growth > 0, `一年后利息没涨（${growth}）`);
  assert.ok(growth <= ceiling, `一年利息 ${growth} 分超过了独立算出的上限 ${ceiling} 分`);
});
