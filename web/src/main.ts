/** 前端只做三件事：发消息、看判定、点确认。业务判定一律由引擎给。 */

import { rpc as engineRpc, switchUser } from "./demo-local.ts";
import { isThrottled, throttleSignal, withThrottleRetry } from "./throttle.ts";

interface Reply {
  reply: string;
  scene: string;
  decision: { level: "green" | "yellow" | "red"; blocked: boolean; hits: Array<{ rule: string; detail: string }> };
  confirmation?: { token: string };
  audit: { seq: number };
}

const API = import.meta.env.VITE_API_BASE ?? "";

/**
 * 通道：默认在本地跑。
 *
 * 页内引擎就是 `track-pi/src/agent.ts` 与 `shared/` 编译进来的同一份代码（见 ./demo-local.ts），
 * 判定、审计链、令牌、幂等一模一样，所以「打开就能用」不等于「降级演示」。
 * 只有显式要验真进程（磁盘审计、`/live` `/ready`、退出码）时才加 `?live=1` 打 `/rpc`。
 */
const USE_LIVE = new URLSearchParams(location.search).get("live") === "1";

const messages = document.querySelector<HTMLDivElement>("#messages");
const input = document.querySelector<HTMLInputElement>("#input");
const composer = document.querySelector<HTMLFormElement>("#composer");
const accountBox = document.querySelector<HTMLDListElement>("#account");
const auditList = document.querySelector<HTMLOListElement>("#audit");
const chainBox = document.querySelector<HTMLDivElement>("#chain");
const trackBox = document.querySelector<HTMLSpanElement>("#track");
const modelBox = document.querySelector<HTMLSpanElement>("#model");
const tierSelect = document.querySelector<HTMLSelectElement>("#tier");
const strictCheck = document.querySelector<HTMLInputElement>("#strict");
const tamperButton = document.querySelector<HTMLButtonElement>("#tamper");
const themeButton = document.querySelector<HTMLButtonElement>("#theme");
const hintBox = document.querySelector<HTMLDivElement>("#hint");

/**
 * 深浅切换。
 *
 * 存的是「切过去会变成什么」，不是「现在是什么」——按钮上写"深色"，
 * 点完变深色，语义不用读第二遍。
 *
 * localStorage 在 file:// 下可能被浏览器禁掉（隐私模式、某些内嵌浏览器），
 * 所以读写都包在 try 里：存不上就只在本次会话里生效，不能因此报错。
 */
function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  if (themeButton !== null) themeButton.textContent = theme === "light" ? "深色" : "浅色";
}

function readStoredTheme(): "light" | "dark" | null {
  try {
    const raw = localStorage.getItem("siheng-theme");
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: "light" | "dark"): void {
  try {
    localStorage.setItem("siheng-theme", theme);
  } catch {
    /* 存不上就算了，本次会话内仍然切得动 */
  }
}

applyTheme(readStoredTheme() ?? "light");

themeButton?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  storeTheme(next);
});

const sessionId = `web:${Math.random().toString(36).slice(2, 8)}`;

/**
 * 请求编号：同一个编号只办一次。
 * 用 crypto.randomUUID；局域网 IP 访问时它是非安全上下文、可能没有这个方法，所以留了退路。
 * 退路只求够随机、够长，不求密码学强度 —— 它防的是误重复，不是攻击者。
 */
function newRequestId(): string {
  const box = globalThis.crypto;
  if (typeof box?.randomUUID === "function") return box.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof box?.getRandomValues === "function") box.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 严格策略：把三条红线一起压低，用来证明判定是配出来的，不是写死的。 */
const STRICT_POLICY = { singleLimitCents: 50000, dailyLimitCents: 100000, newPayeeRedCents: 10000 };

/**
 * 档位 → 演示令牌。
 *
 * **为什么必须带令牌**：服务端的身份只从 `x-siheng-token` 头取，参数里传的 actor 一律不看
 * （防的就是客户端自称金卡）。所以「切换主体」这个动作，光改下拉框没用 ——
 * 之前这个下拉框只是个显示，界面上写着金卡，服务端那边还当普通客户，
 * 于是「金卡才能赎回理财」永远判红。这是个真缺陷，不是演示设置。
 *
 * 令牌是演示用的固定值，生产环境换成 OIDC access token，由网关注入。
 */
