/** 前端只做三件事：发消息、看判定、点确认。业务判定一律由引擎给。 */

import { rpc as engineRpc } from "./demo-local.ts";

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

/** 主体：谁在操作。档位不同，同一句话的判定结果就不同。 */
function actorOf(): { userId: string; tier: string } {
  const tier = tierSelect?.value ?? "standard";
  return { userId: `web-${tier}`, tier };
}

function policyOf(): Record<string, number> | undefined {
  return strictCheck?.checked === true ? STRICT_POLICY : undefined;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!USE_LIVE) return (await engineRpc(method, params)) as T;

  const response = await fetch(`${API}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (payload.ok !== true) throw new Error(payload.error ?? "请求失败");
  return payload.result as T;
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
      item.className = `audit__item audit__item--${record.level}`;
      item.textContent = `#${record.seq} ${record.decision} · ${record.result.slice(0, 28)}`;
      auditList.appendChild(item);
    }
  }
}

/** 演示：改掉最后一条审计，看链断在哪。需要服务端以 DEMO_TAMPER=on 启动。 */
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
    bubble("agent", `篡改演示没开：${error instanceof Error ? error.message : "未知"}。本机进程需以 DEMO_TAMPER=on 重开，本地引擎不支持这一步。`);
  }
});

composer?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input?.value.trim() ?? "";
  if (text === "") return;
  if (input !== null) input.value = "";
  bubble("user", text);
  try {
    const reply = await rpc<Reply>("chat", [sessionId, text, actorOf(), policyOf(), newRequestId()]);
    const node = bubble("agent", reply.reply);
    attachDecision(node, reply);
    await refresh();
  } catch (error) {
    bubble("agent", `出错：${error instanceof Error ? error.message : "未知"}`);
  }
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

void boot();
