import type { BankState, ToolResult } from "../../shared/state.ts";
import { executeTool, initialState, yuanText } from "../../shared/state.ts";
import { CURRENCY_LABEL } from "../../shared/rules.ts";
import type { AuditChain, Decision, Intent, RiskPolicy, Ticket } from "../../shared/rules.ts";
import { evaluate, extractAmount, issueTicket, parseIntent, redact, slotLabel, specOf, verifyTicket } from "../../shared/rules.ts";
import type { McpClient } from "../../shared/mcp-client.ts";
import type { ChatMessage, Transport } from "./transport.ts";

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

export class Agent {
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Ticket & { sessionId: string }>();
  private readonly drafts = new Map<string, Intent>();

  constructor(options: AgentOptions) {
    this.options = options;
  }

  get state(): BankState {
    return this.options.state;
  }

  get transportInfo(): { model: string; available: boolean } {
    return { model: this.options.transport.model, available: this.options.transport.available };
  }

  /** 模型兜底：只产出意图，输出必须过白名单与参数校验。 */
  private async askModel(text: string): Promise<Intent | null> {
    if (!this.options.useModel || !this.options.transport.available) return null;
    const tools = Object.entries({
      query_balance: "查询余额",
      analyze_bills: "账单统计与异常",
      transfer: "转账",
      list_subscriptions: "列出订阅与下次扣费",
      cancel_subscription: "取消订阅",
      lock_card: "锁定或解锁卡片",
      report_loss: "挂失卡片，不可撤销",
      wealth_redeem: "赎回理财",
      birthday_lock: "锁定资金准备生日礼遇",
    }).map(([name, summary]) => ({
      name,
      description: summary,
      parameters: { type: "object", properties: {}, required: [], additionalProperties: true },
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: "你是银行智能体的意图解析器。只调用一个工具，参数用整数分。判断不了调用 unknown。" },
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

  private async runTool(intent: Intent): Promise<ToolResult> {
    if (intent.tool === "fx_convert") return await this.runFx(intent);
    return executeTool(intent.tool, intent.slots, this.options.state);
  }

  async chat(sessionId: string, raw: string): Promise<ChatReply> {
    const text = normalize(raw);
    const policy = this.options.policy ?? { confirmTtlSeconds: 120 };

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
        intent = fromModel;
        intentSource = "model";
      }
    }

    if (intent.scene === "unknown") {
      const record = this.options.chain.append({
        sessionId,
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
      const record = this.options.chain.append({
        sessionId,
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
    const decision = evaluate(intent, this.options.state, policy);
    const blocked = this.options.hooks?.beforeTool?.({ tool: intent.tool, slots: intent.slots, decision });
    if (blocked !== undefined && !blocked.allow) {
      const record = this.options.chain.append({
        sessionId,
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
      this.pending.set(sessionId, ticket);
      const record = this.options.chain.append({
        sessionId,
        userText: redact(text),
        tool: intent.tool,
        decision: "pending_confirm",
        level: "yellow",
        rules: decision.hits.map((hit) => hit.rule),
        result: `等待确认：${decision.summary}`,
      });
      return {
        sessionId,
        reply: `准备执行：${decision.summary}。需要你确认，${policy.confirmTtlSeconds} 秒内有效。`,
        scene: intent.scene,
        decision,
        confirmation: { token: ticket.token, expiresAt: ticket.expiresAt },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    const execution = await this.runTool(intent);
    this.options.hooks?.afterTool?.({ tool: intent.tool, slots: intent.slots, result: execution });
    const record = this.options.chain.append({
      sessionId,
      userText: redact(text),
      tool: intent.tool,
      decision: execution.ok ? "auto_execute" : "executed_with_error",
      level: "green",
      rules: decision.hits.map((hit) => hit.rule),
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    return {
      sessionId,
      reply: execution.ok ? execution.message : this.failureText(execution.error),
      scene: intent.scene,
      decision,
      execution,
      audit: { seq: record.seq, hash: record.hash },
      missing: [],
      intentSource,
    };
  }

  async confirm(sessionId: string, token: string): Promise<ChatReply> {
    const ticket = this.pending.get(sessionId);
    const check = verifyTicket(ticket, sessionId, token);
    if (ticket === undefined || !check.ok) {
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
    const execution = executeTool(ticket.tool, ticket.slots, this.options.state);
    this.options.hooks?.afterTool?.({ tool: ticket.tool, slots: ticket.slots, result: execution });
    const record = this.options.chain.append({
      sessionId,
      userText: "确认",
      tool: ticket.tool,
      decision: execution.ok ? "confirmed" : "confirmed_failed",
      level: "yellow",
      rules: ["confirm-token"],
      result: execution.ok ? execution.message : (execution.error ?? "执行失败"),
    });
    return {
      sessionId,
      reply: execution.message === "" ? (execution.error ?? "执行失败") : execution.message,
      scene: specOf(ticket.tool)?.scene ?? "unknown",
      decision: { level: "yellow", blocked: false, requiresConfirm: false, hits: [{ rule: "confirmed", detail: "用户已确认" }], summary: "已确认执行" },
      execution,
      audit: { seq: record.seq, hash: record.hash },
      missing: [],
      intentSource: "rule",
    };
  }

  cancel(sessionId: string): ChatReply {
    this.pending.delete(sessionId);
    this.drafts.delete(sessionId);
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
      account: { holder: state.account.holder, balanceYuan: yuanText(state.account.balance), availableYuan: yuanText(state.account.available) },
      cards: state.cards,
      subscriptions: state.subscriptions,
      holdingCents: state.holdings.reduce((sum, item) => sum + item.amountCents, 0),
    };
  }

  auditLog(sessionId?: string, limit = 20): { records: unknown[]; chain: { ok: boolean; total: number; brokenAt: number | null } } {
    return { records: this.options.chain.list(sessionId, limit), chain: this.options.chain.verify() };
  }
}
