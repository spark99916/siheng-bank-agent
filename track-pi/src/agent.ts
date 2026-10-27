import type { BankState, ToolResult } from "../../shared/state.ts";
import { executeTool, initialState, yuanText } from "../../shared/state.ts";
import { CURRENCY_LABEL } from "../../shared/rules.ts";
import type { AccountDayConfig, Actor, AuditChain, Decision, Intent, Plan, PlanStep, RiskEvidence, RiskPolicy, Ticket } from "../../shared/rules.ts";
import { DEFAULT_ACTOR, evaluate, extractAmount, groundIntent, issueTicket, parseIntent, parsePlan, redact, slotLabel, specOf, verifyTicket } from "../../shared/rules.ts";
import type { McpClient } from "../../shared/mcp-client.ts";
import type { FileStore } from "../../shared/persist.ts";
import type { RollbackKind, Undo } from "../../shared/compensation.ts";
import { captureUndo, rollbackOf } from "../../shared/compensation.ts";
import type { ChatMessage, ToolDecl, Transport } from "./transport.ts";
import type { LoopResult } from "./loop.ts";
import { runLoop } from "./loop.ts";

/** 钩子：pi 三段式的第三段。调用前后各一个，用来插拦截与记账。 */
export interface AgentHooks {
  /** 工具执行前：返回 allow 为假即拒绝执行。 */
  beforeTool?: (input: {
    tool: string;
    slots: Record<string, unknown>;
    decision: Decision;
  }) => { allow: boolean; reason?: string };
  /** 工具执行后：记账、埋点、回调。 */
  afterTool?: (input: { tool: string; slots: Record<string, unknown>; result: ToolResult }) => void;
}

export interface AgentOptions {
  state: BankState;
  transport: Transport;
  hooks?: AgentHooks;
  chain: AuditChain;
  policy?: Partial<RiskPolicy> & { confirmTtlSeconds: number };
  /** 思考模式下才调模型；关闭时只走规则，省 token 也省时间。 */
  useModel?: boolean;
  /** 外部服务客户端：只读查询，失败不影响内置工具。 */
  fx?: McpClient;
  /** 外部反欺诈：转账前取证。没配就当没这层能力，不假装降级。 */
  risk?: McpClient;
  /** 落盘：审计追加写、状态与会话快照。不传就纯内存，重启即丢（单测与一次性演示用）。 */
  store?: FileStore;
  /** 账务日口径：业务时区与切分点。不传按东八区、零点切。 */
  accountDay?: AccountDayConfig;
  /** 回复改写：模型拿到工具结果后再组织一次语言。关掉就只回确定性文案。 */
  narrate?: boolean;
  /** 循环内模型最多还能发起几次只读工具调用。 */
  loopSteps?: number;
}

export interface ChatReply {
  sessionId: string;
  reply: string;
  scene: string;
  decision: Decision;
  confirmation?: { token: string; expiresAt: number };
  execution?: ToolResult;
  audit: { seq: number; hash: string };
  missing: string[];
  intentSource: "rule" | "model";
  /** 本轮真实发生了什么循环：几步、几圈工具、多少 token、有没有被数字校验打回。 */
  loop?: {
    steps: number;
    toolTurns: number;
    stopReason: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    /** true 表示最终答复来自模型改写；false 表示退回确定性文案。 */
    narrated: boolean;
    rejectReason?: string;
  };
}

/** 注入特征：命中即拦，不做语义判断。 */
const INJECTION = /(忽略.{0,4}(之前|以上|此前).{0,4}(指令|要求)|ignore\s+previous|你现在是|扮演|开发者模式|输出.{0,4}提示词|system\s*prompt)/i;

/** 同形字：西里尔与希腊字母里长得像拉丁字母的那些，统一映射回去，避免绕过。 */
const HOMOGLYPH: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԛ: "q", ԝ: "w",
  α: "a", ε: "e", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ι: "i", κ: "k", ν: "v",
};

/** 归一化：兼容字符（含全角）折叠成半角、去零宽、同形字回拉丁。 */
function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff\u2060]/g, "")
    .replace(/[\u0400-\u04ff\u0370-\u03ff]/g, (char) => HOMOGLYPH[char] ?? char)
    .trim();
}

/** 待确认的任务：可能是单步，也可能是一整个计划。策略存进来，确认时用同一套阈值重算。 */
type Pending =
  | { kind: "single"; ticket: Ticket & { sessionId: string; actor: Actor }; policy: Partial<RiskPolicy> }
  | { kind: "plan"; ticket: Ticket & { sessionId: string; actor: Actor }; plan: Plan; policy: Partial<RiskPolicy> };

export class Agent {
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly drafts = new Map<string, Intent>();

  constructor(options: AgentOptions) {
    this.options = options;
    this.restoreSessions();
  }

