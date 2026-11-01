import type { BankState, ToolResult } from "../../shared/state.ts";
import { executeTool, holdingValues, initialState, isSelfPayee, runDueBirthdayGifts, yuanText } from "../../shared/state.ts";
import { CURRENCY_LABEL } from "../../shared/rules.ts";
import type { AccountDayConfig, Actor, AuditChain, Decision, Intent, Plan, PlanStep, RiskEvidence, RiskPolicy, Ticket } from "../../shared/rules.ts";
import { agoText, DEFAULT_ACTOR, evaluate, extractAmount, extractPayee, groundIntent, issueTicket, lastTransferRef, parseIntent, parsePlan, PAYEE_RECALL_MINUTES, redact, slotLabel, specOf, verifyTicket, type LastTransfer } from "../../shared/rules.ts";
import type { McpClient } from "../../shared/mcp-client.ts";
import type { FileStore } from "../../shared/persist.ts";
import { StateConflictError } from "../../shared/persist.ts";
import { IdempotencyLog, fingerprintOf, validRequestId } from "../../shared/idempotency.ts";
import { HandoffBoard, HandoffRejected } from "../../shared/handoff.ts";
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
  /** 幂等记录保留多久：超时后同一个请求编号可以再用，但不会再回放旧结果。 */
  idempotencyTtlSeconds?: number;
  /** 转人工工单多久没人处置就超时结案（记 no-action，不假装办完了）。 */
  handoffTimeoutSeconds?: number;
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
  /**
   * 幂等相关：只有带 requestId 的请求才可能出现。
   * replayed = 重复提交，回放首次结果、没有重做；interrupted = 上次办到一半进程没了；
   * conflict = 编号被别的内容占了。正常首次执行时为 undefined。
   */
  idempotent?: "replayed" | "interrupted" | "conflict";
  /**
   * 转人工工单：interrupted 时会开一张，带工单号回给用户。
   * 开单失败也会出现在这里（id 为 null），因为「没开成」也是必须让人看见的事实。
   */
  handoff?: { id: string | null; reason: string; note: string };
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

/**
 * 「是」「对」「嗯」「好」—— 这些词单独成句时，就是在回答上一句问话。
 *
 * 只认整句，不在长句里找。用户说「是转给小李」时那是一个新指令：
 * 他答应的是「转给小王」这件事吗？不是，他要换成小李。差一次转账，
 * 不能因为句首有个「是」就当成点头。
 */
const AFFIRM_WORDS = new Set([
  "是", "是的", "是呀", "是啊", "对", "对的", "对啊", "嗯", "嗯嗯", "嗯对", "好", "好的",
  "可以", "确认", "没错", "就是", "就他", "行", "ok", "okay",
]);

const DENY_WORDS = new Set([
  "不是", "不对", "不", "不用", "不要", "不转", "换", "换个", "换人", "换一个", "不是他", "别人",
]);

/** 去掉标点与空白，只留字面，用来做整句比对。 */
function bareOf(text: string): string {
  return text.replace(/[，,。、！!?？：:.．…~～\s]/g, "").toLowerCase();
}

/**
 * 在「还是转给小王吗」的语境里，一句 2–4 个汉字大概率就是个人名。
 *
 * 前提是这句没被认成别的业务 —— 调用方先跑过 parseIntent，能认成查余额、
 * 锁卡的都走不到这里。剩下还认不出的短句，在这个语境里当人名，
 * 比回一句「没听懂」更接近用户的意思。
 */
function looksLikePayeeName(bare: string): boolean {
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(bare)) return false;
  return !AFFIRM_WORDS.has(bare) && !DENY_WORDS.has(bare);
}

/**
 * 收款人是怎么来的 —— 决定了确认卡上要写哪一种说明。
 *
 * history：账户里**真的转出去过**的那一笔（30 天内）。用户没说人时补一个默认值，
 *          直接出卡，卡上标明「不是你这一轮说的」。
 * recall ：**同一个会话里刚点过名**的那一笔（15 分钟内），哪怕那笔还没执行。
 *          这一档不直接出卡，先问一句「还是他吗」—— 上下文再近也是推的，
 *          推的东西必须得到一句明确的「是」才往下走。
 */
type PayeeOrigin = "history" | "recall";

type PayeeSource = LastTransfer & { from: PayeeOrigin };

/** 待确认的任务：可能是单步，也可能是一整个计划。策略存进来，确认时用同一套阈值重算。 */
type Pending =
  | { kind: "single"; ticket: Ticket & { sessionId: string; actor: Actor }; policy: Partial<RiskPolicy>; payeeSource?: PayeeSource }
  | { kind: "plan"; ticket: Ticket & { sessionId: string; actor: Actor }; plan: Plan; policy: Partial<RiskPolicy> };

export class Agent {
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly drafts = new Map<string, Intent>();
  /**
   * 本会话里刚确定过对象的那一笔 —— 刚点过名、刚出过卡，都算。
   *
   * 和 transferLog 不是一回事：transferLog 只在**真的执行成功**后才有记录，
   * 而用户往往是「说了一笔、还没确认」就开始说下一笔。这时候拿 transferLog
   * 去找人必然找不到，于是系统重复问「转给谁」—— 话头就是这么断的。
   *
   * 只放内存不落盘：这是「刚才那几句」的记忆，进程重启意味着这段对话结束了，
   * 留到下次开机反而危险（谁能保证还是同一个人坐在屏幕前）。
   */
  private readonly recentPayees = new Map<string, LastTransfer>();
  /**
   * 已经问出「这 200 元还是转给小王吗」、正等用户答的那一次提议。
   *
   * 单独存一份而不是复用 drafts：drafts 表示「参数不全、等着补」，
   * 这里是「参数齐了、但对象是推的，等着点头」，两者在审计上是不同的事。
   */
  private readonly payeeOffers = new Map<string, { payee: string; amountCents: number; at: number }>();
  /** 幂等日志：请求编号 → 办到哪一步、结果是什么。落盘，重启后仍能查。 */
  private readonly idem: IdempotencyLog;
  /** 进程内正在办的请求：同一个编号并发进来，复用同一个 Promise，不并发执行两遍。 */
  private readonly running = new Map<string, Promise<ChatReply>>();
  /** 转人工工单板：钱可能已经动了的时候，把责任落成一张可追踪的单。 */
  private readonly handoffs: HandoffBoard;

