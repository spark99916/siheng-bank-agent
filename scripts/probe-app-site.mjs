/**
 * 业务界面（web/dist/index.html）的本地可用性验证：双击打开、不连任何服务，
 * 能不能真办成事。用 CDP 驱动真 Chrome，走一遍查余额 → 转账 → 确认 → 审计。
 *
 * 用法：node scripts/probe-app-site.mjs [页面地址] [调试端口]
 *   地址带 ?live=1 时验真进程那一档，断言跟着换。
 *   默认打开构建产物 dist/index.html 的 file:// 地址。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PAGE = process.argv[2]
  ?? "file:///C:/Users/spark/WorkBuddy/2026-10-27-15-01-42/bank-agent-starter/web/dist/index.html";
const PORT = Number(process.argv[3] ?? 9421);
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/* 地址带 ?live=1 就是打真进程那一档，断言跟着换 —— 默认是双击打开这一档。 */
const EXPECT_LIVE = PAGE.includes("live=1");

let pass = 0;
const failures = [];
function check(label, ok, detail = "") {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}  ← ${detail}`); }
}

const browser = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  "--no-default-browser-check", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(path.join(tmpdir(), "app-"))}`,
  "--window-size=1440,1000", "about:blank",
], { stdio: "ignore" });

let id = 0;
const pending = new Map();
let ws;
let sessionId;

async function connect() {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener("open", resolve, { once: true });
        ws.addEventListener("error", reject, { once: true });
      });
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        const slot = pending.get(msg.id);
        if (slot !== undefined) {
          pending.delete(msg.id);
          msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result);
        }
      });
      return;
    } catch { await sleep(200); }
  }
  throw new Error("CDP 没起来");
}

function send(method, params = {}) {
  const mid = ++id;
  const payload = { id: mid, method, params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    pending.set(mid, { resolve, reject });
    setTimeout(() => { if (pending.delete(mid)) reject(new Error(`${method} 超时`)); }, 20000);
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? "求值失败");
  return result.result.value;
}

