#!/usr/bin/env node
// 优雅退出的单测。
//
// 验的是「关掉的那一刻」：新请求不再接、手上这几笔要办完、办不完要有上限，
// 以及重复信号不能把退出流程走两遍。
//
// 为什么不在这里发真信号：Windows 上 process.kill(pid, 'SIGTERM') 是直接终止进程，
// 不触发监听器，测不出任何东西。信号接线本身在 Linux 上是 Node 标准行为，
// 这里测的是接上去之后的逻辑。
//
// 运行：node --test scripts/lifecycle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

import { Shutdown } from "../track-pi/src/lifecycle.ts";

function harness(options = {}) {
  const events = [];
  const exits = [];
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const shutdown = new Shutdown({
    timeoutMs: options.timeoutMs ?? 40,
    log: (line) => events.push(line),
    exit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
    close: () => {
      events.push("close");
      options.onClose?.();
    },
  });
  return { shutdown, events, exits, exited };
}

test("没有在途请求：收到信号立刻退，退出码 0", async () => {
  const { shutdown, events, exits, exited } = harness();
  shutdown.begin("SIGTERM");
  assert.equal(await exited, 0);
  assert.deepEqual(exits, [0]);
  assert.ok(events.includes("close"), "应先停监听再退出");
  assert.ok(events.join("\n").includes("无在途请求"));
});

test("有一笔在途：先不退，等它办完再退", async () => {
  const { shutdown, exits, exited } = harness({ timeoutMs: 1000 });
  assert.equal(shutdown.enter(), true);
  shutdown.begin("SIGTERM");
  await sleep(30);
  assert.deepEqual(exits, [], "在途没清空就不该退出");
  assert.equal(shutdown.inflightCount, 1);
  shutdown.leave();
  assert.equal(await exited, 0);
});

test("退出中不再接新活：enter 返回 false，不计入在途", () => {
  const { shutdown } = harness({ timeoutMs: 1000 });
  shutdown.enter();
  shutdown.begin("SIGINT");
  assert.equal(shutdown.draining, true);
  assert.equal(shutdown.enter(), false);
  assert.equal(shutdown.inflightCount, 1, "被拒的请求不该占住计数");
});

test("在途迟迟不归零：等到上限就退，退出码 1 并说明还剩几笔", async () => {
  const { shutdown, events, exited } = harness({ timeoutMs: 30 });
  shutdown.enter();
  shutdown.begin("SIGTERM");
  assert.equal(await exited, 1);
  const text = events.join("\n");
  assert.ok(text.includes("等待超时"));
  assert.ok(text.includes("1 笔仍未返回"));
});

test("守着一个永远不会返回的请求，进程也不会被无限挂住", async () => {
  // 这正是「等上游响应」卡死的形状：不超时就是僵尸进程。
  const { shutdown, exited } = harness({ timeoutMs: 20 });
  shutdown.enter();
  shutdown.enter();
  shutdown.begin("SIGTERM");
  assert.equal(await exited, 1);
  assert.equal(shutdown.phaseName, "done");
});

test("重复信号：第二次不再等，直接退", async () => {
  const { shutdown, events, exits, exited } = harness({ timeoutMs: 1000 });
  shutdown.enter();
  shutdown.begin("SIGTERM");
  shutdown.begin("SIGTERM");
  assert.equal(await exited, 1);
  assert.deepEqual(exits, [1], "退出只能发生一次");
  assert.ok(events.join("\n").includes("再次收到 SIGTERM"));
});

test("退出只走一次：收尾后再 leave 不会触发第二次退出", async () => {
  const { shutdown, exits, exited } = harness({ timeoutMs: 1000 });
  shutdown.enter();
  shutdown.begin("SIGTERM");
  shutdown.leave();
  assert.equal(await exited, 0);
  shutdown.leave();
  shutdown.leave();
  assert.deepEqual(exits, [0]);
});

test("探针也计入在途：退出时不会因为「业务没请求了」提前走", async () => {
  const { shutdown, exits, exited } = harness({ timeoutMs: 1000 });
  shutdown.track();
  shutdown.begin("SIGTERM");
  assert.deepEqual(exits, [], "探针还挂着，就不能算走完了");
  assert.equal(shutdown.inflightCount, 1);
  assert.equal(shutdown.businessCount, 0, "探针不该算进「还有几笔没办完」");
  shutdown.untrack();
  assert.equal(await exited, 0);
});

test("停监听时抛异常，不影响继续退出", async () => {
  const { shutdown, events, exited } = harness({
    timeoutMs: 1000,
    onClose: () => {
      throw new Error("监听已关");
    },
  });
  shutdown.begin("SIGTERM");
  assert.equal(await exited, 0);
  assert.ok(events.join("\n").includes("停监听时出错"));
});

test("界面上能看出现在处于哪个阶段", () => {
  const { shutdown } = harness({ timeoutMs: 1000 });
  assert.equal(shutdown.phaseName, "running");
  shutdown.enter();
  shutdown.begin("SIGTERM");
  assert.equal(shutdown.phaseName, "draining");
  assert.equal(shutdown.draining, true);
});
