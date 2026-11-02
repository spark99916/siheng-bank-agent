/**
 * 演示站端到端验证：用 CDP 驱动真 Chrome，逐个面板点一遍。
 * 只做三件事：看有没有 JS 报错、每个按钮点下去 DOM 有没有按预期变、关键读数是不是真的来自那份状态对象。
 *
 * 用法：node scripts/probe-demo-site.mjs <页面地址> <调试端口> [local|live]
 *   默认 local（页内引擎，也就是双击打开的形态）；live 会自己补上 ?live=1 去打真进程。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RAW_URL = process.argv[2] ?? "http://127.0.0.1:18260/demo.html";
const PORT = Number(process.argv[3] ?? 9333);
/* 期望通道：local（页内引擎，默认形态）或 live（真进程）。
   页面现在**默认就走页内引擎、一个网络请求都不发**，连后端必须显式 ?live=1，
   所以 live 场景由脚本自己补上这个参数，免得手输漏掉还以为是页面坏了。 */
const EXPECT_MODE = process.argv[4] ?? "local";
const URL_UNDER_TEST = (() => {
  if (EXPECT_MODE !== "live") return RAW_URL;
  const u = new URL(RAW_URL);
  u.searchParams.set("live", "1");
  return u.href;
})();
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const SHOT_DIR = path.resolve(".probe/shots");
mkdirSync(SHOT_DIR, { recursive: true });
const BASE = new URL(URL_UNDER_TEST).origin;

/**
 * 四个演示客户的令牌。
 *
 * 必须把四个都重置：只重置默认客户的话，另外三个的账还留着上一轮的数字。
 * 上一轮探针给周雅转过 100 元，这一轮再断言「她有 12800」就对不上了 ——
 * 那不是产品坏了，是上一轮的残留在搅局。
 */
const DEMO_TOKENS = ["tok-demo-lin", "tok-demo-zhou", "tok-demo-chen", "tok-demo-su"];

/**
 * 每次跑之前把演示账户重置：不清干净，频次与「上次收款人」会把断言带偏。
 *
 * 走的是带退避的调用：重置本身也要占配额，探针连打的时候也可能撞上限流，
 * 撞上了就按 retry-after 等一等再试，不当成失败。
 */
async function resetDemoAccount() {
  for (const token of DEMO_TOKENS) {
    await rpcWithBackoff(`${BASE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-siheng-token": token },
      body: JSON.stringify({ method: "reset", params: [] }),
    }).catch(() => { /* 本地场景没有服务可重置，本来每次打开就是初始状态 */ });
  }
}

/**
 * 带退避的 fetch：撞上限流就按 retry-after 等一等再发。
 *
 * 为什么探针要自己退避：服务端按客户限流（默认 120 次/分钟、突发 40），
 * 而探针是**机器速度**连打，页面每 4 秒还要轮询 3 个读数。
 * 机器比人快，撞墙是必然的 —— 撞墙不代表功能坏了，只代表这一下要等。
 *
 * 退避是安全的：429 发生在建 Agent 之前，被拦的那次没碰磁盘、没动账、没写审计；
 * 而且重发的是同一组参数、同一个 requestId，幂等编号照旧。
 */
async function rpcWithBackoff(url, init, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429) return response;
    // retry-after 按秒回传；读不到就等 1 秒，别把节奏拖死。
    const raw = response.headers.get("retry-after");
    const seconds = Number(raw);
    const waitMs = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : 1000;
    if (attempt === maxRetries) return response;
    await sleep(waitMs + 200);
  }
  throw new Error("退避重试次数用尽");
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, info = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${info ? `（${info}）` : ""}`);
    console.log(`  FAIL ${name}${info ? `  ← ${info}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 极简 CDP 客户端：只实现用得到的几个命令 ── */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionId = undefined;
    this.events = [];
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
        }
        return;
      }
      this.events.push(msg);
    });
  }

  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 20000);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本抛错");
    }
    return result.result.value;
  }
}

async function waitFor(fn, { timeout = 8000, interval = 120, label = "" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* 页面还没就绪 */
    }
    await sleep(interval);
  }
  if (label) console.log(`     （等待超时：${label}）`);
  return false;
}

/**
 * 请求节流闸门：探针的每一次点击之间至少隔这么久。
 *
 * 为什么需要：服务端按客户限流（默认 120 次/分钟、突发 40）。探针是机器速度，
 * 页面每 4 秒还要自己轮询 3 个读数 —— 两者加起来会瞬时打满桶。
 * 撞上限流的请求**没有进业务逻辑**（建 Agent 之前就被拦），所以那不是功能坏了，
 * 只是这一下要等；但等不得，断言会误判成「点下去没反应」。
 *
 * 所以在探针这一侧主动放慢：留出余量，让业务请求基本不撞墙。
 * 闸门只对「点了按钮要发请求」的动作生效，不拖慢纯读断言。
 */