async function waitFor(fn, { label = "", timeout = 12000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  if (label !== "") console.log(`  …  等待超时：${label}`);
  return false;
}

const say = (text) => `(() => {
  const input = document.querySelector("#input");
  input.value = ${JSON.stringify(text)};
  document.querySelector("#composer").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  return true;
})()`;

const replyCount = () => evaluate(`document.querySelectorAll("#messages .msg--agent").length`);

await connect();

/**
 * 真进程那一档先把演示账户重置干净。
 *
 * 为什么必须重置：同一收款人 10 分钟内最多 2 笔（频次红线）。
 * 上一轮探针刚给「小王」转过两笔，这一轮再转同一人就会被红线拦下 ——
 * 那是产品行为正确，但会让探针误判成「按钮坏了」。
 *
 * 只读档（file://）不用重置：页内引擎每次打开都是全新内存状态。
 */
async function resetDemoAccount() {
  if (!EXPECT_LIVE) return;
  const base = new URL(PAGE).origin;
  for (const token of ["tok-demo-lin", "tok-demo-zhou", "tok-demo-chen", "tok-demo-su"]) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(`${base}/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-siheng-token": token },
          body: JSON.stringify({ method: "reset", params: [] }),
        });
        if (response.status !== 429) break;
        // 撞上限流就按 retry-after 等一等再试，不当成失败。
        const seconds = Number(response.headers.get("retry-after"));
        await sleep((Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : 1000) + 200);
      } catch {
        break;
      }
    }
  }
}

await resetDemoAccount();

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
sessionId = (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: PAGE });

const errors = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
});

console.log(`\n一、打开页面（${EXPECT_LIVE ? "?live=1 打真进程" : "file://，没有任何服务在跑"}）`);
check("页面渲染出来了", await waitFor(() => evaluate("!!document.querySelector('#composer')"), { label: "表单" }));

const want = EXPECT_LIVE ? "本机进程" : "本地引擎";
const bootOk = await waitFor(
  () => evaluate(`document.querySelector('#track').textContent.includes(${JSON.stringify(want)})`),
  { label: "通道标签", timeout: 8000 },
);
check(`顶栏写明通道是「${want}」`, bootOk, await evaluate("document.querySelector('#track').textContent"));
if (!EXPECT_LIVE) {
  check("模型一栏如实说「不调模型」",
    (await evaluate("document.querySelector('#model').textContent")).includes("不调模型"),
    await evaluate("document.querySelector('#model').textContent"));
}

const netHits = await evaluate(`performance.getEntriesByType("resource").map(e => e.name).filter(n => /\\/(rpc|live|ready)(\\?|$)/.test(n))`);
if (EXPECT_LIVE) {
  check("?live=1 时确实打到了 /rpc", Array.isArray(netHits) && netHits.some((n) => n.includes("/rpc")), JSON.stringify(netHits.slice(0, 3)));
} else {
  check("没有向 /rpc、/live、/ready 发过请求", Array.isArray(netHits) && netHits.length === 0, JSON.stringify(netHits));
}

/** 账户那几张卡是按 dt 找的，不能直接取第一个 dd —— 第一个是持卡人。 */
const balanceOf = () => evaluate(`(() => {
  const row = [...document.querySelectorAll("#account > div")].find(r => /可用余额/.test(r.textContent));
  return row === undefined ? "" : row.querySelector("dd").textContent;
})()`);
const balance0 = await balanceOf();
check("账户读数读到了（不是「—」）", balance0.includes("元"), balance0);

console.log(`\n二、真办一笔：查余额`);
const before = await replyCount();
await evaluate(say("查一下余额"));
check("回了话", await waitFor(async () => (await replyCount()) > before, { label: "回复" }), String(await replyCount()));
const balanceText = await evaluate(`document.querySelector("#messages .msg--agent:last-child").textContent`);
check("回复里带余额", /余额/.test(balanceText), balanceText.slice(0, 50));

console.log(`\n三、真办一笔：转账并确认`);
const before2 = await replyCount();
await evaluate(say("转给小王 100 元"));
check("出了确认按钮", await waitFor(() => evaluate("!!document.querySelector('#messages .msg--agent:last-child button')"), { label: "确认按钮" }));
const yes = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll("#messages .msg--agent:last-child button")];
  const hit = buttons.find(b => /确认|办理/.test(b.textContent));
  if (hit === undefined) return null;
  hit.click();
  return hit.textContent;
})()`);
check("点了确认", yes !== null, String(yes));
check("确认后回了话", await waitFor(async () => (await replyCount()) > before2 + 1, { label: "确认回复", timeout: 8000 }));

const balance1 = await balanceOf();
check("余额比刚才少了（真扣了钱）", balance0 !== balance1, `${balance0} → ${balance1}`);

console.log(`\n四、审计：链是同一份`);
const chain = await evaluate(`document.querySelector('#chain').textContent`);
check("链完整且有记录", /链完整 · 共 \d+ 条/.test(chain), chain);
const rows = await evaluate(`document.querySelectorAll('#audit .audit__item').length`);
check("审计列表有条目", rows > 0, String(rows));

/**
 * 主体切换必须真的改变判定。
 *
 * 这一节是 v1.19.1 补的回归：档位下拉框以前只改显示不改身份 ——
 * 界面写着「金卡客户」，服务端那边还当普通客户，于是「赎回理财要金卡以上」
 * 永远判 tier-insufficient。这个坑很隐蔽：控件能点、界面会变、就是不改判。
 */
console.log(`\n四之二、切换主体：下拉框换了，判定也得跟着换`);
const goldReply = await evaluate(`(async () => {
  const sel = document.querySelector('#tier');
  sel.value = 'gold';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const input = document.querySelector('#input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '把理财全部赎回');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#composer button[type=submit]').click();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const last = document.querySelector('#messages .msg--agent:last-child');
    if (last && /赎回|理财/.test(last.textContent)) return last.textContent;
  }
  return null;
})()`);
check("切到金卡后能拿到赎回回复", goldReply !== null, String(goldReply).slice(0, 60));
check(
  "金卡赎回不再被档位拦下（这一条以前一直是红的）",
  goldReply !== null && !/档位不足|需要金卡客户|tier-insufficient/.test(goldReply),
  String(goldReply).slice(0, 120),
);
const tierLabel = await evaluate(`document.querySelector('#tier').value`);
check("下拉框显示的是金卡", tierLabel === "gold", tierLabel);

/**
 * 篡改演示：改一条审计记录，链必须断在那一。
 *
 * 离线形态（file:// 双击）必须能演示 —— 离线引擎以前整条缺 tamper 分支，
 * 点按钮只会回一句「本地引擎不支持这一步」。这一节就是防它退回去的。
 *
 * live 档打的是真后端，那边要 DEMO_TAMPER=on 才开这个演示接口；
 * 没开时后端会明说「未开启」，那是设计如此，不算失败 —— 所以分开断言，
 * 不拿「链断没断」去套没开闸门的服务。
 */
console.log(`\n四之三、篡改演示：改一条记录，链必须断`);
const tamperReply = await evaluate(`(async () => {
  document.querySelector('#tamper').click();
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const last = document.querySelector('#messages .msg--agent:last-child');
    const text = last ? last.textContent : '';
    if (/链从这里断了|校验本身有问题|未开启|不支持/.test(text)) return text;
  }
  return null;
})()`);
const tamperText = String(tamperReply ?? "");
if (EXPECT_LIVE) {
  // 真进程那一档：闸门开着就得真断，闸门没开就如实说没开 —— 两种都算对。
  const gateOpen = /链从这里断了/.test(tamperText);
  const gateShut = /未开启|DEMO_TAMPER/.test(tamperText);
  check("live 档篡改：闸门开着就断链，闸门关着就明说没开", gateOpen || gateShut, tamperText.slice(0, 90));
  if (gateOpen) {
    const broken = await evaluate(`document.querySelector('#chain').textContent`);
    check("live 档链显示断裂并报出断点", /链断裂 · 第 \d+ 条/.test(broken), broken);
  }
} else {
  check("离线档能演示篡改（这一条以前一直是红的）", /链从这里断了/.test(tamperText), tamperText.slice(0, 90));
  const broken = await evaluate(`document.querySelector('#chain').textContent`);
  check("链显示断裂并报出断点", /链断裂 · 第 \d+ 条/.test(broken), broken);
  const brokenClass = await evaluate(`document.querySelector('#chain').className`);
  check("链状态样式切成断裂态", /chain--bad/.test(brokenClass), brokenClass);
  const flag = await evaluate(`(document.querySelector('#audit .audit__flag')||{}).textContent || ''`);
  check("断点那条标了「断点」角标", /断点/.test(flag), flag);
}

console.log(`\n五、控制台`);
check("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const shot = await send("Page.captureScreenshot", { format: "png" });
mkdirSync(path.resolve(".probe/shots"), { recursive: true });
writeFileSync(path.resolve(".probe/shots/app-local.png"), Buffer.from(shot.data, "base64"));

browser.kill();
console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
if (failures.length > 0) { console.log("失败项："); for (const f of failures) console.log(`- ${f}`); process.exitCode = 1; }