const TIER_TOKEN: Record<string, string> = {
  standard: "tok-demo-lin",
  gold: "tok-demo-zhou",
  private: "tok-demo-su",
};

/** 当前主体对应的令牌。档位不认识就退回默认客户。 */
function tokenOf(): string {
  const tier = tierSelect?.value ?? "standard";
  return TIER_TOKEN[tier] ?? TIER_TOKEN.standard;
}

/** 上一次已经切过去的令牌，用来避免每次请求都重切身份。 */
let lastIdentity = "";

/** 主体：谁在操作。档位不同，同一句话的判定结果就不同。 */
function actorOf(): { userId: string; tier: string } {
  const tier = tierSelect?.value ?? "standard";
  return { userId: `web-${tier}`, tier };
}

function policyOf(): Record<string, number> | undefined {
  return strictCheck?.checked === true ? STRICT_POLICY : undefined;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!USE_LIVE) {
    // 离线形态：身份是页面里的当前客户，切换下拉框要真的把身份切过去，
    // 否则界面写着金卡、引擎那边还是普通客户，赎回理财会一直判 tier-insufficient。
    // switchUser 内部会取缓存的 agent，这里只在身份真的变了才切。
    if (lastIdentity !== tokenOf()) {
      lastIdentity = tokenOf();
      switchUser(lastIdentity);
    }
    return (await engineRpc(method, params)) as T;
  }

  /**
   * 撞上限流就按 retry-after 等一等再发，而不是直接判失败。
   *
   * 安全：429 发生在建 Agent 之前，被拦的那次没碰磁盘、没动账、没写审计；
   * 而且重发的是同一组参数、同一个 requestId，幂等编号照旧。
   */
  return await withThrottleRetry(async () => {
    const response = await fetch(`${API}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 身份只认这个头：档位决定红线，不带令牌就落默认客户。
        "x-siheng-token": tokenOf(),
      },
      body: JSON.stringify({ method, params }),
    });
    const payload = await response.json();
    if (payload.ok === true) return payload.result as T;

    const message = payload.error ?? `请求失败（HTTP ${response.status}）`;
    // 限流是「等一下就好」，不是「办砸了」——两者在页面上要说不同的话。
    throw throttleSignal(response.status, response.headers, message) ?? new Error(message);
  });
}

function bubble(role: "user" | "agent", text: string): HTMLDivElement {
  const node = document.createElement("div");
  node.className = `msg msg--${role}`;
  node.textContent = text;
  messages?.appendChild(node);
  messages?.scrollTo({ top: messages.scrollHeight });
  return node;
}

function levelColor(level: string): string {
  return level === "green" ? "绿" : level === "yellow" ? "黄" : "红";
}

/** 命中规则最多显示两行：先给真正触发拦截的，base-level 与 actor-tier 是背景信息，垫底。 */
function topHits(hits: Array<{ rule: string; detail: string }>): Array<{ rule: string; detail: string }> {
  const background = new Set(["base-level", "actor-tier"]);
  const ranked = [
    ...hits.filter((hit) => !background.has(hit.rule)),
    ...hits.filter((hit) => background.has(hit.rule)),
  ];
  return ranked.slice(0, 2);
}

/** 判定与规则打在气泡下方，答辩时能指着说清为什么。 */
function attachDecision(node: HTMLDivElement, reply: Reply): void {
  const hits = reply.decision.hits;
  const meta = document.createElement("div");
  meta.className = `meta meta--${reply.decision.level}`;
  meta.textContent = `${levelColor(reply.decision.level)}色判定 · 命中 ${hits.length} 条 · 审计 #${reply.audit.seq}`;
  node.appendChild(meta);

  const list = document.createElement("ul");
  list.className = "hits";
  for (const hit of topHits(hits)) {
    const item = document.createElement("li");
    item.className = "hits__item";
    const rule = document.createElement("code");
    rule.textContent = hit.rule;
    const detail = document.createElement("span");
    detail.textContent = hit.detail;
    item.append(rule, detail);
    list.appendChild(item);
  }
  node.appendChild(list);

  if (reply.confirmation !== undefined) {
    const actions = document.createElement("div");
    actions.className = "actions";
    // 这张确认卡对应一个请求编号：连点两下、或网络重发，都只会办一笔。
    const confirmRequestId = newRequestId();
    const ok = document.createElement("button");
    ok.textContent = "确认执行";
    ok.addEventListener("click", async () => {
      actions.remove();
      const done = await rpc<Reply>("confirm", [sessionId, reply.confirmation?.token, confirmRequestId]);
      const line = bubble("agent", done.reply);
      attachDecision(line, done);
      await refresh();
    });
    const no = document.createElement("button");
    no.className = "ghost";
    no.textContent = "取消";
    no.addEventListener("click", async () => {
      actions.remove();
      const done = await rpc<Reply>("cancel", [sessionId]);
      bubble("agent", done.reply);
      await refresh();
    });
    actions.append(ok, no);
    node.appendChild(actions);
  }
}

async function refresh(): Promise<void> {
  const state = await rpc<{
    account: { availableYuan: string; holder: string };
    holdingCents: number;
    holdingValues?: Array<{ principalCents: number; interestCents: number; marketValueCents: number }>;
  }>("state", []);
  if (accountBox !== null) {
    accountBox.innerHTML = "";
    // 持仓按市值报，并把已计收益单独列一行：只报本金等于把用户赚到的钱藏起来，
    // 而「年化 2.9%」这句话正是靠这一行才落到纸面上。
    const values = state.holdingValues ?? [];
    const marketCents = values.reduce((sum, item) => sum + item.marketValueCents, 0);
    const interestCents = values.reduce((sum, item) => sum + item.interestCents, 0);
    const rows: Array<[string, string]> = [
      ["持卡人", state.account.holder],
      ["可用余额", `${state.account.availableYuan} 元`],
      ["持仓市值", `${((values.length > 0 ? marketCents : state.holdingCents) / 100).toFixed(2)} 元`],
      ["已计收益", `${(interestCents / 100).toFixed(2)} 元`],
    ];
    for (const [key, value] of rows) {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      row.append(dt, dd);
      accountBox.appendChild(row);
    }
  }

  const audit = await rpc<{ records: Array<{ seq: number; decision: string; level: string; result: string }>; chain: { ok: boolean; total: number; brokenAt: number | null } }>("audit", [sessionId, 8]);
  if (chainBox !== null) {
    chainBox.textContent = audit.chain.ok ? `链完整 · 共 ${audit.chain.total} 条` : `链断裂 · 第 ${audit.chain.brokenAt} 条`;
    chainBox.className = audit.chain.ok ? "chain chain--ok" : "chain chain--bad";
  }
  if (auditList !== null) {
    auditList.innerHTML = "";
    for (const record of [...audit.records].reverse()) {
      const item = document.createElement("li");
      /**
       * 断点那条要单独标出来。
       *
       * 配色只按记录自己的 level 走 —— 那是这条记录**原本**的判定级别，
       * 篡改改的是结论文字、没改级别，所以它仍是绿色，这一栏不能跟着变色，
       * 否则就成了"篡改能把判定级别也改了"，那是假的。
       *
       * 但链断了这件事得让人一眼看见：断点那条加一个角标，
       * 写明"这一条是断点"，不靠颜色也能看出来。
       */
      const broken = !audit.chain.ok && record.seq === audit.chain.brokenAt;
      item.className = `audit__item audit__item--${record.level}${broken ? " audit__item--broken" : ""}`;
      item.textContent = `#${record.seq} ${record.decision} · ${record.result.slice(0, 28)}`;
      if (broken) {
        const tag = document.createElement("span");
        tag.className = "audit__flag";
        tag.textContent = "断点";
        item.appendChild(tag);
      }
      auditList.appendChild(item);
    }
  }
}

/**
 * 演示：改掉最后一条审计，看链断在哪。
 *
 * 离线形态（页内引擎）直接能点；连真进程时需要服务端以 DEMO_TAMPER=on 启动 ——
 * 真后端改的是磁盘上真实的审计链，闸门必须挡。
 */
tamperButton?.addEventListener("click", async () => {
  try {
    const all = await rpc<{ records: Array<{ seq: number }> }>("audit", []);
    const last = all.records.at(-1);
    if (last === undefined) {
      bubble("agent", "还没有审计记录，先办一笔业务。");
      return;
    }
    const result = await rpc<{ chain: { ok: boolean; brokenAt: number | null } }>("tamper", [last.seq, "（前端演示改的）"]);
    bubble("agent", result.chain.ok ? "链还是完整的 —— 那说明校验本身有问题。" : `第 ${result.chain.brokenAt} 条被改动，链从这里断了。`);
    await refresh();
  } catch (error) {
    bubble("agent", `篡改演示没开：${error instanceof Error ? error.message : "未知"}。连真进程时需以 DEMO_TAMPER=on 重开。`);
  }
});

/**
 * 发一句话。
 *
 * 抽出来是因为入口有两个：输入框回车，和空态里的示例气泡。
 * 两条路必须走同一段逻辑 —— 否则「点气泡」和「打字」可能出现不同的判定结果，
 * 那是演示事故。
 */
async function send(text: string): Promise<void> {
  if (text === "") return;
  if (input !== null) input.value = "";
  bubble("user", text);
  // 空态提示只活到第一次对话：聊起来之后它就该让位给内容。
  hintBox?.classList.add("hint--gone");
  try {
    const reply = await rpc<Reply>("chat", [sessionId, text, actorOf(), policyOf(), newRequestId()]);
    const node = bubble("agent", reply.reply);
    attachDecision(node, reply);
    await refresh();
  } catch (error) {
    /**
     * 限流与真失败分开说。
     *
     * 说「请求失败」是不诚实的：限流那次请求压根没进业务逻辑，账也没动过。
     * 把它写成「系统繁忙，等 N 秒就好」才是用户看到的事实。
     */
    if (isThrottled(error)) {
      bubble("agent", `系统繁忙，${Math.max(1, Math.ceil(error.retryAfterMs / 1000))} 秒后再试一次。这笔没办，账也没动。`);
    } else {
      bubble("agent", `出错：${error instanceof Error ? error.message : "未知"}`);
    }
  }
}

/**
 * 示例气泡：点一下就发那句预置的话。
 *
 * 走的是和回车完全相同的那条路（填输入框 → 派发 submit），
 * 所以点出来的结果和手打一字不差。
 */
for (const sample of document.querySelectorAll<HTMLButtonElement>(".sample")) {
  sample.addEventListener("click", () => {
    const text = sample.dataset.say ?? "";
    if (text === "") return;
    if (input !== null) input.value = text;
    composer?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  });
}

composer?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await send(input?.value.trim() ?? "");
});

/** 启动时读一次健康信息，标出当前通道（本地引擎 / 本机进程）与模型状态。 */
async function boot(): Promise<void> {
  try {
    const health = await rpc<{ track: string; mode?: string; model?: { model: string; available: boolean } }>("health", []);
    if (trackBox !== null) {
      trackBox.textContent = health.mode === "offline" ? "通道：本地引擎" : `通道：本机进程（${health.track}）`;
    }
    if (modelBox !== null) {
      modelBox.textContent = health.mode === "offline"
        ? "本地 · 不调模型"
        : `模型：${health.model?.available === true ? health.model.model : "规则模式"}`;
    }
  } catch {
    if (trackBox !== null) trackBox.textContent = "通道：不可用";
  }
  await refresh().catch(() => undefined);
}

/** 告诉看门狗（index.html 头部那段）：主脚本活着，且通道已判定完毕。 */
function markBooted(): void {
  (window as unknown as { __sihengBooted?: boolean }).__sihengBooted = true;
}

void boot().then(markBooted, markBooted);