const CLICK_GAP_MS = 700;
let lastClickAt = 0;

/** 点之前先过闸门。返回后可以放心点。 */
async function paceClick() {
  const wait = lastClickAt + CLICK_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastClickAt = Date.now();
}

/**
 * 判断页面上的这条回复是不是「被限流挡了」。
 *
 * 页面已经认得 429 了（琥珀色提示 + 黄色气泡「系统繁忙，N 秒后再试」），
 * 探针要认的是同一件事：这是**可重试状态**，不是失败。
 */
const THROTTLED_MARK = /系统繁忙|请求太频繁/;

/**
 * 点一个按钮，等它出回复；撞上限流就等 retry-after 后重试。
 *
 * 重试是安全的：429 发生在建 Agent 之前，被拦的那次没碰磁盘、没动账、没写审计；
 * 而重试发的是同一组参数、同一个 requestId，幂等编号照旧，不会重复执行。
 */
async function clickAndWait(selector, { timeout = 8000, label = "" } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await paceClick();
    const before = await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length");
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const got = await waitFor(
      async () => (await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length")) >= before + 2
        && (await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child')?.innerText ?? ''")).trim().length > 2,
      { label, timeout },
    );
    if (!got) return { ok: false, text: "" };
    const text = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child')?.innerText ?? ''");
    if (!THROTTLED_MARK.test(text)) return { ok: true, text };
    // 被限流了：按提示里的秒数等一等再点一次。限流是可恢复状态，不是失败。
    const seconds = Number((text.match(/(\d+)\s*秒/) ?? [0, 1])[1]);
    await sleep(Math.min(5000, Math.max(1, seconds) * 1000) + 300);
  }
  return { ok: false, text: "" };
}

const browser = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "siheng-demo-chrome-"))}`,
  "--window-size=1440,1000",
  "about:blank",
], { stdio: "ignore" });

let cdp;

async function connect() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const info = await res.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      return new Cdp(ws);
    } catch {
      await sleep(220);
    }
  }
  throw new Error("连不上调试端口");
}

async function main() {
  cdp = await connect();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const attach = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  cdp.sessionId = attach.sessionId;

  const consoleErrors = [];
  const exceptions = [];
  const originalPush = cdp.events.push.bind(cdp.events);
  cdp.ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      exceptions.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push(msg.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  });
  void originalPush;

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");

  // 只有真进程那一档需要重置：本地模式的引擎每次打开都是全新的内存状态，
  // 再去 POST 一次只会往静态服务器日志里加一条 501，还让人误以为页面在连后端。
  if (EXPECT_MODE === "live") await resetDemoAccount();

  console.log(`\n一、加载页面 ${URL_UNDER_TEST}`);
  await cdp.send("Page.navigate", { url: URL_UNDER_TEST });
  const ready = await waitFor(
    () => cdp.evaluate(`document.querySelector('#conn')?.dataset.state === '${EXPECT_MODE}'`),
    { label: `连接状态变为 ${EXPECT_MODE}`, timeout: 12000 },
  );
  check(`页面加载后识别到通道：${EXPECT_MODE}`, ready);
  const modeShown = await cdp.evaluate("document.documentElement.dataset.mode ?? ''");
  check("根节点记下了当前通道", modeShown === EXPECT_MODE, modeShown);
  check("横幅只在非 live 时出现",
    (await cdp.evaluate(`document.querySelector('#bannerLocal').dataset.on === '${EXPECT_MODE === "local" ? "true" : "false"}'`)),
    await cdp.evaluate("document.querySelector('#bannerLocal').dataset.on"));

  /* 核心承诺：默认形态下这一页不该往外发任何请求。真发了，就是「不连后端
     也能用」这句话在骗人 —— 网络一断、或换台机器，它照样白屏。
     live 是显式要了 ?live=1 的，那时发请求才对，改为断言它确实发了。 */
  const netHits = await cdp.evaluate(`performance.getEntriesByType("resource")
    .map(e => e.name).filter(n => /\\/(live|ready|rpc)(\\?|$)/.test(n))`);
  if (EXPECT_MODE === "local") {
    check("默认形态下没有向 /live、/ready、/rpc 发过任何请求",
      Array.isArray(netHits) && netHits.length === 0, JSON.stringify(netHits));
  } else {
    check("?live=1 时才真的打到 /rpc", Array.isArray(netHits) && netHits.some((n) => n.includes("/rpc")),
      JSON.stringify(netHits.slice(0, 3)));
  }

  /* 页面上不该出现「先把它跑起来」这类指令。用户要的是「打开就能用」，
     正文里每多一行 npm start，读起来就多一分「还得起服务」。 */
  const visibleText = await cdp.evaluate("document.body.innerText");
  check("正文里没有 npm start 这类启动指令", !/npm start/.test(visibleText),
    (visibleText.match(/.{0,20}npm start.{0,20}/) ?? [""])[0]);
  check("正文里没有「连不上后端」这种故障口吻", !/连不上后端|后端未连接/.test(visibleText),
    (visibleText.match(/.{0,20}(连不上后端|后端未连接).{0,20}/) ?? [""])[0]);

  const pillText = await cdp.evaluate("document.querySelector('#conn b').textContent");
  check(EXPECT_MODE === "local" ? "状态灯写「本地运行」，不是「没连上」" : "状态灯写「已连本机进程」",
    EXPECT_MODE === "local" ? pillText === "本地运行" : pillText === "已连本机进程", pillText);
  check("标题正确", (await cdp.evaluate("document.title")).includes("司衡"));

  const readout = await cdp.evaluate(`(() => {
    const t = (id) => document.querySelector(id)?.textContent ?? "";
    return { balance: t("#rBalance"), audit: t("#rAudit"), chain: t("#rChain"), idem: t("#rIdem") };
  })()`);
  check("右侧余额读到了真值", /元$/.test(readout.balance) && readout.balance !== "—", JSON.stringify(readout));
  check("审计条数是数字", /^\d+$/.test(readout.audit), readout.audit);
  check("链校验显示完整", readout.chain === "完整", readout.chain);

  console.log("\n二、对话台：点一个快捷问题");
  await paceClick();
  await cdp.evaluate(`[...document.querySelectorAll('#chatChips .chip')].find(c => c.dataset.say === '查一下余额').click()`);
  await waitFor(() => cdp.evaluate("!!document.querySelector('#chatLog .msg--agent:last-child .msg__meta')"), { label: "回复出现" });
  const chatText = await cdp.evaluate("document.querySelector('.chat-log').innerText");
  check("助手有回复", chatText.includes("余额"), chatText.slice(-60));
  const metaHtml = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child .msg__meta')?.innerHTML ?? '（没有 meta）'");
  check("有等级徽标", await cdp.evaluate("document.querySelectorAll('.lvl').length > 0"), metaHtml.slice(0, 160));

  /* 用户实测的那条路径：只说金额 → 被问人 → 回一个自称。
     以前这里会落到「我没有听懂」，因为整句只回「我自己」抽不出收款人。
     必须排在「转给小王」之前：转过一次之后，「转 100 元」会按上次收款人补上，
     那是 v1.10.0 的既定行为，这段就演不到追问了。 */
  console.log("\n二之二、分两轮：只说金额，再回「我自己」");
  const sendChat = async (text) => {
    /* 走同一套节流与重试：发出去的对话也要占配额，撞上限流时等 retry-after 再发。
       重发是安全的 —— 429 发生在建 Agent 之前，被拦的那次没动账、没写审计。 */
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await paceClick();
      const before = await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length");
      await cdp.evaluate(`(() => {
        document.querySelector('#chatInput').value = ${JSON.stringify(text)};
        document.querySelector('#chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      const got = await waitFor(async () => {
        if ((await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length")) <= before) return false;
        return await cdp.evaluate("!!document.querySelector('#chatLog .msg--agent:last-child .msg__meta')");
      }, { label: "回复出现" });
      if (!got) return "";
      const reply = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
      if (!THROTTLED_MARK.test(reply)) return reply;
      const seconds = Number((reply.match(/(\d+)\s*秒/) ?? [0, 1])[1]);
      await sleep(Math.min(5000, Math.max(1, seconds) * 1000) + 300);
    }
    return "";
  };
  const balBeforeFollowup = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  await sendChat("转 100 元");
  const askText = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("只说金额时用「请问」问人", /请问/.test(askText) && /转给谁/.test(askText), askText.slice(0, 80));
  check("不说「还差转给谁」这种挑毛病的口气", !/还差/.test(askText), askText.slice(0, 80));
  check("这时不该出确认卡", await cdp.evaluate("!document.querySelector('.confirm:not(.confirm--done)')"));

  await sendChat("我自己");
  const second = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("回「我自己」不再说「没听懂」", !/没听懂/.test(second), second.slice(0, 80));
  check("改口说清这是账户本人、转账不成立", /账户本人|不成立/.test(second), second.slice(0, 80));
  check("并指出正确路径是账户互转", /账户互转/.test(second), second.slice(0, 80));
  check("仍然不给确认卡", await cdp.evaluate("!document.querySelector('.confirm:not(.confirm--done)')"));
  check("余额一分没动",
    (await cdp.evaluate("document.querySelector('#rBalance').textContent")) === balBeforeFollowup,
    balBeforeFollowup);

  console.log("\n三、对话台：转账并确认");
  await paceClick();
  await cdp.evaluate(`[...document.querySelectorAll('#chatChips .chip')].find(c => c.dataset.say === '转给小王 100 元').click()`);
  const hasCard = await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm:not(.confirm--done)')"), { label: "确认卡" });
  check("黄色判定出了确认卡", hasCard);
  check("确认卡上有倒计时", /\d+s/.test(await cdp.evaluate("document.querySelector('.confirm__ttl')?.textContent ?? ''")));
  await paceClick();
  await cdp.evaluate("document.querySelector('.confirm:not(.confirm--done) .btn--gold').click()");
  await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm--done')"), { label: "确认后卡变灰" });
  check("确认后卡上写明已执行", (await cdp.evaluate("document.querySelector('.confirm--done')?.textContent ?? ''")).includes("已执行"));
  const afterBalance = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  check("读数里的余额变了", afterBalance !== readout.balance, `${readout.balance} → ${afterBalance}`);

  console.log("\n三之一、对话台：又说一笔只说金额，先问「还是他吗」");
  /* 上一步刚真转给小王 100 元。这一屏验的不是「能不能接上」，是「接上之前有没有问」——
     用户要的确定，就在这一问上。 */
  await sendChat("转 200 元");
  const reuseText = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("先问一句「还是转给小王吗」", /还是转给「小王」吗/.test(reuseText), reuseText.split("\n")[0]);
  check("把这一轮的金额也念出来", /200\.00/.test(reuseText), reuseText.slice(0, 90));
  check("问的这一步不出确认卡，也不动账", await cdp.evaluate("!document.querySelector('.confirm:not(.confirm--done)')"));

  console.log("\n三之二、对话台：答「是」才开卡，卡上写明是接上一轮的");
  await sendChat("是");
  await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm:not(.confirm--done)')"), { label: "答是之后出卡" });
  const carriedText = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("卡上第一句就是具体的人和钱", /转账给「小王」200\.00 元/.test(carriedText), carriedText.split("\n")[0]);
  check("写明收款人是接着上一轮的", /沿用你上一轮确认过的对象/.test(carriedText), carriedText.split("\n")[1] ?? "");
  check("仍然停在确认卡上，不替用户按下去", await cdp.evaluate("!!document.querySelector('.confirm:not(.confirm--done)')"));
  await paceClick();
  await cdp.evaluate("document.querySelector('.confirm:not(.confirm--done) .btn--gold').click()");
  await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm--done')"), { label: "确认后卡变灰" });
  // 卡先变灰、回执后到账：两件事都异步，只等卡变灰会读到上一屏的文本，
  // 顺手把余额断言也带沟里（读到的是确认前的快照）。等回执真的出现再读。
  await waitFor(
    async () => /已向/.test(await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText")),
    { label: "确认回执" },
  );
  const reuseDone = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("回执留了一句：这个对象是接着上一轮来的", /接着上一轮的对象/.test(reuseDone), reuseDone.slice(0, 100));

  console.log("\n三之三、对话台：转给自己必须判红");
  const balBeforeSelf = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  await paceClick();
  await cdp.evaluate(`[...document.querySelectorAll('#chatChips .chip')].find(c => c.dataset.say === '转给我自己 100 元').click()`);
  await waitFor(() => cdp.evaluate("!!document.querySelector('#chatLog .msg--agent:last-child .msg__meta')"), { label: "回复出现" });
  const selfText = await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText");
  check("转给自己说明是「本人 / 不成立」", /账户本人|不成立/.test(selfText), selfText.slice(0, 70));
  check("不出现「需确认」这种自相矛盾的话", !/需确认/.test(selfText), selfText.slice(0, 70));
  check("不出现「人脸验证」", !/人脸验证/.test(selfText), selfText.slice(0, 70));
  check("指出正确路径是账户互转", /账户互转/.test(selfText), selfText.slice(0, 70));
  check("没给确认卡", await cdp.evaluate("!document.querySelector('.confirm:not(.confirm--done)')"));
  const balAfterSelf = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  check("余额没动", balAfterSelf === balBeforeSelf, `${balBeforeSelf} → ${balAfterSelf}`);

  console.log("\n四、分轮补槽：自动演一遍");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="slot"]').click()`);
  check("切到补槽面板", await cdp.evaluate(`document.querySelector('.panel[data-panel="slot"]').dataset.active === 'true'`));
  await paceClick();
  await cdp.evaluate("document.querySelector('#slotRun').click()");
  const slotDone = await waitFor(
    async () => (await cdp.evaluate("document.querySelector('#slotRun').disabled")) === false
      && (await cdp.evaluate("document.querySelector('#slotReply').textContent")).length > 60,
    { label: "五轮跑完", timeout: 32000 },
  );
  check("五轮跑完", slotDone);
  const slotState = await cdp.evaluate(`(() => ({
    payee: document.querySelector('#slotPayee .slot__v').textContent,
    amount: document.querySelector('#slotAmount .slot__v').textContent,
    filled: document.querySelector('#slotPayee').dataset.filled,
    payeeSrc: document.querySelector('#slotPayee .slot__src').textContent,
    stepsOn: document.querySelectorAll('#slotSteps .step[data-on="true"]').length,
    reply: document.querySelector('#slotReply').textContent,
  }))()`);
  check("收款人槽位被点亮", slotState.filled === "true" && slotState.payee.length > 0, JSON.stringify(slotState.payee));
  check("金额槽位被点亮", /\d+\.\d{2} 元/.test(slotState.amount), slotState.amount);
  check("五步全部走过", slotState.stepsOn === 5, String(slotState.stepsOn));
  check("收款人来源标成「接上一轮的对象」", /接上一轮/.test(slotState.payeeSrc), slotState.payeeSrc);

  console.log("\n五、确认令牌：签发 / 伪造 / 复用");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="token"]').click()`);
  await paceClick();
  await cdp.evaluate("document.querySelector('#tokIssue').click()");
  const tokened = await waitFor(() => cdp.evaluate("document.querySelector('#tokenVal').textContent.length > 20"), { label: "签发" });
  check("签发出令牌", tokened);
  const tokenText = await cdp.evaluate("document.querySelector('#tokenVal').textContent");
  check("令牌是 UUID 形状", /^[0-9a-f-]{36}$/.test(tokenText.trim()), tokenText);
  await paceClick();
  await cdp.evaluate("document.querySelector('#tokFake').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#tokenVerdicts .verdict').length >= 2"), { label: "伪造结果" });
  const fakeVerdict = await cdp.evaluate("document.querySelector('#tokenVerdicts .verdict:last-child').textContent");
  check("伪造令牌被拒", /令牌不匹配|没有待确认/.test(fakeVerdict), fakeVerdict);
  await paceClick();
  await cdp.evaluate("document.querySelector('#tokReuse').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#tokenVerdicts .verdict').length >= 4"), { label: "复用结果" });
  const verdicts = await cdp.evaluate("[...document.querySelectorAll('#tokenVerdicts .verdict')].map(v => v.textContent)");
  check("真令牌第一次成功", (verdicts.at(-2) ?? "").includes("已向"), (verdicts.at(-2) ?? "").slice(0, 40));
  check("同一张票第二次被拒", !(verdicts.at(-1) ?? "").includes("已向"), (verdicts.at(-1) ?? "").slice(0, 40));

  console.log("\n六、幂等：首次 / 重放 / 换内容");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="idem"]').click()`);
  await paceClick();
  await cdp.evaluate("document.querySelector('#idemStart').click()");
  const idemStarted = await waitFor(() => cdp.evaluate("document.querySelectorAll('#idemLog .idem-row').length >= 2"), { label: "首次执行" });
  check("首次执行留下 inflight 与 done", idemStarted);
  check("编号已显示", (await cdp.evaluate("document.querySelector('#idemId').textContent")).length > 8);
  await paceClick();
  await cdp.evaluate("document.querySelector('#idemReplay').click()");
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.idem-row[data-k="replayed"]')`), { label: "重放行" });
  check("重放被标记为 replayed", await cdp.evaluate(`!!document.querySelector('.idem-row[data-k="replayed"]')`));
  await paceClick();
  await cdp.evaluate("document.querySelector('#idemConflict').click()");
  await waitFor(() => cdp.evaluate(`document.querySelectorAll('.idem-row[data-k="conflict"]').length >= 1`), { label: "冲突行" });
  const conflictText = await cdp.evaluate("document.querySelector('.idem-row[data-k=\"conflict\"]')?.textContent ?? ''");
  check("同编号换内容被拒", /已经被另一笔|冲突|换一个/.test(conflictText), conflictText.slice(0, 40));

  console.log("\n七、转人工：读数与空态");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="handoff"]').click()`);
  await waitFor(() => cdp.evaluate(`document.querySelector('#mComplete').textContent.includes('%')`), { label: "工单指标" });
  const metrics = await cdp.evaluate(`(() => ({
    complete: document.querySelector('#mComplete').textContent,
    write: document.querySelector('#mWrite').textContent,
    pending: document.querySelector('#mPending').textContent,
  }))()`);
  check("完整率读到真值（100%）", metrics.complete === "100%", metrics.complete);
  check("回写率读到真值（100%）", metrics.write === "100%", metrics.write);
  check("待处理数读到了", /^\d+$/.test(metrics.pending), metrics.pending);
  check("空态有解释，不是干巴巴一句「无数据」",
    (await cdp.evaluate("document.querySelector('#hoList').textContent")).includes("常态"));

  console.log("\n七之二、转人工：两类入口亲手走一遍");
  /* 国标 GB/T 47746—2026 把入口定成两类：用户主动要人工（入口是权利，
     不设准入前提）与五类自动触发。页面上的按钮必须真的走通，
     而不是摆一个好看的空壳 —— 这里每一格都从页面上读回来。 */
  const msgCount = () => cdp.evaluate("document.querySelectorAll('#chatLog .msg').length");
  const hoCards = () => cdp.evaluate("document.querySelectorAll('#hoList .ticket').length");
  const lastReply = () => cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child')?.innerText ?? ''");
  const clickHandoff = async (say) => {
    const pendingBefore = await cdp.evaluate("document.querySelectorAll('#chatLog .confirm:not(.confirm--done)').length");
    /* 一轮对话 = 用户一条 + 助手一条。但中间还有一个「…」占位，
       它也是助手气泡 —— 只等条数会读到占位符，读到的不是回执。
       所以两个条件都要满足：条数涨了，且最后一条真的有话。
       撞上限流时页面会先出「系统繁忙」，那是可重试状态 —— 等一下再点。 */
    const result = await clickAndWait(`[data-say-handoff="${say}"]`, { label: `按钮「${say}」有回复` });
    return { replied: result.ok, text: result.text, pendingBefore };
  };

  const cardsAtStart = await hoCards();

  /* ① 用户主动要人工：这是消费者的权利，不该先问「您确定要转人工吗」。 */
  const active = await clickHandoff("我要转人工");
  check("点「用户主动要人工」就有回复", active.replied);
  const activeText = await lastReply();
  check("主动转人工立刻给工单号", /H-\d{8}-\d{4}/.test(activeText), activeText.slice(0, 60));
  check("回复里写明处理时限", /预计 \d+ 分钟内有人联系/.test(activeText), activeText.slice(0, 60));
  check("回复里说清不用一直等（会话结束 ≠ 办结）", /不用一直等/.test(activeText), activeText.slice(0, 60));
  const pendingAfter = await cdp.evaluate("document.querySelectorAll('#chatLog .confirm:not(.confirm--done)').length");
  check("主动转人工不多要一道确认（入口是权利，不是交易）", pendingAfter === active.pendingBefore,
    `${active.pendingBefore} → ${pendingAfter}`);

  /* 工单要真的落到人工侧的列表里，不是只在对话里说说。 */
  await cdp.evaluate(`document.querySelector('.tab[data-tab="handoff"]').click()`);
  await waitFor(async () => (await hoCards()) > cardsAtStart, { label: "工单进列表" });
  check("工单出现在转人工面板的列表里", (await hoCards()) > cardsAtStart, `${cardsAtStart} → ${await hoCards()}`);
  const hoText = await cdp.evaluate("document.querySelector('#hoList').textContent");
  check("工单卡上带着原话", /我要转人工/.test(hoText), hoText.slice(0, 80));
  check("工单卡上标明了原因（运营据此分派）", /customer-request/.test(hoText), hoText.slice(0, 120));

  /* ② 查进度：国标要求用户能查到自己那单到哪一步了。 */
  const status = await clickHandoff("我的工单到哪了");
  check("点「查工单进度」有回复", status.replied);
  const statusText = await lastReply();
  check("进度回复里有工单号", /H-\d{8}-\d{4}/.test(statusText), statusText.slice(0, 60));
  check("进度回复里写了当前状态", /已受理|处理中|已结案/.test(statusText), statusText.slice(0, 80));
  check("进度回复里写了时限与跟进承诺",
    /时限 \d+ 分钟/.test(statusText) && /工单会继续跟进/.test(statusText), statusText.slice(0, 100));

  /* ③ 五类自动触发里能由一句话直接命中的三类（另两类要靠连续失败/超时累积）。 */
  const refusal = await clickHandoff("别跟我机器人说话了");
  const refusalText = await lastReply();
  check("拒绝智能服务立刻换人", refusal.replied && /换人处理/.test(refusalText), refusalText.slice(0, 60));

  const negative = await clickHandoff("你们乱扣钱，我要投诉");
  const negativeText = await lastReply();
  check("负面情绪先认事实再交人（不辩论）",
    negative.replied && /没有执行任何操作/.test(negativeText) && /不跟您争辩/.test(negativeText), negativeText.slice(0, 80));

  const safety = await clickHandoff("我的钱被转走了，这不是我的操作");
  const safetyText = await lastReply();
  check("疑似盗刷立刻止血并升到最高优先级",
    safety.replied && /不让机器人接着办/.test(safetyText) && /15 分钟内优先处理/.test(safetyText), safetyText.slice(0, 90));

  /* 四次开口 = 四张单，原因各不相同：运营才知道该改流程还是该加人。 */
  await cdp.evaluate(`document.querySelector('.tab[data-tab="handoff"]').click()`);
  await waitFor(async () => (await hoCards()) >= cardsAtStart + 4, { label: "四张工单进列表" });
  const reasons = await cdp.evaluate(`(() => {
    const tags = [...document.querySelectorAll('#hoList .ticket .tag')].map((t) => t.textContent.trim());
    return [...new Set(tags)].filter((t) => t !== "open" && t !== "claimed" && t !== "closed");
  })()`);
  check("四种原因各记各的，不混成一类",
    reasons.includes("customer-request") && reasons.includes("auto-refusal")
    && reasons.includes("auto-negative") && reasons.includes("auto-safety"),
    reasons.join("、"));

  console.log("\n八、运维：两个探针分开报");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="ops"]').click()`);
  if (EXPECT_MODE === "local") {
    /* 本地模式没有 HTTP 服务，就不该摆三个假 200 出来。 */
    const localOps = await cdp.evaluate(`(() => ({
      probesHidden: getComputedStyle(document.querySelector('#probes')).display === 'none',
      noteShown: getComputedStyle(document.querySelector('#opsLocalNote')).display !== 'none',
      note: document.querySelector('#opsLocalNote').textContent,
      audit: document.querySelector('#rAudit').textContent,
    }))()`);
    check("本地模式下探针整块收起，不做假 200", localOps.probesHidden, JSON.stringify(localOps.probesHidden));
    check("本地模式下给出说明，且点明没有独立进程可探",
      localOps.noteShown && /没有(独立)?进程/.test(localOps.note), localOps.note.trim().slice(0, 40));
    check("右侧审计条数仍来自同一份链", /^\d+$/.test(localOps.audit), localOps.audit);
  } else {
    await waitFor(() => cdp.evaluate(`document.querySelector('#liveCode').textContent === '200'`), { label: "探针状态" });
    const probes = await cdp.evaluate(`(() => ({
      live: document.querySelector('#liveCode').textContent,
      ready: document.querySelector('#readyCode').textContent,
      health: document.querySelector('#healthCode').textContent,
    }))()`);
    check("/live 200", probes.live === "200", probes.live);
    check("/ready 200", probes.ready === "200", probes.ready);
    check("health 200", probes.health === "200", probes.health);
  }

  console.log("\n八之二、一笔能追：页脚那个 traceId，审计里是同一个");
  /* 两条通道都要显示：离线引擎从模块取，真后端从响应头取。
     只显示不校验最容易烂 —— 页面上有个灰字，看着像在工作，其实早就断了。 */
  const traceLine = await cdp.evaluate("document.querySelector('#last-trace').textContent");
  check("页脚显示了最近一次请求的 traceId", /[0-9a-f]{16}/.test(traceLine), traceLine.trim().slice(0, 56));
  if (EXPECT_MODE === "local") {
    /* 不能直接拿页脚那个 id 去查审计：页脚记的是「最近一次请求」，而 state / health / audit
       这些只读调用不写审计 —— 那是设计，不是缺陷。所以这里主动发一次**会留痕**的对话，
       再比对。查余额是只读工具，但审计照样记一条。 */
    const traceHit = await cdp.evaluate(`(async () => {
      const engine = window.SihengLocal;
      await engine.rpc("chat", ["probe-trace", "查一下余额"]);
      const id = engine.traceId();
      const page = await engine.rpc("audit", [null, 5]);
      const row = page.records.find((item) => item.traceId === id);
      return { id, hit: row !== undefined, seq: row ? row.seq : 0 };
    })()`);
    check("发一次对话后，它的 traceId 在审计记录里找得到", traceHit.hit === true, `id=${traceHit.id} seq=${traceHit.seq}`);
  }

  console.log("\n八之三、「重新读取」只重读，不重启也不动账目");
  /* 这个按钮原先叫「刷新读数」，容易被读成「刷新引擎」。它做的只是重调一次
     state / health 把右侧数字换新 —— 既不重载页面，也不碰账面。 */
  const refBtn = await cdp.evaluate(`(() => {
    const b = document.querySelector('#refreshBtn');
    return { text: b.textContent.trim(), title: b.title };
  })()`);
  check("按钮写的是「重新读取」，不含「刷新」", refBtn.text === "重新读取" && !/刷新/.test(refBtn.text), refBtn.text);
  check("按钮自带说明：只更新读数、不动账目", /不动任何账目/.test(refBtn.title), refBtn.title.slice(0, 36));

  const balBeforeRefresh = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  const netBefore = await cdp.evaluate(`performance.getEntriesByType("resource").length`);
  await cdp.evaluate(`document.querySelector('#refreshBtn').click()`);
  await sleep(700);
  const balAfterRefresh = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  const netAfter = await cdp.evaluate(`performance.getEntriesByType("resource").length`);
  check("点完余额一分没变", balAfterRefresh === balBeforeRefresh, `${balBeforeRefresh} → ${balAfterRefresh}`);
  if (EXPECT_MODE === "local") {
    check("点完也没有新增网络请求", netAfter === netBefore, `${netBefore} → ${netAfter}`);
  }

  console.log("\n九、控制台");
  check("没有未捕获异常", exceptions.length === 0, exceptions.join(" | ").slice(0, 200));
  check("没有 console.error", consoleErrors.length === 0, consoleErrors.join(" | ").slice(0, 200));

  console.log("\n十、多客户：名字看得到，别人账户的钱看不到");
  const whoCount = await cdp.evaluate("document.querySelectorAll('#whoList .who__item').length");
  check("切换条列出四个客户", whoCount === 4, String(whoCount));
  const whoNames = await cdp.evaluate("Array.from(document.querySelectorAll('#whoList .who__item')).map((b) => b.textContent).join(',')");
  check("名册给的是姓名，不是内部编号", /林知远/.test(whoNames) && /周雅/.test(whoNames), whoNames);

  /* 记下切换前林知远的余额：前面的面板已经花掉一些，不能拿初始值当基准。 */
  const linBefore = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  await cdp.evaluate("[...document.querySelectorAll('#whoList .who__item')].find((b) => b.textContent === '周雅').click()");
  await waitFor(async () => (await cdp.evaluate("document.querySelector('#whoName').textContent")) === "周雅", { label: "切到周雅" });
  const zhou = await cdp.evaluate(`({
    name: document.querySelector('#whoName').textContent,
    tier: document.querySelector('#whoTier').textContent,
    bal: document.querySelector('#rBalance').textContent
  })`);
  check("切过去以后身份换成周雅", zhou.name === "周雅", zhou.name);
  check("档位跟着换（金卡）", /金卡/.test(zhou.tier), zhou.tier);
  check("余额是她自己的 12800.00", /12800\.00/.test(zhou.bal), zhou.bal);
  check("看不到林知远的 38642.50", !/38642\.50/.test(zhou.bal), zhou.bal);

  const dirRaw = await cdp.evaluate("(async () => JSON.stringify(await SihengLocal.rpc('directory', [])))()");
  check("名册里没有任何金额字段", !/Cents|balance|Yuan/.test(dirRaw), dirRaw.slice(0, 140));
  check("名册里有姓名也有档位", /林知远/.test(dirRaw) && /tierLabel/.test(dirRaw), dirRaw.slice(0, 140));

  /* 用别人的名字转账：名字可见（要核对），钱只从自己账上出。 */
  await cdp.evaluate("document.querySelector('#chatInput').value = '转给林知远 100 元'");
  await cdp.evaluate("document.querySelector('#chatForm').requestSubmit()");
  await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm:not(.confirm--done)')"), { label: "周雅转账出卡" });
  await paceClick();
  await cdp.evaluate("document.querySelector('.confirm:not(.confirm--done) .btn--gold').click()");
  await waitFor(
    async () => /已向/.test(await cdp.evaluate("document.querySelector('#chatLog .msg--agent:last-child').innerText")),
    { label: "周雅转账回执" },
  );
  const zhouAfter = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  check("周雅自己扣了 100（12800 → 12700）", /12700\.00/.test(zhouAfter), zhouAfter);

  await cdp.evaluate("[...document.querySelectorAll('#whoList .who__item')].find((b) => b.textContent === '林知远').click()");
  await waitFor(async () => (await cdp.evaluate("document.querySelector('#whoName').textContent")) === "林知远", { label: "切回林知远" });
  const linAfter = await cdp.evaluate("document.querySelector('#rBalance').textContent");
  check("林知远的账一分没动", linAfter === linBefore, `${linBefore} → ${linAfter}`);

  const shopScoped = await cdp.evaluate("(async () => { const s = await SihengLocal.rpc('state', []); return s.identity.name; })()");
  check("state 只答复当前身份", shopScoped === "林知远", shopScoped);

  console.log("\n十一、截图留档");
  for (const [tab, name] of [["chat", "01-chat"], ["slot", "02-slot"], ["token", "03-token"], ["idem", "04-idem"], ["handoff", "05-handoff"], ["ops", "06-ops"]]) {
    await cdp.evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click(); window.scrollTo(0, document.querySelector('#stage').offsetTop - 70);`);
    await sleep(260);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(shot.data, "base64"));
  }
  check("六张面板截图已生成", true);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) console.log("失败项：\n- " + failures.join("\n- "));
}

try {
  await main();
} catch (error) {
  console.error("验证脚本出错：", error.message);
  fail += 1;
} finally {
  browser.kill();
  process.exit(fail === 0 ? 0 : 1);
}
