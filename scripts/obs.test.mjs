#!/usr/bin/env node
// 可运维三件套的单测：traceId、指标、日志、限流。
// 全部纯函数 + 注入时钟，不起服务、不碰网络、不依赖系统时间 —— 靠 sleep 的测试又慢又飘。
// 运行：node --test scripts/obs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { annotateTrace, currentTrace, currentTraceId, newTraceId, runWithTrace } from "../shared/trace.ts";
import { AuditChain } from "../shared/rules.ts";
import { createLogger, logText, Metrics } from "../track-pi/src/obs.ts";
import { bucketsFromEnv, TokenBuckets } from "../track-pi/src/ratelimit.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一条最小可用的审计输入：只关心 traceId 相关的行为，别的字段填够即可。 */
const auditInput = (over = {}) => ({
  sessionId: "s-1",
  actor: "u-1/standard",
  userText: "查一下余额",
  tool: "query_balance",
  decision: "auto_execute",
  level: "green",
  rules: ["base-level"],
  result: "可用余额 1.00 元",
  ...over,
});

/* ───────────────────────────── traceId ───────────────────────────── */

test("traceId：16 位十六进制，一千次不重", () => {
  const seen = new Set();
  for (let index = 0; index < 1000; index += 1) {
    const id = newTraceId();
    assert.match(id, /^[0-9a-f]{16}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
});

test("traceId：同步与异步都能读到同一个值", async () => {
  const context = { traceId: "abc123", startedAt: Date.now() };
  const sync = runWithTrace(context, () => currentTraceId());
  assert.equal(sync, "abc123");

  // 关键一条：await 之后还在。链条断在这里是最难发现的 —— 不报错，只是审计少个字段。
  const asyncId = await runWithTrace(context, async () => {
    await sleep(5);
    return currentTraceId();
  });
  assert.equal(asyncId, "abc123");
});

test("traceId：没有上下文时是 undefined，不伪造一个", () => {
  assert.equal(currentTrace(), undefined);
  assert.equal(currentTraceId(), undefined);
});

test("traceId：嵌套时内层覆盖，退出后外层恢复", () => {
  runWithTrace({ traceId: "outer", startedAt: 1 }, () => {
    assert.equal(currentTraceId(), "outer");
    runWithTrace({ traceId: "inner", startedAt: 2 }, () => assert.equal(currentTraceId(), "inner"));
    assert.equal(currentTraceId(), "outer");
  });
  assert.equal(currentTraceId(), undefined);
});

test("traceId：身份是在解析令牌之后才知道的，能就地补进上下文", () => {
  runWithTrace({ traceId: "t1", startedAt: 1 }, () => {
    annotateTrace({ method: "chat", userId: "u-1001", sessionId: "u-1001:web:1" });
    const context = currentTrace();
    assert.equal(context.method, "chat");
    assert.equal(context.userId, "u-1001");
    assert.equal(context.sessionId, "u-1001:web:1");
  });
});

test("traceId：没有上下文时 annotate 不抛（探针、启动补拍走的就是这条路）", () => {
  assert.doesNotThrow(() => annotateTrace({ method: "chat" }));
});

/* ──────────────────────── 审计记录里的 traceId ──────────────────────── */

test("审计：有上下文时写入 traceId", () => {
  const chain = new AuditChain();
  const record = runWithTrace({ traceId: "trace-001", startedAt: Date.now() }, () => chain.append(auditInput()));
  assert.equal(record.traceId, "trace-001");
});

test("审计：没有上下文时不写这个字段，也不写 null", () => {
  const chain = new AuditChain();
  const record = chain.append(auditInput());
  assert.equal(record.traceId, undefined);
  // 「字段不存在」和「字段是 null」在存储上不一样：后者会让旧格式校验器认不出来。
  assert.equal("traceId" in record, false);
  assert.equal(JSON.stringify(record).includes("traceId"), false);
});

test("审计：旧格式记录（无 traceId）换新版本仍能通过校验", () => {
  // 这是加字段时最容易砸的坑：给 payload 加一项，历史记录的哈希就全对不上了，
  // 而「链断了」在银行场景里等于全部账目失效。
  const legacy = new AuditChain();
  legacy.append(auditInput({ sessionId: "old-1" }));
  legacy.append(auditInput({ sessionId: "old-2", decision: "requires_confirm", level: "yellow" }));
  const revived = new AuditChain(undefined, legacy.list(undefined, 10));
  assert.deepEqual(revived.verify(), { ok: true, total: 2, brokenAt: null });
});

test("审计：新旧记录混在一条链上也能通过校验", () => {
  const chain = new AuditChain();
  chain.append(auditInput({ sessionId: "old" }));
  runWithTrace({ traceId: "trace-new", startedAt: Date.now() }, () => chain.append(auditInput({ sessionId: "new" })));
  assert.equal(chain.verify().ok, true);
});

test("审计：改掉 traceId 会被链校验抓出来", () => {
  const chain = new AuditChain();
  runWithTrace({ traceId: "trace-orig", startedAt: Date.now() }, () => chain.append(auditInput()));
  const record = chain.list(undefined, 1).at(-1);
  record.traceId = "trace-forged";
  assert.equal(chain.verify().ok, false, "traceId 参与哈希，改了就断链");
});

/* ───────────────────────────── 指标 ───────────────────────────── */

test("指标：计数器按标签分系列，同名标签顺序不影响归并", () => {
  const metrics = new Metrics();
  const counter = metrics.counter("t_total", "测试用");
  counter.inc({ method: "chat", status: "200" });
  counter.inc({ status: "200", method: "chat" });
  counter.inc({ method: "chat", status: "500" });
  assert.equal(counter.get({ method: "chat", status: "200" }), 2);
  assert.equal(counter.get({ status: "500", method: "chat" }), 1);
  assert.equal(counter.get({ method: "state", status: "200" }), 0);
});

test("指标：直方图的 le 是累计值，+Inf 等于总数", () => {
  const metrics = new Metrics();
  const histogram = metrics.histogram("t_ms", "测试用", [10, 20]);
  histogram.observe({ m: "chat" }, 5);
  histogram.observe({ m: "chat" }, 15);
  histogram.observe({ m: "chat" }, 25);
  const text = metrics.render();
  const bucket = (le) => Number(new RegExp(`t_ms_bucket\\{m="chat",le="${le.replace("+", "\\+")}"\\} (\\d+)`).exec(text)?.[1]);
  assert.equal(bucket("10"), 1);
  assert.equal(bucket("20"), 2);
  assert.equal(bucket("+Inf"), 3);
  assert.match(text, /t_ms_count\{m="chat"\} 3/);
  assert.match(text, /t_ms_sum\{m="chat"\} 45/);
});

test("指标：一条样本都没有时仍输出 HELP 与 TYPE", () => {
  const metrics = new Metrics();
  metrics.counter("t_empty", "空的");
  const text = metrics.render();
  assert.match(text, /# HELP t_empty 空的/);
  assert.match(text, /# TYPE t_empty counter/);
});

test("指标：标签里的引号与换行被转义，抓取端不会解析错位", () => {
  const metrics = new Metrics();
  metrics.counter("t_esc", "转义").inc({ note: 'a"b\nc\\d' });
  const text = metrics.render();
  assert.match(text, /note="a\\"b\\nc\\\\d"/);
  // 转义之后仍然是单行：多一行就意味着多一条样本。
  assert.equal(text.trimEnd().split("\n").length, 3);
});

test("指标：同一份数据渲染两次逐字节相同", () => {
  const metrics = new Metrics();
  metrics.counter("t_stable", "稳定").inc({ b: "2" });
  metrics.counter("t_stable", "稳定").inc({ a: "1" });
  metrics.histogram("t_stable_ms", "稳定").observe({}, 3);
  assert.equal(metrics.render(), metrics.render());
});

test("指标：gauge 在渲染时现取，不缓存旧值", () => {
  let value = 1;
  const metrics = new Metrics();
  metrics.gauge("t_gauge", "读数", () => [{ labels: { kind: "x" }, value }]);
  assert.match(metrics.render(), /t_gauge\{kind="x"\} 1/);
  value = 7;
  assert.match(metrics.render(), /t_gauge\{kind="x"\} 7/);
});

test("指标：JSON 视图与文本视图是同一份数据", () => {
  const metrics = new Metrics();
  metrics.counter("t_json", "两副面孔").inc({ a: "b" });
  const json = metrics.toJSON();
  assert.equal(json.t_json.type, "counter");
  assert.ok(json.t_json.samples.join("\n").includes('t_json{a="b"} 1'));
});

/* ───────────────────────────── 日志 ───────────────────────────── */

function collect() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test("日志：JSON 一行一条，可直接被采集", () => {
  const sink = collect();
  const logger = createLogger({ format: "json", write: sink.write, now: () => 1_700_000_000_000 });
  logger.info("chat", { scene: "bills", decision: "green" });
  assert.equal(sink.lines.length, 1);
  const line = JSON.parse(sink.lines[0]);
  assert.equal(line.event, "chat");
  assert.equal(line.level, "info");
  assert.equal(line.scene, "bills");
  assert.equal(line.ts, new Date(1_700_000_000_000).toISOString());
});

test("日志：业务字段叫 level 也改不掉日志自己的级别", () => {
  // 这条是踩出来的：一开始把判定结果写成 level，结果 INFO 被覆盖成 GREEN，
  // 按级别配的告警规则全部失效，而且没有任何报错。
  const sink = collect();
  const logger = createLogger({ format: "json", write: sink.write });
  logger.error("chat", { level: "green" });
  assert.equal(JSON.parse(sink.lines[0]).level, "error");
});

test("日志：令牌类字段一律丢弃，写了也不会出去", () => {
  const sink = collect();
  const logger = createLogger({ format: "json", write: sink.write });
  logger.info("rpc", { token: "dG9r", authorization: "Bearer x", cookie: "a=1", apiKey: "sk-1", ok: true });
  const line = JSON.parse(sink.lines[0]);
  for (const key of ["token", "authorization", "cookie", "apiKey"]) assert.equal(key in line, false, `${key} 不该出现`);
  assert.equal(line.ok, true);
});

test("日志：LOG_USER_TEXT=off 时用户原话不落盘", () => {
  const sink = collect();
  const logger = createLogger({ format: "json", userText: false, write: sink.write });
  logger.info("chat", { userText: "转给小王 100 元" });
  assert.equal("userText" in JSON.parse(sink.lines[0]), false);
});

test("日志：级别过滤生效，warn 之上才输出", () => {
  const sink = collect();
  const logger = createLogger({ format: "json", level: "warn", write: sink.write });
  logger.info("chat", {});
  logger.debug("chat", {});
  logger.warn("ratelimit.rejected", {});
  logger.error("boom", {});
  assert.deepEqual(
    sink.lines.map((line) => JSON.parse(line).level),
    ["warn", "error"],
  );
});

test("日志：traceId 自动带上，不用业务代码记得传", () => {
  const sink = collect();
  const logger = createLogger({ format: "json", write: sink.write });
  runWithTrace({ traceId: "trace-log", startedAt: Date.now(), method: "chat", userId: "u-1001" }, () => {
    logger.info("chat", { scene: "bills" });
  });
  const line = JSON.parse(sink.lines[0]);
  assert.equal(line.traceId, "trace-log");
  assert.equal(line.method, "chat");
  assert.equal(line.userId, "u-1001");
});

test("日志：文本格式人类可读，且不带 JSON 花括号", () => {
  const sink = collect();
  const logger = createLogger({ format: "text", write: sink.write });
  logger.info("chat", { scene: "bills" });
  assert.match(sink.lines[0], /^\[info\] chat /);
  assert.equal(sink.lines[0].includes("{"), false);
});

test("日志：原话截断到 80 字，不让一句话撑爆一整行", () => {
  const long = "转".repeat(200);
  const cut = logText(long);
  assert.equal(cut.length, 81);
  assert.ok(cut.endsWith("…"));
  assert.equal(logText("  转给   小王 100  "), "转给 小王 100");
});

/* ───────────────────────────── 限流 ───────────────────────────── */

/** 可拨的假时钟：测试不 sleep，也不受系统时间被改的影响。 */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test("限流：突发额度用完就拦，并说出多久后再来", () => {
  const time = clock();
  const buckets = new TokenBuckets({ capacity: 2, refillPerSecond: 1, now: time.now });
  assert.equal(buckets.take("u-1").ok, true);
  assert.equal(buckets.take("u-1").ok, true);
  const denied = buckets.take("u-1");
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterMs, 1000, "1 个令牌 / 每秒 1 个 = 1000ms");
});

test("限流：按客户分开计数，一个人刷不爆另一个人的额度", () => {
  const time = clock();
  const buckets = new TokenBuckets({ capacity: 1, refillPerSecond: 1, now: time.now });
  assert.equal(buckets.take("u-1").ok, true);
  assert.equal(buckets.take("u-1").ok, false);
  assert.equal(buckets.take("u-2").ok, true);
});

test("限流：时间过去后按速率补回，不是整段恢复", () => {
  const time = clock();
  const buckets = new TokenBuckets({ capacity: 2, refillPerSecond: 1, now: time.now });
  buckets.take("u-1");
  buckets.take("u-1");
  time.advance(600);
  assert.equal(buckets.take("u-1").ok, false, "0.6 个令牌不够一个");
  assert.equal(buckets.take("u-1").retryAfterMs, 400);
  time.advance(400);
  assert.equal(buckets.take("u-1").ok, true);
});

test("限流：补充不超过容量，闲置再久也不会攒出一个超大突发", () => {
  const time = clock();
  const buckets = new TokenBuckets({ capacity: 3, refillPerSecond: 1, now: time.now });
  time.advance(60_000);
  assert.equal(buckets.peek("u-1"), 3);
  assert.equal(buckets.take("u-1").ok, true);
  assert.equal(buckets.peek("u-1"), 2);
});

test("限流：清理只清已经补满的桶，欠账的留着", () => {
  const time = clock();
  const buckets = new TokenBuckets({ capacity: 2, refillPerSecond: 10, now: time.now });
  buckets.take("fresh");
  buckets.take("drained");
  buckets.take("drained");
  // fresh 只用了 1 个，0.1 秒后补满；drained 用了 2 个，0.1 秒后只补 1 个。
  time.advance(100);
  const removed = buckets.sweep();
  assert.equal(removed, 1);
  assert.equal(buckets.size, 1);
});

test("限流：从环境变量读配额，0 表示关掉", () => {
  assert.equal(bucketsFromEnv({ RATE_LIMIT_PER_MINUTE: "0" }), undefined);
  assert.equal(bucketsFromEnv({ RATE_LIMIT_PER_MINUTE: "-5" }), undefined);
  assert.equal(bucketsFromEnv({ RATE_LIMIT_PER_MINUTE: "abc" }), undefined);

  const buckets = bucketsFromEnv({ RATE_LIMIT_PER_MINUTE: "60" });
  assert.equal(buckets.refillPerMinute, 60);
  assert.equal(buckets.burst, 20, "默认突发取一分钟配额的三分之一");

  const tuned = bucketsFromEnv({ RATE_LIMIT_PER_MINUTE: "12", RATE_LIMIT_BURST: "4" });
  assert.equal(tuned.refillPerMinute, 12);
  assert.equal(tuned.burst, 4);
});
