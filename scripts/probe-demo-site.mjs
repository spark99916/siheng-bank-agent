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

/** 每次跑之前把演示账户重置：不清干净，频次与「上次收款人」会把断言带偏。 */
async function resetDemoAccount() {
  try { await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "reset", params: [] }),
  }); } catch { /* 本地场景没有服务可重置，本来每次打开就是初始状态 */ }
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
    const before = await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length");
    await cdp.evaluate(`(() => {
      document.querySelector('#chatInput').value = ${JSON.stringify(text)};
      document.querySelector('#chatForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitFor(async () => {
      if ((await cdp.evaluate("document.querySelectorAll('#chatLog .msg').length")) <= before) return false;
      return await cdp.evaluate("!!document.querySelector('#chatLog .msg--agent:last-child .msg__meta')");
    }, { label: "回复出现" });
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
  await cdp.evaluate(`[...document.querySelectorAll('#chatChips .chip')].find(c => c.dataset.say === '转给小王 100 元').click()`);
  const hasCard = await waitFor(() => cdp.evaluate("!!document.querySelector('.confirm:not(.confirm--done)')"), { label: "确认卡" });
  check("黄色判定出了确认卡", hasCard);
  check("确认卡上有倒计时", /\d+s/.test(await cdp.evaluate("document.querySelector('.confirm__ttl')?.textContent ?? ''")));
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
  await cdp.evaluate("document.querySelector('#tokIssue').click()");
  const tokened = await waitFor(() => cdp.evaluate("document.querySelector('#tokenVal').textContent.length > 20"), { label: "签发" });
  check("签发出令牌", tokened);
  const tokenText = await cdp.evaluate("document.querySelector('#tokenVal').textContent");
  check("令牌是 UUID 形状", /^[0-9a-f-]{36}$/.test(tokenText.trim()), tokenText);
  await cdp.evaluate("document.querySelector('#tokFake').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#tokenVerdicts .verdict').length >= 2"), { label: "伪造结果" });
  const fakeVerdict = await cdp.evaluate("document.querySelector('#tokenVerdicts .verdict:last-child').textContent");
  check("伪造令牌被拒", /令牌不匹配|没有待确认/.test(fakeVerdict), fakeVerdict);
  await cdp.evaluate("document.querySelector('#tokReuse').click()");
  await waitFor(() => cdp.evaluate("document.querySelectorAll('#tokenVerdicts .verdict').length >= 4"), { label: "复用结果" });
  const verdicts = await cdp.evaluate("[...document.querySelectorAll('#tokenVerdicts .verdict')].map(v => v.textContent)");
  check("真令牌第一次成功", (verdicts.at(-2) ?? "").includes("已向"), (verdicts.at(-2) ?? "").slice(0, 40));
  check("同一张票第二次被拒", !(verdicts.at(-1) ?? "").includes("已向"), (verdicts.at(-1) ?? "").slice(0, 40));

  console.log("\n六、幂等：首次 / 重放 / 换内容");
  await cdp.evaluate(`document.querySelector('.tab[data-tab="idem"]').click()`);
  await cdp.evaluate("document.querySelector('#idemStart').click()");
  const idemStarted = await waitFor(() => cdp.evaluate("document.querySelectorAll('#idemLog .idem-row').length >= 2"), { label: "首次执行" });
  check("首次执行留下 inflight 与 done", idemStarted);
  check("编号已显示", (await cdp.evaluate("document.querySelector('#idemId').textContent")).length > 8);
  await cdp.evaluate("document.querySelector('#idemReplay').click()");
  await waitFor(() => cdp.evaluate(`!!document.querySelector('.idem-row[data-k="replayed"]')`), { label: "重放行" });
  check("重放被标记为 replayed", await cdp.evaluate(`!!document.querySelector('.idem-row[data-k="replayed"]')`));
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

  console.log("\n八之二、「重新读取」只重读，不重启也不动账目");
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

  console.log("\n十、截图留档");
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
