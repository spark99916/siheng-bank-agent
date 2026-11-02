import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileStore } from "../shared/persist.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "siheng-cas-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/** 用最直白的方式模拟「两个实例各自读到旧账，然后各写各的」。 */
test("后写的不能把先写的整份盖掉", () => {
  const box = fresh();
  try {
    const a = new FileStore(box.dir);
    const b = new FileStore(box.dir);

    // 两个实例在同一个时刻各读一份 —— 这是并发写的起点，不是刻意构造的巧合。
    const sa = a.loadState().state;
    const sb = b.loadState().state;
    const before = sa.account.balance;

    sa.account.balance = before - 100;
    sa.account.available = sa.account.available - 100;
    a.saveState(sa);

    sb.account.balance = before - 200;
    sb.account.available = sb.account.available - 200;
    // 关键在于这一句：b 手里是旧账，此刻盘上已经被 a 改过了。
    // 整份覆盖的写法会一声不响地盖回去，a 那 100 分凭空消失。
    assert.throws(
      () => b.saveState(sb),
      (error) => error.code === "STATE_CONFLICT",
      "拿旧版本覆盖新版本时必须报冲突，而不是静默覆盖",
    );

    const after = new FileStore(box.dir).loadState().state;
    assert.equal(after.account.balance, before - 100, "盘上应当保留先写那笔的结果");
  } finally {
    box.done();
  }
});

test("版本号随写盘递增，且能被下一个实例接着用", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const first = store.loadState().state;
    const v0 = first.revision;
    const before = first.account.balance;

    first.account.balance = before - 1;
    first.account.available = first.account.available - 1;
    store.saveState(first);
    assert.equal(first.revision, v0 + 1, "写盘的同一个对象也要跟着加一，否则自己下次写就冲突");

    const second = new FileStore(box.dir).loadState().state;
    assert.equal(second.revision, v0 + 1, "换一个实例读回来，版本要对得上");
    second.account.balance -= 1;
    second.account.available -= 1;
    store.saveState(second);

    const third = new FileStore(box.dir).loadState().state;
    assert.equal(third.revision, v0 + 2);
    assert.equal(third.account.balance, before - 2, "两次各扣一分，一分都不能丢");
  } finally {
    box.done();
  }
});

test("老版本写的 state.json（没有版本号）照样能读，按第 0 版算", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const legacy = store.loadState().state;
    const { revision, ...withoutVersion } = legacy;
    void revision;
    writeFileSync(path.join(box.dir, "state.json"), JSON.stringify(withoutVersion), "utf8");

    const loaded = new FileStore(box.dir).loadState();
    assert.equal(loaded.kind, "disk");
    assert.equal(loaded.state.revision, 0, "缺版本号按 0 算，不能当成坏文件");
    loaded.state.account.balance -= 5;
    loaded.state.account.available -= 5;
    assert.doesNotThrow(() => store.saveState(loaded.state), "老账本第一次写入不能被当成冲突");
  } finally {
    box.done();
  }
});

test("临时文件不能同名：两个写者各写各的，不许互相踩", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const state = store.loadState().state;
    state.account.balance -= 1;
    store.saveState(state);

    // 落盘是「先写 .tmp 再 rename」。同名 tmp 意味着 A 写完还没 rename，
    // B 就把同一个文件重写了 —— rename 出来的可能是别人的半截，也可能是 ENOENT。
    const leftovers = readdirSync(box.dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], `写完不该留临时文件，实际还剩：${leftovers.join(",")}`);
  } finally {
    box.done();
  }
});

/**
 * 锁的释放失败不能把账永久锁死 —— 这是 v1.19.0 修的真实缺陷。
 *
 * 原来的释放只靠「删文件」。删不掉（权限、安全策略拦删除、文件被占）
 * 时异常被 catch 吞掉，锁文件永远留在盘上；之后每一次写盘都撞 EEXIST，
 * 自旋 300 毫秒后报 busy，用户看到的是「账本正被另一个进程写入」——
 * 而根本没有别的进程，是上一笔自己留下的残骸。
 *
 * 这里模拟那个残骸：造一份「本实例持有」的锁文件，
 * 然后要求下一次写盘能接管它、正常落盘，而不是报 busy。
 */
test("上一笔留下的残锁：下一次写盘要能接管，而不是报 busy", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const lockPath = path.join(box.dir, ".state.lock");
    // 锁文件内容写这个实例自己的身份 —— 就是「我上一笔没释放干净」的样子。
    // 身份由 FileStore 自己分配（进程号#实例序号），所以直接问它要，
    // 不手拼 —— 手拼会猜错实例序号，测的就不是同一条路径了。
    writeFileSync(lockPath, `${store.lockTag}\n`, "utf8");

    const state = store.loadState().state;
    const before = state.account.balance;
    state.account.balance = before - 100;
    state.account.available -= 100;

    assert.doesNotThrow(
      () => store.saveState(state),
      "自己留下的残锁必须能接管，不能报成「另一个进程在写」",
    );
    const after = new FileStore(box.dir).loadState().state;
    assert.equal(after.account.balance, before - 100, "接管之后这一笔要真的落账");
  } finally {
    box.done();
  }
});