  constructor(options: AgentOptions) {
    this.options = options;
    this.idem = new IdempotencyLog(options.store, { ttlSeconds: options.idempotencyTtlSeconds });
    this.handoffs = new HandoffBoard(options.store, { timeoutSeconds: options.handoffTimeoutSeconds });
    this.restoreSessions();
  }

  get idempotencyInfo(): { entries: number; ttlSeconds: number } {
    return { entries: this.idem.size, ttlSeconds: this.idem.ttlSeconds };
  }

  /** 工单板的对外入口：开单、认领、结案、超时清扫、读数。 */
  get handoffBoard(): HandoffBoard {
    return this.handoffs;
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

  /**
   * 业务状态快照：每次动过钱或动过数据后立刻写，只在内存里改等于重启就回到开盘。
   *
   * 多实例下这一句可能失败：盘上的账已经被别的进程写过了。这时候**内存必须拉回盘上**，
   * 否则接下来所有判定都基于一份根本不存在的账 —— 那比丢一笔更糟，
   * 因为内存里那笔「已经转了」的钱会在下一次写盘时变成真的。
   *
   * 拉回之后把错误抛给上层，由上层决定怎么跟用户说。不吞。
   */
  private persistState(): void {
    const store = this.options.store;
    if (store === undefined) return;
    try {
      store.saveState(this.options.state);
    } catch (error) {
      if (!(error instanceof StateConflictError)) throw error;
      const loaded = store.loadState();
      if (loaded.kind === "disk") this.adoptState(loaded.state);
      throw error;
    }
  }

  /**
   * 用盘上的账覆盖内存里的账。
   *
   * 就地覆盖字段而不是换掉 this.options.state 这个引用：apply 之后，
   * 已经拿过 state 的地方（判定、工具、循环）看到的是同一份新数据，
   * 不会出现「一半代码看着旧账、一半看着新账」。
   */
  private adoptState(next: BankState): void {
    Object.assign(this.options.state, next);
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
      props: { period: { type: "string", enum: ["this-month", "last-month", "3-months", "this-year"], description: "时间口径，默认 this-month" } },
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
    {
      name: "birthday_lock",
      summary: "锁定一笔资金准备生日礼遇",
      props: {
        amountCents: { type: "integer", description: "锁定金额，整数分" },
        birthday: { type: "string", description: "生日 MM-DD，用户没说就不要填" },
      },
      required: ["amountCents"],
    },
    {
      name: "birthday_order",
      summary: "登记生日前 2 天下单鲜花与蛋糕，额度必须来自已预锁资金",
      props: {
        birthday: { type: "string", description: "生日 MM-DD" },
        budgetCents: { type: "integer", description: "预算上限，整数分，不得超过已锁定金额" },
      },
      required: ["birthday", "budgetCents"],
    },
    {
      name: "split_collect",
      summary: "把一笔已垫付的总额按人头拆开，向其他人 AA 收款",
      props: {
        totalCents: { type: "integer", description: "垫付总额，整数分" },
        headcount: { type: "integer", description: "参与人数，含自己，至少 2" },
        title: { type: "string", description: "用途，如 聚餐、打车" },
        payers: { type: "array", items: { type: "string" }, description: "需要付钱给你的人名，只能填原文出现的名字" },
      },
      required: ["totalCents", "headcount"],
    },
    {
      name: "schedule_transfer",
      summary: "登记预约转账，到期不自动扣款，仍需本人确认",
      props: {
        payee: { type: "string", description: "收款人姓名，只能填原文出现的名字" },
        amountCents: { type: "integer", description: "金额，整数分" },
        dueOffsetDays: { type: "integer", description: "几天后到期，明天填 1" },
      },
      required: ["payee", "amountCents"],
    },
    { name: "list_scheduled", summary: "查询待执行的预约转账", props: {}, required: [] },
    { name: "apply_card", summary: "申请办卡，制卡在线下完成", props: {}, required: [] },
    { name: "adjust_limit", summary: "调整额度（线上不执行，需柜面）", props: {}, required: [] },
    {
      name: "fx_convert",
      summary: "按实时汇率换算外币金额",
      props: {
        amountCents: { type: "integer", description: "人民币金额，整数分" },
        currency: { type: "string", enum: ["USD", "EUR", "JPY", "HKD", "GBP"], description: "目标币种" },
      },
      required: ["amountCents", "currency"],
    },
    {
      name: "installment_quote",
      summary: "测算分期真实年化成本：本金、期数、月费率，输出每期还款与真实年化",
      props: {
        principalCents: { type: "integer", description: "分期本金，整数分（12000 元填 1200000）" },
        periods: { type: "integer", description: "期数，如 12" },
        monthlyFeeRate: { type: "number", description: "月费率小数值，月费率 0.6% 填 0.006，不要填 0.6" },
      },
      required: ["principalCents", "periods", "monthlyFeeRate"],
    },
    {
      name: "aml_check",
      summary: "核查一批同额多笔转账是否像拆分规避额度：输出与意图无关的形状读数，再逐项核对单据、对象、事由三项证据，不给结论",
      props: {
        perPaymentCents: { type: "integer", description: "每笔金额，整数分（每笔 54 元填 5400），不是合计" },
        payees: { type: "array", items: { type: "string" }, description: "收款人姓名，一人一笔" },
      },
      required: ["perPaymentCents", "payees"],
    },
  ];

  /** 取这个会话里还没过期的「刚点过名的收款人」。过期的顺手清掉，不留陈旧对象。 */
  private recentPayee(sessionId: string, now: number = Date.now()): LastTransfer | null {
    const kept = this.recentPayees.get(sessionId);
    if (kept === undefined) return null;
    if (now - kept.at > PAYEE_RECALL_MINUTES * 60000) {
      this.recentPayees.delete(sessionId);
      return null;
    }
    return kept;
  }

  /** 记下这一笔的对象 —— 出卡就算定过，不必等执行成功。 */
  private rememberPayee(sessionId: string, payee: string, amountCents: number): void {
    this.recentPayees.set(sessionId, { payee, amountCents, at: Date.now() });
  }

  /**
   * 取走待答的提议：一句问话只接一次回答，接完即清。
   *
   * 不清的话会出事：用户回了「不是」，这句提议却还挂着，下一句随口的
   * 「嗯」就会被当成答应了「转给小王」。
   */
  private takePayeeOffer(
    sessionId: string,
    now: number = Date.now(),
  ): { payee: string; amountCents: number; at: number } | null {
    const offer = this.payeeOffers.get(sessionId);
    if (offer === undefined) return null;
    this.payeeOffers.delete(sessionId);
    if (now - offer.at > PAYEE_RECALL_MINUTES * 60000) return null;
    return offer;
  }

  /**
   * 缺槽位时的追问：说清已经记下什么、还差什么、怎么答。
   * 只说「还需要确认：收款人」，用户不知道该怎么答；把已记下的复述一遍，
   * 他才看得出自己刚才那句有没有被接住。
   */
  private promptForSlots(intent: Intent): string {
    const payee = typeof intent.slots.payee === "string" ? intent.slots.payee : "";
    const amount = typeof intent.slots.amountCents === "number" ? intent.slots.amountCents : null;
    const known: string[] = [];
    if (payee !== "") known.push(`转给${payee}`);
    if (amount !== null) known.push(`${yuanText(amount)} 元`);
    const kept = known.length === 0 ? "" : `已记下：${known.join("、")}。`;

    const needPayee = intent.missing.includes("payee");
    const needAmount = intent.missing.includes("amountCents");
    if (needPayee && needAmount) {
      return "好的，这笔转账想转给谁、转多少呢？您一句话说清就行，例如：转给小王 500 元。";
    }
    if (needPayee) return `${kept}请问这笔转给谁呢？您说个名字，我把收款人和金额一起念给您确认。`;
    if (needAmount) return `${kept}请问转多少呢？您说个数，我把收款人和金额一起念给您确认。`;
    return `还想跟您核对一下：${intent.missing.map(slotLabel).join("、")}。`;
  }

  /**
   * 「这 200 元还是转给小王吗」—— 承接上一句，但把决定权交回去。
   *
   * 为什么不直接出卡：卡一出来，用户很容易顺手点确认。对象是推的，
   * 就该多问一句。问一句的成本是一次回车，省下的是转错人。
   */
  private offerRecalledPayee(
    sessionId: string,
    text: string,
    actorId: string,
    recall: LastTransfer,
    amountCents: number,
  ): ChatReply {
    const record = this.options.chain.append({
      sessionId,
      actor: actorId,
      userText: redact(text),
      tool: "transfer",
      decision: "need_payee_confirm",
      level: "green",
      rules: ["payee-recalled"],
      result: `等待确认收款人：沿用刚才的「${recall.payee}」`,
    });
    return {
      sessionId,
      reply:
        `已记下：${yuanText(amountCents)} 元。还是转给「${recall.payee}」吗？` +
        `您回「是」我就按这个开卡；要换人，直接说名字就行。`,
      scene: "transfer",
      decision: {
        level: "green",
        blocked: false,
        requiresConfirm: false,
        hits: [
          {
            rule: "payee-recalled",
            detail: `刚才那笔的收款人是「${recall.payee}」，这一笔记下了金额，对象还没定`,
          },
        ],
        summary: "等待确认收款人",
      },
      audit: { seq: record.seq, hash: record.hash },
      missing: ["payee"],
      intentSource: "rule",
    };
  }

  /** 用户说「不是」—— 把这次沿用丢掉，老老实实再问一遍人是谁。 */
  private askPayeeAgain(sessionId: string, text: string, actorId: string, amountCents: number): ChatReply {
    this.drafts.set(sessionId, {
      scene: "transfer",
      tool: "transfer",
      slots: { amountCents },
      missing: ["payee"],
      confidence: 1,
      source: "rule",
    });
    this.persistSessions();
    const record = this.options.chain.append({
      sessionId,
      actor: actorId,
      userText: redact(text),
      tool: "transfer",
      decision: "need_slots",
      level: "unknown",
      rules: ["payee-declined"],
      result: "缺失 payee",
    });
    return {
      sessionId,
      reply: `好，那这笔 ${yuanText(amountCents)} 元请问转给谁呢？您说个名字，我把收款人和金额一起念给您确认。`,
      scene: "transfer",
      decision: {
        level: "green",
        blocked: false,
        requiresConfirm: false,
        hits: [{ rule: "slot-missing", detail: "缺少收款人" }],
        summary: "等待补充参数",
      },
      audit: { seq: record.seq, hash: record.hash },
      missing: ["payee"],
      intentSource: "rule",
    };
  }

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
      .map((step, index) => {
        const label = specOf(step.intent.tool)?.label ?? step.intent.tool;
        const payee = typeof step.intent.slots.payee === "string" ? step.intent.slots.payee : "";
        const amount = typeof step.intent.slots.amountCents === "number" ? step.intent.slots.amountCents : null;
        // 转账那一步必须把对象和金额念出来：用户确认的是这两个值，不是「第一步」。
        const detail =
          step.intent.tool === "transfer" && payee !== "" && amount !== null ? `（${payee}，${yuanText(amount)} 元）` : "";
        return `第 ${index + 1} 步 ${label}${detail}`;
      })
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
        hits: preview
          .flatMap((item, index) => {
            if (!item.decision.requiresConfirm) return [];
            const extra = item.decision.hits
              .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
              .map((hit) => ({ rule: hit.rule, detail: `第 ${index + 1} 步：${hit.detail}` }));
            if (extra.length > 0) return extra;
            // 没有额外命中也要说清为什么确认：黄的基础等级本身就是理由。
            const label = specOf(plan.steps[index].intent.tool)?.label ?? plan.steps[index].intent.tool;
            return [{ rule: "confirm-required", detail: `第 ${index + 1} 步「${label}」基础等级为黄，执行前需要你确认` }];
          })
          // 计划里的收款人如果是推出来的，必须单独标一条：整链授权最怕的就是
          // 用户以为自己在同意「两步」，实际上同意了「转给某个他没说的对象」。
          .concat(
            plan.steps
              .map((step, index) =>
                step.payeeDefaulted === undefined
                  ? null
                  : { rule: "payee-defaulted", detail: `第 ${index + 1} 步没说转给谁，按上次收款人「${step.payeeDefaulted}」补的` },
              )
              .filter((item): item is { rule: string; detail: string } => item !== null),
          )
          .concat([{ rule: "plan-compensation", detail: this.compensationNote(plan) }]),
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

  /**
   * 幂等外壳：同一个 requestId 只办一次。
   *
   * 判断顺序是刻意排的 ——
   *   ① 本进程正在办 → 直接复用同一个 Promise（并发双击不会变成两笔）
   *   ② 盘上有记录 → 回放结果；记的是 inflight 就说明上次办到一半进程没了，转人工不重做
   *   ③ 都没有 → 先落 inflight，再办，办完落 done
   *
   * 第 ③ 步的 inflight 必须先落盘：它是崩溃时唯一能说明「这笔动过钱」的凭据。
   * 不带 requestId 的请求（旧客户端、验收脚本）原样穿过，行为与 v1.7 一致。
   */
  private async withIdempotency(
    method: "chat" | "confirm",
    requestId: string | undefined,
    sessionId: string,
    param: string,
    run: () => Promise<ChatReply>,
    actor?: string,
  ): Promise<ChatReply> {
    const key = validRequestId(requestId);
    if (key === undefined) return run();

    const running = this.running.get(key);
    if (running !== undefined) return running;

    const fingerprint = fingerprintOf(method, sessionId, param);
    const lookup = this.idem.lookup(key, method, sessionId, fingerprint);

    if (lookup.kind === "conflict") {
      const record = this.options.chain.append({
        sessionId,
        userText: redact(param),
        tool: method,
        decision: "idempotency_conflict",
        level: "red",
        rules: ["idempotency"],
        result: `${key}：${lookup.reason}`,
      });
      return {
        sessionId,
        reply: `${lookup.reason}。本次没有执行，请换一个请求编号再试。`,
        scene: "unknown",
        decision: { level: "red", blocked: true, requiresConfirm: false, hits: [{ rule: "idempotency", detail: lookup.reason }], summary: "请求编号冲突" },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
        idempotent: "conflict",
      };
    }

    if (lookup.kind === "interrupted") {
      const record = this.options.chain.append({
        sessionId,
        userText: redact(param),
        tool: method,
        decision: "idempotency_interrupted",
        level: "red",
        rules: ["idempotency"],
        result: `${key}：上次执行中断，结果未知，未重做`,
      });
      const escalated = this.escalate({
        sessionId,
        method,
        rawText: param,
        requestId: key,
        actor: actor ?? "未记录（confirm 请求不带主体）",
        audit: { seq: record.seq, hash: record.hash },
      });
      return {
        sessionId,
        reply:
          escalated.id === null
            ? `这笔操作上次办到一半进程中断了，结果未知。系统没有重做，但**工单没开成**（${escalated.note}），已记一条红审计并告警，请立即联系人工核对，不要再次提交。`
            : `这笔操作上次办到一半进程中断了，结果未知。为避免重复扣款，系统没有重做，已转入人工核对，工单号 ${escalated.id}，请不要再次提交。`,
        scene: "unknown",
        decision: { level: "red", blocked: true, requiresConfirm: false, hits: [{ rule: "idempotency", detail: "上次执行中断，结果未知" }], summary: "执行中断待人工核对" },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
        idempotent: "interrupted",
        handoff: { id: escalated.id, reason: "suspended-funds", note: escalated.note },
      };
    }

    if (lookup.kind === "replay") {
      if (lookup.state === "inflight") return run();
      const record = this.options.chain.append({
        sessionId,
        userText: redact(param),
        tool: method,
        decision: "idempotency_replay",
        level: "green",
        rules: ["idempotency"],
        result: `${key}：重复提交，回放首次结果，未重复执行`,
      });
      const cached = lookup.reply as ChatReply | undefined;
      if (cached === undefined) {
        // 记了失败却没有结果：如实说失败，但不重做。
        return {
          sessionId,
          reply: `这笔操作上次没有办成（${lookup.record.error ?? "未知原因"}），系统没有重做。`,
          scene: "unknown",
          decision: { level: "yellow", blocked: false, requiresConfirm: false, hits: [{ rule: "idempotency", detail: "上次失败，未重做" }], summary: "重复提交" },
          audit: { seq: record.seq, hash: record.hash },
          missing: [],
          intentSource: "rule",
          idempotent: "replayed",
        };
      }
      return {
        ...cached,
        reply: `${cached.reply}\n（同一笔请求重复提交，系统回放首次结果，没有重复执行）`,
        audit: { seq: record.seq, hash: record.hash },
        idempotent: "replayed",
      };
    }

    this.idem.begin(key, method, sessionId, fingerprint);
    const task = (async () => {
      try {
        const reply = await run();
        this.idem.finish(key, reply);
        return reply;
      } catch (error) {
        // 抛出去之前把记录钉成 failed：异常可能发生在动过钱之后，宁可认「办砸了」也不让重试重做。
        this.idem.fail(key, error instanceof Error ? error.message : "处理失败");
        throw error;
      }
    })();
    this.running.set(key, task);
    try {
      return await task;
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * 把「结果未知」落成一张工单 —— 这才是「已转人工」的真实含义。
   *
   * 交接包里每一项都是为了让接单的人不必从头问一遍：
   * 原话、幂等编号、审计位置、已经做了什么、建议他确认哪几项。
   * 金额写 null 而不是 0：崩溃场景里「不知道动了多少」是常态，
   * 写成 0 会让人以为没悬空，那是最危险的误导。
   *
   * 开单失败不当异常吞掉。那恰恰是最坏的一种情况 —— 本该有个责任人，结果没有。
   * 所以补一条红审计 handoff_open_failed，并把原因写进给用户的回复里。
   */
  private escalate(args: {
    sessionId: string;
    method: string;
    rawText: string;
    requestId: string;
    actor: string;
    audit: { seq: number; hash: string };
  }): { id: string | null; note: string } {
    try {
      const ticket = this.handoffs.open(
        {
          reason: "suspended-funds",
          sessionId: args.sessionId,
          actor: args.actor,
          rawText: args.rawText,
          // 崩在中间时，原意图已经随着进程一起丢了 —— 如实记成只有方法名，不猜。
          intent: { tool: args.method, slots: {}, slotOrigin: {} },
          decision: { level: "red", rules: ["idempotency"], summary: "执行中断，结果未知" },
          executed: { done: false, action: "未知：进程在办到一半时中断，无法确认是否已动账" },
          requestId: args.requestId,
          audit: args.audit,
          suspendedCents: null,
          advice: "用幂等编号核对这笔是否已动账；核对清楚之前不要重做，也不要让用户再次提交",
          entry: `session:${args.sessionId}`,
        },
        { idemState: "inflight", rules: ["idempotency"], level: "red" },
      );
      this.options.chain.append({
        sessionId: args.sessionId,
        userText: redact(args.rawText),
        tool: "handoff",
        decision: "handoff_opened",
        level: "red",
        rules: ["handoff", ticket.packet.reason],
        result: `${ticket.packet.id}：执行中断，悬空金额未知`,
      });
      return { id: ticket.packet.id, note: "悬空金额未知，需按编号核账" };
    } catch (error) {
      const reason =
        error instanceof HandoffRejected
          ? `${error.reason}：${error.message}`
          : error instanceof Error
            ? error.message
            : "未知原因";
      this.options.chain.append({
        sessionId: args.sessionId,
        userText: redact(args.rawText),
        tool: "handoff",
        decision: "handoff_open_failed",
        level: "red",
        rules: ["handoff"],
        result: `${args.requestId}：${reason}`,
      });
      return { id: null, note: reason };
    }
  }

  /** 一次对话：主体（谁）决定档位，文本决定意图，判定决定能不能执行。 */
  async chat(sessionId: string, raw: string, actor: Actor = DEFAULT_ACTOR, policyOverride?: Partial<RiskPolicy>, requestId?: string): Promise<ChatReply> {
    return this.guardConflict(sessionId, raw, () =>
      this.withIdempotency("chat", requestId, sessionId, raw, () => this.chatOnce(sessionId, raw, actor, policyOverride), `${actor.userId}/${actor.tier}`),
    );
  }

  /**
   * 兜住「账本被别人改过」这一种失败。
   *
   * 放在 chat / confirm 的入口而不是每个 persistState 旁边：写盘的地方有十几处，
   * 逐处写 try/catch 迟早漏一处，而漏掉的那一处正好是转账 —— 那时候用户看到的是 500，
   * 账到底动没动没人说得清。在这里收口，任何路径都跑不掉。
   */
  private async guardConflict(sessionId: string, userText: string, run: () => Promise<ChatReply>): Promise<ChatReply> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof StateConflictError)) throw error;
      const detail =
        error.reason === "busy"
          ? "账本正被另一个进程写入，这次没能写进去"
          : `另一个实例刚改过账本（盘上第 ${error.diskRevision} 版，本次基于第 ${error.baseRevision} 版）`;
      const record = this.options.chain.append({
        sessionId,
        userText: redact(userText),
        tool: "storage",
        decision: "blocked_state_conflict",
        level: "red",
        rules: ["state-conflict"],
        result: detail,
      });
      return {
        sessionId,
        reply: `这笔操作**没有执行**：${detail}。为避免把别人的记录覆盖掉，本次已停止，你的余额没有变化，请稍后重试。`,
        scene: "unknown",
        decision: {
          level: "red",
          blocked: true,
          requiresConfirm: false,
          hits: [{ rule: "state-conflict", detail }],
          summary: "账本版本冲突",
        },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource: "rule",
      };
    }
  }

  private async chatOnce(sessionId: string, raw: string, actor: Actor = DEFAULT_ACTOR, policyOverride?: Partial<RiskPolicy>): Promise<ChatReply> {
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
    /**
     * 本轮槽位是怎么凑齐的 —— 这决定执行前是否必须让用户再看一眼。
     * 一次说清的不算（那是正常用法），下面三种都不是：
     * followup      上一轮追问过，这一轮补上剩下的一半；
     * default-payee 用户没说人，按账户里**真的转出去过**的人补的；
     * recall        用户没说人，按这个会话里**刚点过名**的对象接上的，
     *               并且已经问过一句「还是他吗」、用户答了「是」。
     */
    let slotOrigin: "followup" | "default-payee" | "recall" | null = null;
    /**
     * 收款人若是系统补的/接的，这里放着依据（谁、多少、什么时候）。
     * 确认卡要把这几样一起念出来 —— 用户核对的不是一个名字，
     * 是「是不是这个人」。
     */
    let payeeSource: PayeeSource | null = null;

    /**
     * 上一轮刚问过「这 200 元还是转给小王吗」，这一轮就是在答它。
     *
     * 只在这一轮算数：答完（或答非所问）提议立刻作废。留着的话，用户下一句
     * 随口的「嗯」会被当成答应了一笔他早就不想要了的转账。
     */
    const offered = this.takePayeeOffer(sessionId);
    if (offered !== null) {
      const bare = bareOf(text);
      if (AFFIRM_WORDS.has(bare)) {
        // 点头了 —— 就用刚才那个人开卡，金额是这一轮说的那个。
        intent = {
          scene: "transfer",
          tool: "transfer",
          slots: { payee: offered.payee, amountCents: offered.amountCents },
          missing: [],
          confidence: 1,
          source: "rule",
        };
        slotOrigin = "recall";
        payeeSource = { payee: offered.payee, amountCents: offered.amountCents, at: offered.at, from: "recall" };
      } else if (DENY_WORDS.has(bare)) {
        return this.askPayeeAgain(sessionId, text, actorId, offered.amountCents);
      } else if (intent.scene === "unknown" && looksLikePayeeName(bare) && !isSelfPayee(bare, this.options.state)) {
        /**
         * 「小李」—— 在「还是小王吗」这个问句里，单独一个名字就是换人。
         *
         * 这时不收 slotOrigin：收款人是用户亲口说的，不是系统接的，
         * 确认卡上不需要交代「他是哪来的」。金额倒是接着上一句的，
         * 但那是用户自己刚说过的数，同样不用额外解释。
         */
        intent = {
          scene: "transfer",
          tool: "transfer",
          slots: { payee: bare, amountCents: offered.amountCents },
          missing: [],
          confidence: 1,
          source: "rule",
        };
      }
      // 其它情况（在说别的业务、或给了一句完整的转账指令）就把这次提议放下，
      // 按正常流程解析 —— 用户已经在说下一件事，硬接上去只会办错。
    }

    // 多轮补齐：上一轮追问存了草稿，这一轮可能只说了金额，也可能只说了人。
    if (intent.scene === "unknown" && draft !== undefined) {
      const amount = extractAmount(text);
      const bare = bareOf(text);
      /**
       * 只有转账草稿才认收款人：别的业务没有「人」这个槽位，抽出来也没处放。
       *
       * 短名字单独成句要单独兜一层：正则只认「转给××」这种带介词的写法，
       * 而追问之后用户往往只回两个字（「小李」）。既然上一句刚问的就是
       * 「转给谁」，这一句的短名字就只能是答案 —— 再回一句「没把握准」，
       * 相当于不承认自己刚才问过什么。
       */
      const named =
        draft.tool === "transfer" && draft.missing.includes("payee") && looksLikePayeeName(bare) && !isSelfPayee(bare, this.options.state)
          ? bare
          : null;
      const payee = draft.tool === "transfer" ? (extractPayee(text, this.options.state) ?? named) : null;
      if (amount !== null || payee !== null) {
        const slots = { ...draft.slots };
        if (amount !== null) slots.amountCents = amount;
        if (payee !== null) slots.payee = payee;
        intent = { ...draft, slots, missing: draft.missing.filter((field) => slots[field] === undefined) };
        if (draft.tool === "transfer") slotOrigin = "followup";
      }
    }

    // 只说了金额、没说人。
    if (
      intent.tool === "transfer" &&
      slotOrigin === null &&
      intent.missing.includes("payee") &&
      typeof intent.slots.amountCents === "number"
    ) {
      const amountCents = intent.slots.amountCents;
      /**
       * ① 先看这个会话里刚点过名的对象。
       *
       * 用户上一句才说「转给小王 100 元」，这一句说「转 200 元」，心里那个人
       * 还是小王。拿 transferLog 去找必然找不到 —— 上一笔还挂在确认卡上、
       * 没执行过，日志里根本没有它。于是系统从头再问一遍「转给谁」，
       * 等于把刚接上的话头掐断。
       *
       * 但接上归接上，不替他做主：这里只问一句「还是他吗」，不出卡。
       */
      const recall = this.recentPayee(sessionId);
      if (recall !== null) {
        this.payeeOffers.set(sessionId, { payee: recall.payee, amountCents, at: Date.now() });
        return this.offerRecalledPayee(sessionId, text, actorId, recall, amountCents);
      }
      // ② 会话里没有，再看账户历史里真转出去过的那一笔（30 天内）。
      const previous = lastTransferRef(this.options.state);
      if (previous !== null) {
        intent = {
          ...intent,
          slots: { ...intent.slots, payee: previous.payee },
          missing: intent.missing.filter((field) => field !== "payee"),
        };
        slotOrigin = "default-payee";
        payeeSource = { ...previous, from: "history" };
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

    /**
     * 新指令取代未决操作。
     *
     * 出过确认卡之后用户改主意了 —— 说「转给小李 600 元」被判红，那张「转给小王 100 元」
     * 的旧卡还留在待确认表里。用户回头点一下，转出去的就是他刚刚已经放弃的那个人、那个金额。
     * 令牌查不出这件事：票没被改过，也没过期。所以要在新指令进来的这一刻把票收走。
     *
     * 只收同工具的：先问一句「我余额多少」再回来点确认，是正常用法，不能把票抢走。
     */
    const supersede = (tool: string): void => {
      const waiting = this.pending.get(sessionId);
      if (waiting === undefined || waiting.ticket.tool !== tool) return;
      this.pending.delete(sessionId);
      this.persistSessions();
      this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool,
        decision: "pending_superseded",
        level: "yellow",
        rules: ["superseded"],
        result: `新的${specOf(tool)?.label ?? tool}指令到了，上一张确认卡作废`,
      });
    };
    if (intent.tool !== "unknown") supersede(intent.tool);

    /**
     * 自称还有两种情况到不了判定：上一轮已经签出确认卡（草稿清掉了），或者用户
     * 上来就说「我自己」。这时再回「没把握准」，用户会觉得系统没听懂人话 ——
     * 而它恰恰是一件必须说清楚的事：转给自己不成立。这里兜一句。
     */
    const bareText = text.replace(/[，,。、！!？?：:\s]/g, "");
    if (intent.scene === "unknown" && bareText !== "" && isSelfPayee(bareText, this.options.state)) {
      // 这句就是在回上一张转账卡，卡必须一起作废 —— 不能让人说「我自己」之后再点旧卡。
      supersede("transfer");
      const holder = this.options.state.account.holder;
      const record = this.options.chain.append({
        sessionId,
        actor: actorId,
        userText: redact(text),
        tool: "transfer",
        decision: "rejected",
        level: "red",
        rules: ["self-transfer"],
        result: "收款人是账户本人",
      });
      return {
        sessionId,
        reply:
          `「${bareText}」就是账户本人（${holder}），不能作为收款人 —— 转账只用于他人账户。` +
          "给自己的另一张卡调拨资金请走账户互转。",
        scene: "transfer",
        decision: {
          level: "red",
          blocked: true,
          requiresConfirm: false,
          hits: [{ rule: "self-transfer", detail: `收款人「${bareText}」就是账户本人（${holder}）` }],
          summary: "收款人是账户本人，转账不成立",
        },
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
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
        reply: "抱歉，这句我没把握准，怕办错，就先没动。您可以换个说法：查余额、分析账单、转给小王 500 元、取消云幕视频会员、锁定卡片、赎回理财。",
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
        reply: this.promptForSlots(intent),
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
    let decision = this.judge(intent, actor, policy, evidence);
    /**
     * 槽位是分两轮凑的，或者在用户没说人的前提下按上次收款人补的 —— 这两种都不是
     * 「用户一次说清」的指令，执行前必须让用户再看一眼。转账本来就判黄，这里再显式
     * 兜一层：将来若有人把转账的基础等级调成绿，补过的槽位仍然绕不过确认。
     */
    if (slotOrigin !== null && intent.tool === "transfer") {
      const payee = typeof intent.slots.payee === "string" ? intent.slots.payee : "";
      const detail =
        slotOrigin === "default-payee"
          ? `你没说转给谁，按上次收款人「${payee}」补的`
          : slotOrigin === "recall"
            ? `收款人「${payee}」是接着上一轮的对象，你已经答过一次「是」`
            : "收款人和金额是分两轮补全的";
      const rule = slotOrigin === "default-payee" ? "payee-defaulted" : slotOrigin === "recall" ? "payee-recalled" : "slot-completed";
      decision = {
        ...decision,
        requiresConfirm: true,
        hits: [...decision.hits, { rule, detail }],
      };
    }
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
      // 转给自己是「业务不成立」，不是「风险高」也不是「权限不够」：
      // 不能把额度、人脸验证这些无关理由混进来，否则用户会以为多验一次就能办。
      const selfBlocked = decision.hits.some((hit) => hit.rule === "self-transfer");
      const reasons = (
        selfBlocked
          ? decision.hits.filter((hit) => hit.rule === "self-transfer")
          : decision.hits.filter((hit) => hit.rule !== "base-level")
      )
        .map((hit) => hit.detail)
        .join("；");
      const tail = selfBlocked
        ? "转账只用于他人账户；给自己的另一张卡调拨资金请走账户互转。"
        : intent.tool === "aml_check"
          ? "请补充分摊单据或消费凭证后交由人工复核。"
          : "可以在手机上完成人脸验证后办理。";
      return {
        sessionId,
        // 核查类工具本来就不办业务，别在末尾劝人去人脸验证——它要的是补凭证和人工复核。
        reply: `这个操作我不能直接执行。${reasons}。${tail}`,
        scene: intent.scene,
        decision,
        audit: { seq: record.seq, hash: record.hash },
        missing: [],
        intentSource,
      };
    }

    if (decision.requiresConfirm) {
      const ticket = issueTicket(sessionId, intent.tool, intent.slots, policy.confirmTtlSeconds);
      this.pending.set(sessionId, {
        kind: "single",
        ticket: { ...ticket, actor },
        policy,
        ...(payeeSource === null ? {} : { payeeSource }),
      });
      /**
       * 出卡就算「这个对象定过了」—— 不必等执行成功。
       * 下一句只说金额时，才有东西可接：「还是转给小王吗」问的就是这里记下的。
       */
      const settledPayee = typeof intent.slots.payee === "string" ? intent.slots.payee : "";
      const settledAmount = typeof intent.slots.amountCents === "number" ? intent.slots.amountCents : null;
      if (intent.tool === "transfer" && settledPayee !== "" && settledAmount !== null) {
        this.rememberPayee(sessionId, settledPayee, settledAmount);
      }
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
      // 「收款人是怎么来的」已经单独成段说过了，理由里不再重复一遍。
      // 同一件事说两遍，读者只会以为哪里出了两个问题。
      const reasons = decision.hits
        .filter((hit) => hit.rule !== "base-level" && hit.rule !== "actor-tier")
        .filter((hit) => !(payeeSource !== null && hit.rule === "payee-defaulted"))
        .filter((hit) => !(payeeSource?.from === "recall" && hit.rule === "payee-recalled"))
        .map((hit) => hit.detail)
        .join("；");
      // 没有额外命中也要说清为什么确认：黄的基础等级本身就是理由。
      const fallback = `「${specOf(intent.tool)?.label ?? intent.tool}」基础等级为黄，执行前需要你确认`;
      // 转账要把两样东西念清楚：转给谁、转多少。用户确认的就是这两个值，
      // 不能让他对着「准备执行：转账（判定黄）」去猜自己要同意什么。
      const confirmPayee = settledPayee;
      const confirmAmount = settledAmount;
      const detailed = intent.tool === "transfer" && confirmPayee !== "" && confirmAmount !== null;
      const checklist = detailed ? `请核对：收款人 ${confirmPayee}，金额 ${yuanText(confirmAmount)} 元。` : "";
      const headline = detailed
        ? `准备执行：转账给「${confirmPayee}」${yuanText(confirmAmount)} 元。`
        : `准备执行：${decision.summary}。`;
      /**
       * 收款人是推出来的，就必须在卡上占一整段，而且放在理由之前。
       *
       * 混在「转账执行后无法撤销；你没说转给谁，按上次收款人补的」里，
       * 读起来像两条并列的免责声明；而这一条才是用户真正要决定的：
       * 这张卡要转出去的，是不是他要转的那个人。所以三件事一次说清 ——
       * 这不是你说的、我是按什么补的（带上次的金额与时间）、要改怎么改。
       *
       * recall 那一档只要一句：用户刚亲口答过「是」，再把来龙去脉讲一遍，
       * 反倒像在质疑他刚才那句话。
       */
      const provenance =
        payeeSource === null
          ? ""
          : payeeSource.from === "recall"
            ? `\n收款人「${payeeSource.payee}」沿用你上一轮确认过的对象；要换成别人，说「转给小李 ${yuanText(confirmAmount ?? payeeSource.amountCents)} 元」。\n`
            : `\n收款人不是你这轮说的：你没提转给谁，我按上次转账补上了 —— ${agoText(payeeSource.at)}转过 ${yuanText(payeeSource.amountCents)} 元给他。` +
              `要换人请重说一句（例如「转给小李 100 元」），我重新开一张。\n`;
      return {
        sessionId,
        reply: `${headline}${provenance}${reasons === "" ? fallback : reasons}。${checklist}需要你确认，${policy.confirmTtlSeconds} 秒内有效。`,
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

  async confirm(sessionId: string, token: string, requestId?: string): Promise<ChatReply> {
    return this.guardConflict(sessionId, "确认", () =>
      this.withIdempotency("confirm", requestId, sessionId, token, () => this.confirmOnce(sessionId, token)),
    );
  }

  private async confirmOnce(sessionId: string, token: string): Promise<ChatReply> {
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
    /**
     * 收款人是系统补的，回执里再留一句 —— 卡上说过一次，这里是第二道留痕。
     *
     * 不是免责声明：用户事后翻记录时，「这钱转给了谁、当时是怎么定的」要能自己看明白，
     * 而不是只看到「已向 小王 转账 100.00 元」，以为自己当时说的是小王。
     */
    const originNote =
      pending.kind !== "single" || pending.payeeSource === undefined || !execution.ok
        ? ""
        : pending.payeeSource.from === "recall"
          ? `\n备注：收款人「${pending.payeeSource.payee}」是接着上一轮的对象，你回过「是」，又在确认卡上核过。`
          : `\n备注：收款人「${pending.payeeSource.payee}」是按上次转账补上的，你已在确认卡上核过。`;
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
      reply: (narrated === null ? fallback : narrated.text) + originNote,
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
    // reset 重置的是业务数据，不是账本版本：initialState 给的是第 0 版，
    // 直接盖上去，下一次写盘就会被版本校验拦下来（盘上早就不是第 0 版了）。
    // 版本号表达「这份账写过几次」，reset 本身也是一次写，所以沿用再递增。
    const fresh = initialState();
    fresh.revision = this.options.state.revision;
    Object.assign(this.options.state, fresh);
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
      // 持仓市值单列一份：本金与收益是两个口径，只报本金等于对用户少报了他赚到的钱。
      holdingValues: holdingValues(state).map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        principalCents: item.principalCents,
        interestCents: item.interestCents,
        marketValueCents: item.marketValueCents,
        heldDays: item.heldDays,
      })),
      collections: state.collections,
      birthdayGifts: state.birthdayGifts,
      lockedFunds: state.lockedFunds,
    };
  }

  /**
   * 调度一拍：把到期的生日礼遇真正下单。
   * now 可显式传入 —— 验收要确定性地把时钟推到「生日前 2 天」，
   * 靠等真实时间过去的测试不叫测试。
   */
  tick(now = Date.now()): { ordered: Array<{ id: string; ok: boolean; message: string }>; audit: { seq: number; hash: string } | null } {
    const results = runDueBirthdayGifts(this.options.state, now);
    if (results.length === 0) return { ordered: [], audit: null };
    let last = { seq: 0, hash: "" };
    for (const item of results) {
      const record = this.options.chain.append({
        sessionId: "system",
        actor: "scheduler",
        userText: `定时任务：生日礼遇到期下单（时钟 ${new Date(now).toISOString().slice(0, 10)}）`,
        tool: "birthday_order",
        decision: item.ok ? "gift_ordered" : "gift_cancelled",
        level: item.ok ? "yellow" : "green",
        rules: [item.ok ? "gift-scheduled" : "gift-cancelled"],
        result: item.message,
      });
      last = { seq: record.seq, hash: record.hash };
    }
    this.persistState();
    return { ordered: results, audit: last };
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