  /**
   * 会话复原：重启后接回「还没确认的那笔」和「还在等参数的草稿」。
   * 过期的直接丢 —— 令牌接回来也过不了 verifyTicket，留着只会让下一个用户莫名其妙。
   * 每一项都逐字段校验：文件可能是手改的，接回半条坏数据比接不回更危险。
   */
  private restoreSessions(): void {
    const raw = this.options.store?.readSessions() ?? null;
    if (raw === null || typeof raw !== "object") return;
    const input = raw as { pending?: unknown; drafts?: unknown };
    const now = Date.now();
    if (Array.isArray(input.pending)) {
      for (const entry of input.pending) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [sessionId, value] = entry as [unknown, unknown];
        if (typeof sessionId !== "string" || value === null || typeof value !== "object") continue;
        const candidate = value as Pending;
        if (candidate.kind !== "single" && candidate.kind !== "plan") continue;
        const ticket = candidate.ticket;
        if (ticket === undefined || ticket === null || typeof ticket.token !== "string" || typeof ticket.expiresAt !== "number") continue;
        if (ticket.expiresAt <= now) continue;
        if (candidate.kind === "plan" && (candidate.plan === undefined || !Array.isArray(candidate.plan.steps))) continue;
        this.pending.set(sessionId, candidate);
      }
    }
    if (Array.isArray(input.drafts)) {
      for (const entry of input.drafts) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [sessionId, value] = entry as [unknown, unknown];
        if (typeof sessionId !== "string" || value === null || typeof value !== "object") continue;
        const candidate = value as Intent;
        if (typeof candidate.tool !== "string" || candidate.slots === null || typeof candidate.slots !== "object") continue;
        this.drafts.set(sessionId, candidate);
      }
    }
  }

  /** 会话快照：待确认与草稿一起写，两个 Map 分开存会写出一半新一半旧的组合。 */
  private persistSessions(): void {
    const store = this.options.store;
    if (store === undefined) return;
    store.saveSessions({ pending: [...this.pending.entries()], drafts: [...this.drafts.entries()] });
  }

  /** 业务状态快照：每次动过钱或动过数据后立刻写，只在内存里改等于重启就回到开盘。 */
  private persistState(): void {
    this.options.store?.saveState(this.options.state);
  }

  get state(): BankState {
    return this.options.state;
  }

  get transportInfo(): { model: string; available: boolean } {
    return { model: this.options.transport.model, available: this.options.transport.available };
  }

  /** 工具表：参数名与单位必须写清，否则模型会自己发明字段名。 */
  private static readonly TOOL_TABLE: Array<{ name: string; summary: string; props: Record<string, unknown>; required: string[] }> = [
    { name: "query_balance", summary: "查询可用余额与总余额", props: {}, required: [] },
    {
      name: "analyze_bills",
      summary: "账单分类统计与异常交易识别",
      props: { period: { type: "string", enum: ["this-month", "last-month", "3-months"], description: "时间口径，默认 this-month" } },
      required: [],
    },
    {
      name: "transfer",
      summary: "转账给收款人",
      props: {
        payee: { type: "string", description: "收款人姓名，只能填用户原文里出现的名字" },
        amountCents: { type: "integer", description: "金额，整数分：500 元填 50000，不要填 500" },
      },
      required: ["payee", "amountCents"],
    },
    { name: "list_subscriptions", summary: "列出订阅与下次扣费日", props: {}, required: [] },
    {
      name: "cancel_subscription",
      summary: "取消某个订阅",
      props: { subscriptionName: { type: "string", description: "订阅名称，必须与用户说的名字一致" } },
      required: ["subscriptionName"],
    },
    { name: "lock_card", summary: "锁定或解锁卡片", props: { cardId: { type: "string", description: "卡片编号，如 card-002" } }, required: [] },
    { name: "report_loss", summary: "卡片挂失，不可撤销", props: { cardId: { type: "string", description: "卡片编号，如 card-002" } }, required: [] },
    { name: "wealth_redeem", summary: "赎回理财", props: { amountCents: { type: "integer", description: "赎回金额，整数分；不填表示全部" } }, required: [] },
    { name: "wealth_products", summary: "列出理财产品并对比收益与风险", props: {}, required: [] },
    {
      name: "wealth_buy",
      summary: "申购理财产品",
      props: {
        productId: { type: "string", description: "产品编号或全名，如 p-001 或 稳盈货币 A" },
        amountCents: { type: "integer", description: "申购金额，整数分" },
      },
      required: ["productId", "amountCents"],
    },
    { name: "birthday_lock", summary: "锁定一笔资金准备生日礼遇", props: { amountCents: { type: "integer", description: "锁定金额，整数分" } }, required: ["amountCents"] },
  ];

  /** 模型兜底：只产出意图，输出必须过白名单、参数校验与溯源。 */
  private async askModel(text: string): Promise<Intent | null> {
    if (!this.options.useModel || !this.options.transport.available) return null;
    const tools = Agent.TOOL_TABLE.map((item) => ({
      name: item.name,
      description: item.summary,
      parameters: { type: "object", properties: item.props, required: item.required, additionalProperties: false },
    }));
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是银行智能体的意图解析器。只调用一个工具。金额一律填整数分（500 元 = 50000）。" +
          "收款人、订阅名只能填用户原文里出现过的名称，不许推测或补全。判断不了就调用 unknown。",
      },
      { role: "user", content: text },
    ];
    try {
      const reply = await this.options.transport.complete(messages, tools);
      const call = reply.toolCalls[0];
      if (call === undefined || call.name === "unknown") return null;
      const spec = specOf(call.name);
      if (spec === undefined) return null;
      let slots: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) slots = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
      const missing: string[] = [];
      if (call.name === "transfer") {
        if (typeof slots.payee !== "string") missing.push("payee");
        if (typeof slots.amountCents !== "number") missing.push("amountCents");
      }
      return { scene: spec.scene, tool: call.name, slots, missing, confidence: 0.9 };
    } catch {
      return null;
    }
  }

  /**
   * 循环内允许模型自行调用的工具：全部只读。
   * 写成白名单而不是黑名单 —— 将来加了新工具，默认进不了循环，必须显式加进来。
   */
  private static readonly LOOP_TOOLS = new Set([
    "query_balance",
    "analyze_bills",
    "list_subscriptions",
    "wealth_products",
    "list_scheduled",
  ]);

  /** 抽取数字用于一致性校验。全角与千分位先折叠，避免 1,234 与 1234 被当成两个数。 */
  private static numbersIn(text: string): number[] {
    const normalized = text.normalize("NFKC").replace(/(\d),(?=\d{3}(\D|$))/g, "$1");
    const found = normalized.match(/-?\d+(?:\.\d+)?/g) ?? [];
    return found.map((item) => Number(item)).filter((value) => Number.isFinite(value));
  }

  private loopDecls(): ToolDecl[] {
    return Agent.TOOL_TABLE.filter((item) => Agent.LOOP_TOOLS.has(item.name)).map((item) => ({
      name: item.name,
      description: item.summary,
      parameters: { type: "object", properties: item.props, required: item.required, additionalProperties: false },
    }));
  }

  /**
   * 回复改写：模型拿到真实工具结果后再组织一次语言。
   * 允许它在循环里补一次只读查询（余额不够时看账单），不允许动钱或改状态。
   * 改写通过数字校验才采用，否则退回确定性文案 —— 模型负责措辞，不负责事实。
   */
  private async narrate(
    sessionId: string,
    text: string,
    intent: Intent,
    execution: ToolResult,
    actorId: string,
  ): Promise<{ text: string; loop: LoopResult; rejectReason?: string } | null> {
    if (this.options.narrate === false) return null;
    if (!this.options.useModel || !this.options.transport.available) return null;
    if (!execution.ok) return null;

    const facts = execution.message;
    const system =
      "你是银行智能助手。下面【事实】来自系统真实执行结果，必须原样遵守：\n" +
      "一、只能使用【事实】里出现过的数字，不得换算、合计或估算出新数字；\n" +
      "二、不得承诺【事实】里没有的动作；\n" +
      "三、用一到三句普通话回答，直接说结果，不要念规则名。\n" +
      `【事实】${facts}`;

    const loop = await runLoop({
      transport: this.options.transport,
      system,
      user: text,
      tools: this.loopDecls(),
      maxSteps: this.options.loopSteps ?? 1,
      canCall: (name) => Agent.LOOP_TOOLS.has(name),
      seed: { tool: intent.tool, args: JSON.stringify(intent.slots), result: facts },
      runTool: async (name, rawArgs) => {
        let slots: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) slots = parsed as Record<string, unknown>;
        } catch {
          return { ok: false, text: "参数不是合法 JSON，这次调用已忽略。" };
        }
        const result = executeTool(name, slots, this.options.state);
        this.options.chain.append({
          sessionId,
          actor: actorId,
          userText: redact(text),
          tool: name,
          decision: result.ok ? "loop_tool" : "loop_tool_failed",
          level: "green",
          rules: ["loop-readonly"],
          result: result.ok ? result.message : (result.error ?? "执行失败"),
        });
        return { ok: result.ok, text: result.ok ? result.message : `执行失败：${result.error ?? "未知原因"}` };
      },
    });

    const reject = (reason: string): { text: string; loop: LoopResult; rejectReason: string } => ({
      text: facts,
      loop,
      rejectReason: reason,
    });
    if (loop.stopReason === "error") return reject(`transport: ${loop.error ?? "unknown"}`);
    const narration = loop.finalText.trim();
    if (narration === "") return reject(`empty: ${loop.stopReason}`);
    if (narration.length > 300) return reject("too-long");

    // 一致性校验：答复里每个数字都必须能在事实或用户原话里找到，否则视为编造。
    const allowed = new Set([...Agent.numbersIn(facts), ...Agent.numbersIn(text), ...Agent.numbersIn(execution.message)]);
    const invented = Agent.numbersIn(narration).filter((value) => !allowed.has(value));
    if (invented.length > 0) return reject(`invented-number: ${invented.slice(0, 3).join(",")}`);

    return { text: narration, loop };
  }

  /** 执行失败的人话：外部异常要说清是哪条链路不通，别把错误码甩给用户。 */
  private failureText(error: string | undefined): string {
    if (error === "external_timeout") return "汇率服务响应超时，这次没有换算。余额、账单、转账这些内置业务不受影响。";
    if (error === "external_unavailable") return "汇率服务当前不可用，这次没有换算。内置业务不受影响。";
    if (error === "external_bad_payload") return "汇率服务返回的数据缺字段，这次没有换算，我不会拿猜的数报给你。";
    return `本次没有执行：${error ?? "未知原因"}。`;
  }

  /** 汇率换算走外部服务：返回只当数据用，超时或报错都退回失败，不阻塞主流程。 */
  private async runFx(intent: Intent): Promise<ToolResult> {
    const client = this.options.fx;
    if (client === undefined) return { ok: false, tool: "fx_convert", message: "", error: "external_unavailable" };
    const amountCents = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : 0;
    const currency = typeof intent.slots.currency === "string" ? (intent.slots.currency as string) : "";
    // 边界转换：本系统内部一律整数分，只在调用外部工具时换成元。
    const result = await client.call("convert", { currency, amount: amountCents / 100 });
    if (!result.ok) return { ok: false, tool: "fx_convert", message: "", error: result.error ?? "external_error" };
    const data = result.data ?? {};
    const converted = typeof data.converted === "number" ? data.converted : null;
    const rate = typeof data.rate === "number" ? data.rate : null;
    if (converted === null || rate === null) return { ok: false, tool: "fx_convert", message: "", error: "external_bad_payload" };
    const convertedCents = Math.round(converted * 100);
    const label = CURRENCY_LABEL[currency] ?? currency;
    return {
      ok: true,
      tool: "fx_convert",
      message: `${yuanText(amountCents)} ${label} 约合 ${yuanText(convertedCents)} 元人民币（1 ${label} = ${rate} 元，演示汇率）`,
      data: { currency, amountCents, convertedCents, rate },
    };
  }

  /**
   * 外部反欺诈取证。三种情况必须区分开：
   * 一、没接外部服务 → 返回 undefined，判定里不出现这条规则；
   * 二、接了但调不通/返回缺字段 → 返回降级结论，判定把它抬成「需确认」；
   * 三、拿到了结论 → 原样带进判定，等级与命中条目都由外部给，本地不加工。
   */
  private async evidenceFor(intent: Intent): Promise<RiskEvidence | undefined> {
    const client = this.options.risk;
    if (client === undefined || intent.tool !== "transfer") return undefined;
    const payee = typeof intent.slots.payee === "string" ? (intent.slots.payee as string) : "";
    if (payee === "") return undefined;
    const amountCents = typeof intent.slots.amountCents === "number" ? (intent.slots.amountCents as number) : 0;
    const result = await client.call("screen_payee", { name: payee, amountCents });
    // 降级时 level 不参与判断，由 source 决定走哪条分支。
    if (!result.ok) return { level: "low", hits: [], source: "degraded", reason: result.error ?? "external_error" };
    const data = result.data ?? {};
    const raw = typeof data.riskLevel === "string" ? data.riskLevel : "";
    if (raw !== "low" && raw !== "medium" && raw !== "high") {
      return { level: "low", hits: [], source: "degraded", reason: "external_bad_payload" };
    }
    const hits = Array.isArray(data.hits) ? data.hits.filter((item): item is string => typeof item === "string") : [];
    const advice = typeof data.advice === "string" ? data.advice : undefined;
    return { level: raw, hits, advice, source: "external" };
  }

  /** 计划取证：按步批量取，一次授权内沿用同一批证据，避免同一步前后结论不一致。 */
  private async evidencesFor(plan: Plan): Promise<Array<RiskEvidence | undefined>> {
    return await Promise.all(plan.steps.map((step) => this.evidenceFor(step.intent)));
  }

  private async runTool(intent: Intent): Promise<ToolResult> {
    if (intent.tool === "fx_convert") return await this.runFx(intent);
    return executeTool(intent.tool, intent.slots, this.options.state);
  }

  /**
   * 统一判定入口：档位、外部证据、账务日口径在这里一次装好。
   * 散在各个分支里逐个拼参数，早晚会漏传一个 —— 漏传账务日意味着日累计按服务器时区算。
   */
  private judge(intent: Intent, actor: Actor, policy: Partial<RiskPolicy>, evidence?: RiskEvidence): Decision {
    return evaluate(intent, this.options.state, {
      ...policy,
      actor,
      ...(evidence === undefined ? {} : { evidence }),
      ...(this.options.accountDay === undefined ? {} : { accountDay: this.options.accountDay }),
    });
  }

  /**
   * 计划的可回滚性说明：确认之前就要让用户知道哪几步能撤、哪几步撤不掉。
   * 计划执行中途失败时按这份说明回滚，用户看到的承诺和实际行为才是同一套口径。
   */
  private compensationNote(plan: Plan): string {
    const label = (step: PlanStep): string => specOf(step.intent.tool)?.label ?? step.intent.tool;
    const pickKind = (kind: RollbackKind): string[] => [
      ...new Set(plan.steps.filter((step) => rollbackOf(step.intent.tool).kind === kind).map(label)),
    ];
    const compensable = pickKind("compensable");
    const irreversible = pickKind("irreversible");
    const list = (items: string[]): string => (items.length === 0 ? "" : `（${items.join("、")}）`);
    return (
      `共 ${plan.steps.length} 步：${compensable.length} 步可自动回滚${list(compensable)}，` +
      `${irreversible.length} 步不可回滚${list(irreversible)}`
    );
  }

  /** 判定里真正构成理由的那几条（去掉 base-level 与 actor-tier 这种背景信息）。 */
  private reasonsOf(decision: Decision): string {
    return decision.hits
      .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
      .map((hit) => hit.detail)
      .join("；");
  }

  /** 生效策略：装配时的默认值叠上本次请求的覆盖（前端「严格策略」就走这条路）。 */
  private mergedPolicy(override?: Partial<RiskPolicy>): Partial<RiskPolicy> & { confirmTtlSeconds: number } {
    return { ...(this.options.policy ?? { confirmTtlSeconds: 120 }), ...(override ?? {}) };
  }

  /** 计划预演：只算不执行，用来决定「要不要先要一次整链授权」。 */
  private previewPlan(
    plan: Plan,
    actor: Actor,
    override?: Partial<RiskPolicy>,
    evidences?: Array<RiskEvidence | undefined>,
  ): Array<{ step: PlanStep; decision: Decision }> {
    const policy = this.mergedPolicy(override);
    return plan.steps.map((step, index) => ({
      step,
      decision: this.judge(step.intent, actor, policy, evidences?.[index]),
    }));
  }

  /**
   * 执行计划：每步实时重算 —— 前面步骤会改余额和转账流水，预演结论不能直接拿来用。
   * 任何一步被判红或执行失败，整链停下，并把前面能撤的撤回去。
   * 「能撤的」由 captureUndo 在执行前拍快照决定：没有 undo 的步骤如实说撤不掉。
   */
  private executePlan(
    sessionId: string,
    plan: Plan,
    actor: Actor,
    override?: Partial<RiskPolicy>,
    evidences?: Array<RiskEvidence | undefined>,
  ): { lines: string[]; blocked: Decision | null; last: { seq: number; hash: string } } {
    const policy = this.mergedPolicy(override);
    const actorId = `${actor.userId}/${actor.tier}`;
    const lines: string[] = [];
    // 已执行（或尝试执行）的步骤，逆序回滚用。
    const done: Array<{ stepNo: number; label: string; tool: string; undo: Undo | null; applied: boolean }> = [];
    let last = { seq: 0, hash: "" };

    /** 逆序回滚：能撤的撤，撤不掉的写清理由。 */
    const rollback = (): void => {
      if (done.length === 0) return;
      lines.push(`开始回滚已执行的 ${done.filter((item) => item.applied).length} 步：`);
      for (const item of [...done].reverse()) {
        const spec = rollbackOf(item.tool);
        // 这一步本来就没成功、也没有 undo：没有副作用需要撤，不必占一行说明。
        if (item.undo === null && !item.applied) continue;
        if (item.undo === null) {
          const record = this.options.chain.append({
            sessionId,
            actor: actorId,
            userText: redact(plan.text),
            tool: item.tool,
            decision: "plan_rollback_skipped",
            level: "yellow",
            rules: ["plan-compensation"],
            result: `第 ${item.stepNo} 步不可回滚：${spec.reason}`,
          });
          last = { seq: record.seq, hash: record.hash };
          lines.push(`第 ${item.stepNo} 步「${item.label}」撤不掉：${spec.reason}。`);
          continue;
        }
        const undone = item.undo(this.options.state);
        this.persistState();
        const record = this.options.chain.append({
          sessionId,
          actor: actorId,
          userText: redact(plan.text),
          tool: item.tool,
          decision: undone.ok ? "plan_rollback" : "plan_rollback_failed",
          level: "yellow",
          rules: ["plan-compensation"],
          result: undone.ok ? undone.message : (undone.error ?? "回滚失败"),
        });
        last = { seq: record.seq, hash: record.hash };
        lines.push(`第 ${item.stepNo} 步「${item.label}」${undone.ok ? `已回滚：${undone.message}` : `回滚失败：${undone.error ?? "未知原因"}`}。`);
      }
    };

    for (const [index, step] of plan.steps.entries()) {
      const stepNo = index + 1;
      const label = specOf(step.intent.tool)?.label ?? step.intent.tool;
      const decision = this.judge(step.intent, actor, policy, evidences?.[index]);

      if (decision.blocked) {
        const record = this.options.chain.append({
          sessionId,
          actor: actorId,
          userText: redact(plan.text),
          tool: step.intent.tool,
          decision: "plan_blocked",
          level: "red",
          rules: decision.hits.map((hit) => hit.rule),
          result: `第 ${stepNo}/${plan.steps.length} 步被拦：${decision.summary}`,
        });
        last = { seq: record.seq, hash: record.hash };
        lines.push(`第 ${stepNo} 步「${label}」没有执行：${this.reasonsOf(decision)}。后续步骤一并停止。`);
        rollback();
        return { lines, blocked: decision, last };
      }

      // 条件守卫：余额不够就跳过这一步，这不是失败，后面能做的照做。
      if (step.guard === "balance-sufficient") {
        const amount = typeof step.intent.slots.amountCents === "number" ? (step.intent.slots.amountCents as number) : 0;
        const available = this.options.state.account.available;
        if (amount > available) {
          const record = this.options.chain.append({
            sessionId,
            actor: actorId,
            userText: redact(plan.text),
            tool: step.intent.tool,
            decision: "plan_skipped",
            level: "green",
            rules: ["plan-guard"],
            result: `可用余额 ${yuanText(available)} 元不够 ${yuanText(amount)} 元，跳过`,
          });
          last = { seq: record.seq, hash: record.hash };
          lines.push(`第 ${stepNo} 步「${label}」跳过：可用余额 ${yuanText(available)} 元，不够 ${yuanText(amount)} 元。`);
          continue;
        }
      }

      // 先拍快照再执行：拍完再跑，失败时才能精确复原这一步碰过的字段。
      const undo = captureUndo(step.intent.tool, this.options.state);
      const entry = { stepNo, label, tool: step.intent.tool, undo, applied: true };
      done.push(entry);
      const execution = executeTool(step.intent.tool, step.intent.slots, this.options.state);
      entry.applied = execution.ok;
      this.persistState();
      this.options.hooks?.afterTool?.({ tool: step.intent.tool, slots: step.intent.slots, result: execution });
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(plan.text),
        tool: step.intent.tool,
        decision: execution.ok ? "plan_step" : "plan_step_failed",
        level: decision.level,
        rules: decision.hits.map((hit) => hit.rule),
        result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
      });
      last = { seq: record.seq, hash: record.hash };

      if (!execution.ok) {
        // 执行失败也算中断：把钱动了一半的计划放在那里不管，比不执行更糟。
        lines.push(`第 ${stepNo} 步「${label}」执行失败：${execution.error ?? "未知原因"}。后续步骤一并停止。`);
        rollback();
        const failedDecision: Decision = {
          level: "yellow",
          blocked: false,
          requiresConfirm: false,
          hits: [{ rule: "plan-rollback", detail: `第 ${stepNo} 步执行失败，整链中止并逆序回滚；能撤的已撤，撤不掉的见下方逐条说明` }],
          summary: `${plan.steps.length} 步计划中断`,
        };
        return { lines, blocked: failedDecision, last };
      }

      lines.push(`第 ${stepNo} 步「${label}」：${execution.message}`);
    }
    return { lines, blocked: null, last };
  }

  /** 计划入口：预演 → 有红直接拒绝 / 有黄整链授权 / 全绿直接执行。 */
  private async runPlanFlow(sessionId: string, plan: Plan, actor: Actor, override?: Partial<RiskPolicy>): Promise<ChatReply> {
    const actorId = `${actor.userId}/${actor.tier}`;
    const policy = this.mergedPolicy(override);
    // 取证放在预演之前：整链授权时，用户看到的风险结论必须和真正执行时用的一致。
    const evidences = await this.evidencesFor(plan);
    const preview = this.previewPlan(plan, actor, override, evidences);
    const names = plan.steps
      .map((step, index) => `第 ${index + 1} 步 ${specOf(step.intent.tool)?.label ?? step.intent.tool}`)
      .join(" → ");

    // 一、预演就有红：一步都不执行，先说清卡在哪一步。
    const redIndex = preview.findIndex((item) => item.decision.blocked);
    if (redIndex >= 0) {
      const decision = preview[redIndex].decision;
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(plan.text),
        tool: plan.steps[redIndex].intent.tool,
        decision: "plan_blocked_preview",
        level: "red",
        rules: decision.hits.map((hit) => hit.rule),
        result: `预演第 ${redIndex + 1}/${plan.steps.length} 步即被拦`,
      });
      return {
        sessionId,
        reply: `这个计划共 ${plan.steps.length} 步（${names}），第 ${redIndex + 1} 步就过不去，所以一步都没执行。${this.reasonsOf(decision)}。`,
        scene: "plan",
        decision,
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }

    // 二、有黄：整链一次授权，确认后按顺序执行，任何一步被拦就整体停下。
    if (preview.some((item) => item.decision.requiresConfirm)) {
      const ticket = issueTicket(sessionId, "plan", { steps: plan.steps.length }, policy.confirmTtlSeconds);
      this.pending.set(sessionId, { kind: "plan", ticket: { ...ticket, actor }, plan, policy });
      this.persistSessions();
      const decision: Decision = {
        level: "yellow",
        blocked: false,
        requiresConfirm: true,
        hits: preview.flatMap((item, index) => {
          if (!item.decision.requiresConfirm) return [];
          const extra = item.decision.hits
            .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
            .map((hit) => ({ rule: hit.rule, detail: `第 ${index + 1} 步：${hit.detail}` }));
          if (extra.length > 0) return extra;
          // 没有额外命中也要说清为什么确认：黄的基础等级本身就是理由。
          const label = specOf(plan.steps[index].intent.tool)?.label ?? plan.steps[index].intent.tool;
          return [{ rule: "confirm-required", detail: `第 ${index + 1} 步「${label}」基础等级为黄，执行前需要你确认` }];
        }).concat([{ rule: "plan-compensation", detail: this.compensationNote(plan) }]),
        summary: `${plan.steps.length} 步计划`,
      };
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(plan.text),
        tool: "plan",
        decision: "plan_pending",
        level: "yellow",
        rules: decision.hits.map((hit) => hit.rule),
        result: `待确认：${names}`,
      });
      return {
        sessionId,
        reply: `我把它拆成 ${plan.steps.length} 步：${names}。需要你确认的是：${this.reasonsOf(decision)}。确认后按顺序执行，任何一步被拦就整体停下。${policy.confirmTtlSeconds} 秒内有效。`,
        scene: "plan",
        decision,
        confirmation: { token: ticket.token, expiresAt: ticket.expiresAt },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }

    // 三、全绿：直接执行。
    const { lines, blocked, last } = this.executePlan(sessionId, plan, actor, override, evidences);
    return {
      sessionId,
      reply: `${blocked === null ? `按顺序执行了 ${plan.steps.length} 步` : "计划在中间中断，过程如下"}：\n${lines.join("\n")}`,
      scene: "plan",
      decision:
        blocked ?? {
          level: "green",
          blocked: false,
          requiresConfirm: false,
          hits: [
            { rule: "plan-sequential", detail: `${plan.steps.length} 步全部执行，每步单独判定与留痕` },
            { rule: "plan-compensation", detail: this.compensationNote(plan) },
          ],
          summary: `${plan.steps.length} 步计划`,
        },
      audit: last,
      missing: [],
      intentSource: "rule",
    };
  }

  /** 只看拆解不发车：答辩时用来展示「一句话被拆成了哪几步」。 */
  explainPlan(
    text: string,
    actor: Actor = DEFAULT_ACTOR,
  ): { kind: string; steps: Array<{ tool: string; label: string; level: string; blocked: boolean; rollback: RollbackKind }> } | null {
    const plan = parsePlan(normalize(text), this.options.state);
    if (plan === null) return null;
    const policy = this.options.policy ?? { confirmTtlSeconds: 120 };
    return {
      kind: plan.kind,
      steps: plan.steps.map((step) => {
        const decision = this.judge(step.intent, actor, policy);
        return {
          tool: step.intent.tool,
          label: specOf(step.intent.tool)?.label ?? step.intent.tool,
          level: decision.level,
          blocked: decision.blocked,
          rollback: rollbackOf(step.intent.tool).kind,
        };
      }),
    };
  }

  /** 一次对话：主体（谁）决定档位，文本决定意图，判定决定能不能执行。 */
  async chat(sessionId: string, raw: string, actor: Actor = DEFAULT_ACTOR, policyOverride?: Partial<RiskPolicy>): Promise<ChatReply> {
    const text = normalize(raw);
    const actorId = `${actor.userId}/${actor.tier}`;
    const policy = this.mergedPolicy(policyOverride);

    if (INJECTION.test(text)) {
      const decision: Decision = {
        level: "red",
        blocked: true,
        requiresConfirm: false,
        hits: [{ rule: "injection", detail: "命中指令覆盖或角色扮演特征" }],
        summary: "输入含注入特征",
      };
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: "none",
        decision: "blocked_injection",
        level: "red",
        rules: ["injection"],
        result: "已拦截",
      });
      return {
        sessionId,
        reply: "这句话里包含改变规则的内容，我不会执行。请直接说要办什么业务。",
        scene: "unknown",
        decision,
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }

    // 计划优先：一句话里有多件事就先拆计划，拆不出两步再走单步链路。
    const plan = parsePlan(text, this.options.state);
    if (plan !== null) return await this.runPlanFlow(sessionId, plan, actor, policyOverride);

    let intent = parseIntent(text, this.options.state);
    let intentSource: "rule" | "model" = "rule";
    const draft = this.drafts.get(sessionId);
    // 多轮只补金额：上一轮追问存了草稿，这一轮只有个「五百」，也要能接上。
    if (intent.scene === "unknown" && draft !== undefined) {
      const amount = extractAmount(text);
      if (amount !== null) {
        const slots = { ...draft.slots, amountCents: amount };
        intent = { ...draft, slots, missing: draft.missing.filter((field) => slots[field] === undefined) };
      }
    }
    if (intent.scene === "unknown" || intent.confidence < 0.7) {
      const fromModel = await this.askModel(text);
      if (fromModel !== null) {
        // 模型可以错，但不能编：参数必须能在原文或通讯录里找到依据，找不到就判红。
        intent = groundIntent(fromModel, text, this.options.state);
        intentSource = "model";
      }
    }

    if (intent.scene === "unknown") {
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: "unknown",
        decision: "unmatched",
        level: "unknown",
        rules: ["intent-miss"],
        result: "未识别",
      });
      return {
        sessionId,
        reply: "我没有听懂。可以试：查余额、分析账单、转给小王 500 元、取消云幕视频会员、锁定卡片、赎回理财。",
        scene: "unknown",
        decision: { level: "red", blocked: true, requiresConfirm: false, hits: [{ rule: "intent-miss", detail: "未识别意图" }], summary: "未识别" },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    if (intent.missing.length > 0) {
      this.drafts.set(sessionId, intent);
      this.persistSessions();
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: "need_slots",
        level: "unknown",
        rules: ["slot-missing"],
        result: `缺失 ${intent.missing.join(",")}`,
      });
      const label = intent.missing.map(slotLabel).join("、");
      return {
        sessionId,
        reply: `还需要确认：${label}。`,
        scene: intent.scene,
        decision: { level: "green", blocked: false, requiresConfirm: false, hits: [{ rule: "slot-missing", detail: `缺少${label}` }], summary: "等待补充参数" },
        audit: { seq: record.seq, hash: record.hash },
        missing: intent.missing,
        intentSource,
      };
    }

    this.drafts.delete(sessionId);
    this.persistSessions();
    // 转账先向外部反欺诈取证，再把结论作为一条证据交给判定。
    const evidence = await this.evidenceFor(intent);
    const decision = this.judge(intent, actor, policy, evidence);
    const blocked = this.options.hooks?.beforeTool?.({ tool: intent.tool, slots: intent.slots, decision });
    if (blocked !== undefined && !blocked.allow) {
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: "blocked_hook",
        level: "red",
        rules: ["hook"],
        result: blocked.reason ?? "钩子拒绝",
      });
      return {
        sessionId,
        reply: `这个操作被拦截：${blocked.reason ?? "不符合规则"}。`,
        scene: intent.scene,
        decision: { ...decision, level: "red", blocked: true },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    if (decision.blocked) {
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: "blocked_policy",
        level: "red",
        rules: decision.hits.map((hit) => hit.rule),
        result: decision.summary,
      });
      return {
        sessionId,
        reply: `这个操作我不能直接执行。${decision.hits.filter((hit) => hit.rule !== "base-level").map((hit) => hit.detail).join("；")}。可以在手机上完成人脸验证后办理。`,
        scene: intent.scene,
        decision,
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    if (decision.requiresConfirm) {
      const ticket = issueTicket(sessionId, intent.tool, intent.slots, policy.confirmTtlSeconds);
      this.pending.set(sessionId, { kind: "single", ticket: { ...ticket, actor }, policy });
      this.persistSessions();
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: "pending_confirm",
        level: "yellow",
        rules: decision.hits.map((hit) => hit.rule),
        result: `等待确认：${decision.summary}`,
      });
      const reasons = decision.hits
        .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
        .map((hit) => hit.detail)
        .join("；");
      // 没有额外命中也要说清为什么确认：黄的基础等级本身就是理由。
      const fallback = `「${specOf(intent.tool)?.label ?? intent.tool}」基础等级为黄，执行前需要你确认`;
      return {
        sessionId,
        reply: `准备执行：${decision.summary}。${reasons === "" ? fallback : reasons}。需要你确认，${policy.confirmTtlSeconds} 秒内有效。`,
        scene: intent.scene,
        decision,
        confirmation: { token: ticket.token, expiresAt: ticket.expiresAt },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    const execution = await this.runTool(intent);
    this.persistState();
    this.options.hooks?.afterTool?.({ tool: intent.tool, slots: intent.slots, result: execution });
    const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: execution.ok ? "auto_execute" : "executed_with_error",
      level: "green",
      rules: decision.hits.map((hit) => hit.rule),
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    const fallbackReply = execution.ok ? execution.message : this.failureText(execution.error);
    // 循环的第二跳：把真实执行结果交给模型组织语言，校验不过就用确定性文案。
    const narrated = await this.narrate(sessionId, text, intent, execution, actorId);

    if (narrated !== null) {
      this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: intent.tool,
        decision: narrated.rejectReason === undefined ? "loop_narrated" : "loop_rejected",
        level: "green",
        rules: ["loop-readonly"],
        result:
          narrated.rejectReason === undefined
            ? `循环 ${narrated.loop.steps.length} 步、工具 ${narrated.loop.toolTurns} 次，模型改写通过数字校验`
            : `模型改写被退回（${narrated.rejectReason}），已用确定性文案`,
      });
    }

    return {
      sessionId,
      reply: narrated === null ? fallbackReply : narrated.text,
      scene: intent.scene,
      decision,
      execution,
      audit: { seq: record.seq, hash: record.hash },
      missing: [],
      intentSource,
      ...(narrated === null
        ? {}
        : {
            loop: {
              steps: narrated.loop.steps.length,
              toolTurns: narrated.loop.toolTurns,
              stopReason: narrated.loop.stopReason,
              latencyMs: narrated.loop.latencyMs,
              promptTokens: narrated.loop.promptTokens,
              completionTokens: narrated.loop.completionTokens,
              narrated: narrated.rejectReason === undefined,
              ...(narrated.rejectReason === undefined ? {} : { rejectReason: narrated.rejectReason }),
            },
          }),
    };
  }

  async confirm(sessionId: string, token: string): Promise<ChatReply> {
    const pending = this.pending.get(sessionId);
    const ticket = pending?.ticket;
    const check = verifyTicket(ticket, sessionId, token);
    if (pending === undefined || ticket === undefined || !check.ok) {
      const record = this.options.chain.append({
        sessionId,
        userText: "确认",
        tool: ticket?.tool ?? "unknown",
        decision: "blocked_token_invalid",
        level: "red",
        rules: ["confirm-token"],
        result: check.reason,
      });
      return {
        sessionId,
        reply: `确认失败：${check.reason}。操作没有执行。`,
        scene: "unknown",
        decision: { level: "red", blocked: true, requiresConfirm: false, hits: [{ rule: "confirm-token", detail: check.reason }], summary: "令牌校验失败" },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }
    this.pending.delete(sessionId);
    this.persistSessions();

    // 计划：确认时整体重新预演一遍，通过才按顺序执行。
    if (pending.kind === "plan") {
      // 重新取证再重演：确认这一刻的风险结论，不能沿用发起时那一份。
      const recheckEvidences = await this.evidencesFor(pending.plan);
      const recheckPlan = this.previewPlan(pending.plan, ticket.actor, pending.policy, recheckEvidences);
      const staleIndex = recheckPlan.findIndex((item) => item.decision.blocked);
      if (staleIndex >= 0) {
        const decision = recheckPlan[staleIndex].decision;
        const record = this.options.chain.append({
          sessionId,
          actor: `${ticket.actor.userId}/${ticket.actor.tier}`,
          userText: "确认",
          tool: pending.plan.steps[staleIndex].intent.tool,
          decision: "blocked_stale",
          level: "red",
          rules: decision.hits.map((hit) => hit.rule),
          result: `确认时重演第 ${staleIndex + 1} 步不通过`,
        });
        return {
          sessionId,
          reply: `这个计划在确认期间条件变了，第 ${staleIndex + 1} 步过不去，一步都没执行。${this.reasonsOf(decision)}。请重新提交。`,
          scene: "plan",
          decision,
          audit: { seq: record.seq, hash: record.hash },
          missing: [],
          intentSource: "rule",
        };
      }
      const { lines, blocked, last } = this.executePlan(sessionId, pending.plan, ticket.actor, pending.policy, recheckEvidences);
      return {
        sessionId,
        reply: `${blocked === null ? `已按顺序执行 ${pending.plan.steps.length} 步` : "计划在中间中断，过程如下"}：\n${lines.join("\n")}`,
        scene: "plan",
        decision:
          blocked ?? {
            level: "yellow",
            blocked: false,
            requiresConfirm: false,
            hits: [
              { rule: "plan-confirmed", detail: `${pending.plan.steps.length} 步整链已确认并执行` },
              { rule: "plan-compensation", detail: this.compensationNote(pending.plan) },
            ],
            summary: `${pending.plan.steps.length} 步计划`,
          },
        audit: last,
        missing: [],
        intentSource: "rule",
      };
    }

    // 重算：发令牌到用户点确认之间，状态可能已经变了（另一笔转账吃掉了日累计）。
    // 按「确认时」的状态再判一次，升级成红就停手 —— 不能拿旧结论去动新的钱。
    const policy = this.mergedPolicy(pending.policy);
    const recheckIntent: Intent = {
      scene: specOf(ticket.tool)?.scene ?? "unknown",
      tool: ticket.tool,
      slots: ticket.slots,
      missing: [],
      confidence: 1,
    };
    const recheckEvidence = await this.evidenceFor(recheckIntent);
    const recheck = this.judge(recheckIntent, ticket.actor, policy, recheckEvidence);
    if (recheck.blocked) {
      const reasons = recheck.hits
        .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
        .map((hit) => hit.detail)
        .join("；");
      const record = this.options.chain.append({
        sessionId,
        actor: `${ticket.actor.userId}/${ticket.actor.tier}`,
        userText: "确认",
        tool: ticket.tool,
        decision: "blocked_stale",
        level: "red",
        rules: recheck.hits.map((hit) => hit.rule),
        result: `确认时重算不通过：${recheck.summary}`,
      });
      return {
        sessionId,
        reply: `这笔操作在确认期间条件变了，已停止执行。${reasons}。请重新提交。`,
        scene: specOf(ticket.tool)?.scene ?? "unknown",
        decision: recheck,
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }
    const execution = executeTool(ticket.tool, ticket.slots, this.options.state);
    this.persistState();
    this.options.hooks?.afterTool?.({ tool: ticket.tool, slots: ticket.slots, result: execution });
    const record = this.options.chain.append({
      sessionId,
      actor: `${ticket.actor.userId}/${ticket.actor.tier}`,
      userText: "确认",
      tool: ticket.tool,
      decision: execution.ok ? "confirmed" : "confirmed_failed",
      level: "yellow",
      rules: ["confirm-token"],
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    const fallback = execution.message === "" ? (execution.error ?? "执行失败") : execution.message;
    // 确认之后同样走一轮改写：这是用户最关心的一次回执，措辞要像人话，数字仍由事实约束。
    const confirmIntent: Intent = {
      scene: specOf(ticket.tool)?.scene ?? "unknown",
      tool: ticket.tool,
      slots: ticket.slots,
      missing: [],
      confidence: 1,
    };
    const narrated = await this.narrate(
      sessionId,
      `确认执行 ${specOf(ticket.tool)?.label ?? ticket.tool}`,
      confirmIntent,
      execution,
      `${ticket.actor.userId}/${ticket.actor.tier}`,
    );
    if (narrated !== null) {
      this.options.chain.append({
        sessionId,
        actor: `${ticket.actor.userId}/${ticket.actor.tier}`,
        userText: "确认",
        tool: ticket.tool,
        decision: narrated.rejectReason === undefined ? "loop_narrated" : "loop_rejected",
        level: "yellow",
        rules: ["loop-readonly"],
        result:
          narrated.rejectReason === undefined
            ? `确认后改写通过数字校验（循环 ${narrated.loop.steps.length} 步）`
            : `确认后改写被退回（${narrated.rejectReason}）`,
      });
    }
    return {
      sessionId,
      reply: narrated === null ? fallback : narrated.text,
      scene: confirmIntent.scene,
      decision: { level: "yellow", blocked: false, requiresConfirm: false, hits: [{ rule: "confirmed", detail: "用户已确认" }], summary: "已确认执行" },
      execution,
      audit: { seq: record.seq, hash: record.hash },
      missing: [],
      intentSource: "rule",
      ...(narrated === null
        ? {}
        : {
            loop: {
              steps: narrated.loop.steps.length,
              toolTurns: narrated.loop.toolTurns,
              stopReason: narrated.loop.stopReason,
              latencyMs: narrated.loop.latencyMs,
              promptTokens: narrated.loop.promptTokens,
              completionTokens: narrated.loop.completionTokens,
              narrated: narrated.rejectReason === undefined,
              ...(narrated.rejectReason === undefined ? {} : { rejectReason: narrated.rejectReason }),
            },
          }),
    };
  }

  cancel(sessionId: string): ChatReply {
    this.pending.delete(sessionId);
    this.drafts.delete(sessionId);
    this.persistSessions();
    const record = this.options.chain.append({
      sessionId,
      userText: "取消",
      tool: "none",
      decision: "cancelled",
      level: "green",
      rules: ["cancel"],
      result: "已取消待确认操作",
    });
    return {
      sessionId,
      reply: "已取消，没有执行任何操作。",
      scene: "unknown",
      decision: { level: "green", blocked: false, requiresConfirm: false, hits: [{ rule: "cancel", detail: "用户取消" }], summary: "已取消" },
      audit: { seq: record.seq, hash: record.hash },
      missing: [],
      intentSource: "rule",
    };
  }

  /** 演示用一键重置：业务数据回到初始状态，待确认令牌与草稿清空，审计继续追加不清空。 */
  reset(): { audit: { seq: number; hash: string }; snapshot: Record<string, unknown> } {
    Object.assign(this.options.state, initialState());
    this.pending.clear();
    this.drafts.clear();
    this.persistSessions();
    this.persistState();
    const record = this.options.chain.append({
      sessionId: "system",
      userText: "重置演示数据",
      tool: "none",
      decision: "state_reset",
      level: "green",
      rules: ["reset"],
      result: "业务数据已回到初始状态，审计未清空",
    });
    return { audit: { seq: record.seq, hash: record.hash }, snapshot: this.snapshot() };
  }

  snapshot(): Record<string, unknown> {
    const state = this.options.state;
    return {
      account: {
        holder: state.account.holder,
        balanceYuan: yuanText(state.account.balance),
        availableYuan: yuanText(state.account.available),
        // 整数分单独给一份：测试与对账都按分比，按元字符串比会碰浮点。
        balanceCents: state.account.balance,
        availableCents: state.account.available,
      },
      cards: state.cards,
      subscriptions: state.subscriptions,
      holdingCents: state.holdings.reduce((sum, item) => sum + item.amountCents, 0),
    };
  }

  auditLog(sessionId?: string, limit = 20): { records: unknown[]; chain: { ok: boolean; total: number; brokenAt: number | null } } {
    return { records: this.options.chain.list(sessionId, limit), chain: this.options.chain.verify() };
  }

  /**
   * 演示用：改掉一条审计结论，再返回校验结果。
   * 由 DEMO_TAMPER=on 才能调用，生产必须关闭 —— 审计链的价值就在于改不动。
   */
  tamper(seq: number, result: string): { chain: { ok: boolean; total: number; brokenAt: number | null } } {
    this.options.chain.tamper(seq, result);
    // 篡改动作本身也留痕：谁改的、改了第几条，都进链。
    this.options.chain.append({
      sessionId: "system",
      actor: "demo-tamper",
      userText: "篡改审计演示",
      tool: "none",
      decision: "tamper_demo",
      level: "yellow",
      rules: ["tamper-demo"],
      result: `把第 ${seq} 条结论改成「${result}」`,
    });
    return { chain: this.options.chain.verify() };
  }
}