/** 别的活进程持有的锁不能抢 —— 抢错了就是两笔账互相覆盖。 */
test("别的活进程持有的锁：抢不动，要老实等", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const lockPath = path.join(box.dir, ".state.lock");
    // 同进程、但实例序号不同 —— 正是同进程里另一个 FileStore 正持锁的情形。
    // 进程活着，所以必须等，不能抢。
    writeFileSync(lockPath, `${process.pid}#9999\n`, "utf8");

    const state = store.loadState().state;
    state.account.balance -= 100;
    state.account.available -= 100;
    assert.throws(
      () => store.saveState(state),
      (error) => error.code === "STATE_CONFLICT" && error.reason === "busy",
      "别人的活锁不能抢：必须报冲突，而不是两个写者同时落盘",
    );
  } finally {
    box.done();
  }
});

/** 已经不在的进程留下的锁：那是僵尸锁，可以接管。 */
test("死掉的进程留下的锁：能接管，不必等十分钟", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    const lockPath = path.join(box.dir, ".state.lock");
    // 999999 号进程在 Windows 和 Linux 上都不存在 —— 就是「崩在临界区里」的样子。
    writeFileSync(lockPath, "999999#1\n", "utf8");

    const state = store.loadState().state;
    const before = state.account.balance;
    state.account.balance = before - 100;
    state.account.available -= 100;
    assert.doesNotThrow(
      () => store.saveState(state),
      "僵尸锁要能接管，否则崩一次就把账锁死十分钟",
    );
  } finally {
    box.done();
  }
});

/**
 * 释放后的残留文件不能越攒越多。
 *
 * 挪走的锁叫 .state.lock.released / .state.lock.stale，名字是固定的，
 * 每次覆盖 —— 所以这个目录里最多多两个文件，不会随写盘次数增长。
 */
test("释放锁不留一堆残渣：残留文件名固定，不会越攒越多", () => {
  const box = fresh();
  try {
    const store = new FileStore(box.dir);
    for (let i = 0; i < 25; i += 1) {
      const state = store.loadState().state;
      state.account.balance -= 1;
      state.account.available -= 1;
      store.saveState(state);
    }
    const leftovers = readdirSync(box.dir).filter((name) => name.startsWith(".state.lock"));
    assert.ok(
      leftovers.length <= 2,
      `残留文件最多两个（固定的 .released / .stale），实际有 ${leftovers.length} 个：${leftovers.join(",")}`,
    );
  } finally {
    box.done();
  }
});

/** 真起两个进程，共用一个目录，各转一笔 —— 这是「多实例」的最小复现。 */
test("两个进程共用一个数据目录：谁也不能把对方那笔写没", async () => {
  const box = fresh();
  const runner = path.join(box.dir, "runner.mjs");
  writeFileSync(
    runner,
    `
import { FileStore } from ${JSON.stringify(pathToFileURL(path.join(root, "shared/persist.ts")).href)};
const [dir, amount, tag] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
const store = new FileStore(dir);
const state = store.loadState().state;
await new Promise((r) => setTimeout(r, 120));   // 两边都读完旧账之后再动手
state.account.balance -= amount;
state.account.available -= amount;
state.transferLog.unshift({ id: tag, name: tag, amountCents: amount, at: new Date().toISOString() });
try {
  store.saveState(state);
  console.log("ok");
} catch (error) {
  console.log("conflict:" + (error.code ?? error.message));
  process.exitCode = 3;
}
`,
    "utf8",
  );

  const run = (amount, tag) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, box.dir, String(amount), tag], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += String(chunk)));
      child.stderr.on("data", (chunk) => (err += String(chunk)));
      child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    });

  try {
    const seed = new FileStore(box.dir);
    const before = seed.loadState().state.account.balance;

    const [one, two] = await Promise.all([run(100, "甲"), run(200, "乙")]);

    // 先把「子进程压根没跑起来」这条堵死：跑不起来时两个 code 都是 1，下面的断言会空转通过。
    for (const [label, item] of [["甲", one], ["乙", two]]) {
      assert.ok(
        item.code === 0 || item.code === 3,
        `子进程${label}没能正常收尾（退出码 ${item.code}）：${item.err || item.out || "无输出"}`,
      );
    }

    const after = new FileStore(box.dir).loadState().state;
    // 两种正确结局：要么两个都写进去了（有人排队/重试），
    // 要么一个成功一个明确报冲突。唯一不能接受的是「两个都说成功，钱只少了一笔」。
    const okCount = [one, two].filter((item) => item.code === 0).length;
    const written = before - after.account.balance;
    assert.ok(okCount >= 1, `至少得有一笔落账，实际成功 ${okCount} 笔：${one.out} / ${two.out}`);
    assert.ok(
      !(okCount === 2 && written !== 300),
      `两边都报成功但只少了 ${written} 分（应为 300），有一笔被静默覆盖：${one.out} / ${two.out}`,
    );
    assert.equal(
      after.transferLog.length,
      okCount,
      `日志条数应当等于真正落账的笔数（落账 ${okCount} 笔，日志 ${after.transferLog.length} 条）`,
    );
  } finally {
    box.done();
  }
});
