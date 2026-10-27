/** 前端只做三件事：发消息、看判定、点确认。业务判定一律由后端给。 */

interface Reply {
  reply: string;
  scene: string;
  decision: { level: "green" | "yellow" | "red"; blocked: boolean; hits: Array<{ rule: string; detail: string }> };
  confirmation?: { token: string };
  audit: { seq: number };
}

const API = import.meta.env.VITE_API_BASE ?? "";

const messages = document.querySelector<HTMLDivElement>("#messages");
const input = document.querySelector<HTMLInputElement>("#input");
const composer = document.querySelector<HTMLFormElement>("#composer");
const accountBox = document.querySelector<HTMLDListElement>("#account");
const auditList = document.querySelector<HTMLOListElement>("#audit");
const chainBox = document.querySelector<HTMLDivElement>("#chain");
const trackBox = document.querySelector<HTMLSpanElement>("#track");
const modelBox = document.querySelector<HTMLSpanElement>("#model");

const sessionId = `web:${Math.random().toString(36).slice(2, 8)}`;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
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

/** 命中规则最多显示两行：先给真正触发拦截的，base-level 垫底，多出来的只留计数。 */
function topHits(hits: Array<{ rule: string; detail: string }>): Array<{ rule: string; detail: string }> {
  const ranked = [...hits].sort((a, b) => Number(a.rule === "base-level") - Number(b.rule === "base-level"));
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
    const ok = document.createElement("button");
    ok.textContent = "确认执行";
    ok.addEventListener("click", async () => {
      actions.remove();
      const done = await rpc<Reply>("confirm", [sessionId, reply.confirmation?.token]);
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
  const state = await rpc<{ account: { availableYuan: string; holder: string }; holdingCents: number }>("state", []);
  if (accountBox !== null) {
    accountBox.innerHTML = "";
    const rows: Array<[string, string]> = [
      ["持卡人", state.account.holder],
      ["可用余额", `${state.account.availableYuan} 元`],
      ["持仓", `${(state.holdingCents / 100).toFixed(2)} 元`],
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

  const audit = await rpc<{ records: Array<{ seq: number; decision: string; level: string; result: string }>; chain: { ok: boolean; total: number } }>("audit", [sessionId, 8]);
  if (chainBox !== null) {
    chainBox.textContent = audit.chain.ok ? `链完整 · 共 ${audit.chain.total} 条` : `链断裂 · 第 ${audit.chain.total} 条`;
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

composer?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input?.value.trim() ?? "";
  if (text === "") return;
  if (input !== null) input.value = "";
  bubble("user", text);
  try {
    const reply = await rpc<Reply>("chat", [sessionId, text]);
    const node = bubble("agent", reply.reply);
    attachDecision(node, reply);
    await refresh();
  } catch (error) {
    bubble("agent", `出错：${error instanceof Error ? error.message : "未知"}`);
  }
});

/** 启动时读一次健康信息，标出当前路线与模型。 */
async function boot(): Promise<void> {
  try {
    const health = await rpc<{ track: string; model?: { model: string; available: boolean } }>("health", []);
    if (trackBox !== null) trackBox.textContent = `路线：${health.track}`;
    if (modelBox !== null) modelBox.textContent = `模型：${health.model?.available === true ? health.model.model : "规则模式"}`;
  } catch {
    if (trackBox !== null) trackBox.textContent = "路线：未连接";
  }
  await refresh().catch(() => undefined);
}

void boot();
