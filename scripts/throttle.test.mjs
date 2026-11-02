#!/usr/bin/env node
// 限流退避：客户端这一侧。
//
// 服务端按 HTTP 标准回 `429` + `retry-after`。客户端以前把它渲染成红色「请求失败」——
// 但那不是失败，是「等一下再来」。这个文件把退避的语义钉住：
//
//   · 认 `retry-after`，按它等（不认就退化成固定的 1 秒）；
//   · 限流会重试，普通错误不重试（重试也救不回来的错，不该假装能救）；
//   · 重试用尽仍被限流，如实抛出去，由页面决定怎么说；
//   · 限流在服务端发生在建 Agent 之前，所以重发是安全的 —— 这一条靠
//     `track-pi/src/index.ts` 里「认证 → 限流 → 建 Agent」的顺序保证。
//
// 运行：node --test scripts/throttle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isThrottled,
  readRetryAfterMs,
  throttleSignal,
  withThrottleRetry,
  THROTTLE_DEFAULT_WAIT_MS,
  THROTTLE_MAX_RETRIES,
  THROTTLE_MAX_WAIT_MS,
} from "../web/src/throttle.ts";

/** 造一个只看得到一个头的假 headers。 */
function headers(map) {
  return { get: (name) => (name in map ? map[name] : null) };
}

test("限流：认 retry-after，按它等", () => {
  assert.equal(readRetryAfterMs(headers({ "retry-after": "3" })), 3000);
  assert.equal(readRetryAfterMs(headers({ "retry-after": "1" })), 1000);
});

test("限流：retry-after 缺失或者看不懂，就用兜底的一秒", () => {
  assert.equal(readRetryAfterMs(headers({})), THROTTLE_DEFAULT_WAIT_MS);
  assert.equal(readRetryAfterMs(headers({ "retry-after": "soon" })), THROTTLE_DEFAULT_WAIT_MS);
  assert.equal(readRetryAfterMs(headers({ "retry-after": "-5" })), THROTTLE_DEFAULT_WAIT_MS);
  assert.equal(readRetryAfterMs(null), THROTTLE_DEFAULT_WAIT_MS);
});

test("限流：再久也不该把页面按死，封顶五秒", () => {
  assert.equal(readRetryAfterMs(headers({ "retry-after": "600" })), THROTTLE_MAX_WAIT_MS);
});

test("限流：只有 429 才算限流，其它状态码是真失败", () => {
  assert.ok(throttleSignal(429, headers({ "retry-after": "2" }), "太频繁") !== null);
  assert.equal(throttleSignal(500, headers({}), "服务器炸了"), null);
  assert.equal(throttleSignal(400, headers({}), "参数不对"), null);
  assert.equal(throttleSignal(200, headers({}), "正常"), null);
});

test("限流：限流错误带标记，认得出来", () => {
  const signal = throttleSignal(429, headers({ "retry-after": "1" }), "请求太频繁");
  assert.ok(signal !== null);
  assert.equal(isThrottled(signal), true);
  assert.equal(isThrottled(new Error("普通错误")), false);
  assert.equal(isThrottled(null), false);
  assert.equal(isThrottled("字符串"), false);
});

test("限流：撞上限流会等够时间再重试，然后成功", async () => {
  const waited = [];
  let attempts = 0;
  const result = await withThrottleRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw throttleSignal(429, headers({ "retry-after": "2" }), "请求太频繁");
      return "办完了";
    },
    { sleep: async (ms) => { waited.push(ms); } },
  );
  assert.equal(result, "办完了");
  assert.equal(attempts, 3, "前两次限流、第三次成功");
  assert.deepEqual(waited, [2000, 2000], "每次都按 retry-after 等，不多等也不少等");
});

test("限流：重试用尽仍被限流，就如实抛出去", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withThrottleRetry(
        async () => {
          attempts += 1;
          throw throttleSignal(429, headers({ "retry-after": "1" }), "请求太频繁");
        },
        { sleep: async () => {} },
      ),
    (error) => {
      assert.equal(isThrottled(error), true, "抛出去的还是限流错误，页面知道该怎么说");
      assert.equal(error.retryAfterMs, 1000);
      return true;
    },
  );
  assert.equal(attempts, THROTTLE_MAX_RETRIES + 1, "初次 + 两次重试，不无限重试");
});

test("限流：普通错误不重试 —— 重试也救不回来的错，不该假装能救", async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withThrottleRetry(
        async () => {
          attempts += 1;
          throw new Error("服务器炸了");
        },
        { sleep: async () => {} },
      ),
    /服务器炸了/,
  );
  assert.equal(attempts, 1, "一次就过，没有重试");
});

test("限流：重试前会喊一声，页面据此告诉用户在等", async () => {
  const notes = [];
  let attempts = 0;
  await withThrottleRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw throttleSignal(429, headers({ "retry-after": "1" }), "请求太频繁");
      return "ok";
    },
    { sleep: async () => {}, onRetry: (info) => notes.push(info.attempt) },
  );
  assert.deepEqual(notes, [1], "要重试时通知一次，通知里带上第几次");
});
