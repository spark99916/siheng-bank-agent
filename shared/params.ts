/**
 * 金融参数与依据对照表（单一数据源）。
 *
 * 这个文件只做一件事：把散落在各模块里的阈值，**连同它的出处**集中声明，
 * 再由 `scripts/params-table.mjs` 回源码逐条核对，生成 `docs/08` 那张表。
 *
 * 为什么不把值抄一份放在这里：
 *   抄一份就是两个真相。改了一处忘另一处，对照表会比没有对照表更误导。
 *   所以凡代码里已有常量的，这里直接 import；只有硬编码、尚无常量的，
 *   才靠脚本回源码按锚点校验 —— 这类条目 `singleSource: false`，会被单列成「待收敛」。
 *
 * 依据分三类，不含糊：
 *   regulatory —— 有明确条文出处，写明文件名与口径；
 *   industry   —— 行业惯例、会计或精算口径，写明为什么这样取；
 *   demo       —— 本项目自定的演示值，**不是监管数值**。压低只为让边界在演示中可触发。
 *
 * 最后一条尤其重要：三档限额全部是 demo。把演示值说成「合规要求」是本项目
 * 最不该犯的错 —— 评委只要问一句「哪个文件规定的 1000 元」就露了。
 */

import { PAYEE_RECALL_MINUTES, TIER_POLICY, TRANSFER_MEMORY_DAYS, type RiskPolicy, type Tier } from "./rules.ts";
import { AML_WINDOW_DAYS } from "./aml.ts";
import { BIRTHDAY_LEAD_DAYS, DAYS_PER_YEAR } from "./state.ts";
import { INSTALLMENT_LIMITS } from "./finance.ts";

export type ParamBasis = "regulatory" | "industry" | "demo";

export type ParamGroup = "transfer" | "installment" | "aml" | "birthday" | "wealth" | "token";

export type ParamUnit = "cents" | "pct" | "days" | "minutes" | "count" | "seconds" | "level" | "text";

/**
 * 代码位置用「锚点」而不是行号。
 * 行号在文件上半部分插几行就漂了，锚点不会；脚本搜到锚点后自己算真实行号，
 * 顺便校验这一行里确实出现声明的值 —— 这样「表格记 1000、代码里 800」不可能蒙混过去。
 */
export interface CodeRef {
  file: string;
  anchor: string;
}

export interface ParamEntry {
  /** 稳定标识，脚本与文档用它对齐，不要改。 */
  id: string;
  /** 参数名（展示用）。 */
  name: string;
  group: ParamGroup;
  /** 分档参数才有；同一 compareKey 的不同档位在表里并成一行。 */
  tier?: Tier;
  compareKey?: string;
  value: number | string;
  unit: ParamUnit;
  basis: ParamBasis;
  /** 依据说明：具体到文件名、条文、或「为什么不采用某条规定」。 */
  source: string;
  codeRefs: CodeRef[];
  /** false 表示同一含义在多处定义，存在漂移风险，生成时单列「待收敛」。 */
  singleSource: boolean;
  note?: string;
}

/** 档位与它在 `TIER_POLICY` 里的定义行锚点：一条参数 × 三个档位 = 三行记录。 */
const TIER_ROWS: Array<{ tier: Tier; anchor: string }> = [
  { tier: "standard", anchor: "standard: { singleLimitCents:" },
  { tier: "gold", anchor: "gold: { singleLimitCents:" },
  { tier: "private", anchor: "private: { singleLimitCents:" },
];

/** 按档位取值的那批参数：只声明一次依据，循环套三个档位，避免同一段话手抄三遍抄错。 */
interface TieredSpec {
  key: string;
  name: string;
  pick: (policy: RiskPolicy) => number;
  unit: ParamUnit;
  basis: ParamBasis;
  source: string;
  note?: string;
}

const TIERED_SPECS: TieredSpec[] = [
  {
    key: "single-limit",
    name: "单笔限额",
    pick: (policy) => policy.singleLimitCents,
    unit: "cents",
    basis: "demo",
    source:
      "演示设定，非监管数值。刻意压到千元级，是为了让「超单笔限额」在一条口语指令里就能触发（说「转 800 元」即越过普通档 1000 元的线）。真实手机银行的单笔转账限额通常在 5 万至 100 万元区间，与本题演示目的无关。",
  },
  {
    key: "daily-limit",
    name: "日累计限额",
    pick: (policy) => policy.dailyLimitCents,
    unit: "cents",
    basis: "demo",
    source:
      "演示设定，非监管数值。取单笔限额的 3—4 倍，让「拆成多笔绕过单笔限制」成为可演示的攻击面 —— 这也是拆分形态核查要接手的入口。",
  },
  {
    key: "new-payee-red",
    name: "首次收款人转出红线",
    pick: (policy) => policy.newPayeeRedCents,
    unit: "cents",
    basis: "demo",
    source:
      "演示设定，非监管数值。依据是行业通行的「新收款人首笔从紧」做法：收款人不在近 90 天交易对手里，超过红线不进入自动执行，转人工。金额本身是本项目自定。",
  },
  {
    key: "frequency-window",
    name: "频次统计窗口",
    pick: (policy) => policy.frequencyWindowMinutes,
    unit: "minutes",
    basis: "demo",
    source:
      "演示设定。10 分钟对应反欺诈里「短时高频」特征的最小可信粒度：再短会被正常的连续操作误伤，再长则拆笔攻击会在窗口外完成。三档共用同一窗口，只调笔数上限。",
  },
  {
    key: "frequency-max",
    name: "窗口内同一收款人笔数上限",
    pick: (policy) => policy.frequencyMaxCount,
    unit: "count",
    basis: "demo",
    source:
      "演示设定。随档位放宽（2 / 3 / 5 笔），因为高净值客户的正常交易频率本就更高，用同一笔数卡所有档位会造成误伤。",
  },
];

const transferParams: ParamEntry[] = TIERED_SPECS.flatMap((spec) =>
  TIER_ROWS.map<ParamEntry>((row) => ({
    id: `${spec.key}.${row.tier}`,
    name: spec.name,
    group: "transfer",
    tier: row.tier,
    compareKey: spec.key,
    value: spec.pick(TIER_POLICY[row.tier]),
    unit: spec.unit,
    basis: spec.basis,
    source: spec.source,
    codeRefs: [{ file: "shared/rules.ts", anchor: row.anchor }],
    singleSource: true,
    ...(spec.note === undefined ? {} : { note: spec.note }),
  })),
);

/** 非分档参数：一条一个值，依据逐条写清。 */
const flatParams: ParamEntry[] = [
  {
    id: "transfer.payee-memory-days",
    name: "收款人记忆有效期",
    group: "transfer",
    value: TRANSFER_MEMORY_DAYS,
    unit: "days",
    basis: "demo",
    source:
      "演示设定。只说金额、不说人时，按上次成功转账的收款人补一个默认值 —— 省掉一次追问，代价是系统替用户选了个他没说的对象，所以确认卡必须把「这不是你说的」放在最前面。记忆必须过期：不设期限，等于半年前的一笔转账永远给后面的「转 100 元」背书。取 30 天，与一个自然月的对账周期同宽，且覆盖本演示中所有「上次转过」的对话跨度。",
    codeRefs: [{ file: "shared/rules.ts", anchor: "TRANSFER_MEMORY_DAYS = 30" }],
    singleSource: true,
    note: "记忆范围是账户级不是会话级：换个会话说「再转 100」，指的仍是这个人。",
  },
  {
    id: "transfer.payee-recall-minutes",
    name: "会话内收款人接续时效",
    group: "transfer",
    value: PAYEE_RECALL_MINUTES,
    unit: "minutes",
    basis: "demo",
    source:
      "演示设定。同一个会话里刚点过名的收款人（哪怕那笔还挂在确认卡上、没执行），下一句只说金额时能接多久。与上面 30 天那一档不是一回事：那一档记的是账户里真转出去过的人，用来补一个可核对的默认值；这一档记的是「刚才这几句里的人」，只用来问一句「还是他吗」。取 15 分钟——手机银行把上次收款人一键带入是通行做法（建行「预测式转账」、西安银行「再转一笔」都是这个思路），但那是同屏操作；跨屏的对话上下文没有界面边界，只能靠时间兜。15 分钟够连着办几笔，又不至于让半小时前的一句提及变成本轮的默认证人。",
    codeRefs: [{ file: "shared/rules.ts", anchor: "PAYEE_RECALL_MINUTES = 15" }],
    singleSource: true,
    note: "只用于提问，不用于开卡：接上之后必须先问「还是他吗」，答「是」才出确认卡。问一句的成本是一次回车，省下的是转错人。",
  },
  {
    id: "installment.max-periods",
    name: "分期期数上限",
    group: "installment",
    value: INSTALLMENT_LIMITS.maxPeriods,
    unit: "count",
    basis: "industry",
    source:
      "行业惯例。国内信用卡与消费分期主流期数为 3 / 6 / 12 / 24 期，最长的账单分期一般到 36 期；本项目放到 60 期，留足余量，超出即按非法输入返回 null，不硬凑一个数。",
    codeRefs: [{ file: "shared/finance.ts", anchor: "INSTALLMENT_LIMITS = {" }],
    singleSource: true,
    note: "上界的意义是「拒绝计算」，不是「支持 60 期」——宁可说算不出，也不给看起来合理的假数字。",
  },
  {
    id: "installment.max-monthly-fee",
    name: "月费率上限",
    group: "installment",
    value: INSTALLMENT_LIMITS.maxMonthlyFeeRate,
    unit: "pct",
    basis: "industry",
    source:
      "输入合法性上界，不是合规上界。月费率 5% 折名义年化 60%，早已越过司法实践对民间借贷利率保护的上限区间，正常银行分期不可能出现。设这条是为了拦住明显异常的输入，**真实合规判断看反解出的年化，而不是看费率本身** —— 这也是本项目把 0.6% 翻译成 13.84% 的意义。",
    codeRefs: [{ file: "shared/finance.ts", anchor: "INSTALLMENT_LIMITS = {" }],
    singleSource: true,
  },
  {
    id: "wealth.day-count-basis",
    name: "理财收益折算基准天数",
    group: "wealth",
    value: DAYS_PER_YEAR,
    unit: "days",
    basis: "industry",
    source:
      "行业惯例。货币基金的万份收益与七日年化互算、银行理财的业绩比较基准折算，零售口径通行按 365 天；按 360 天计是银行间拆借与部分债券的 ACT/360 口径，套到零售产品上会系统性高估收益约 1.4%。本项目统一 365 天，收益按毫分累计、结算时向下取整到分。",
    codeRefs: [{ file: "shared/state.ts", anchor: "DAYS_PER_YEAR = 365" }],
    singleSource: true,
    note: "收益因此可独立复算：本金 × 年化 × 持有天数 ÷ 365，不需要相信实现。",
  },
  {
    id: "aml.window-days",
    name: "拆分形态回看窗口",
    group: "aml",
    value: AML_WINDOW_DAYS,
    unit: "days",
    basis: "industry",
    source:
      "行业惯例与场景约束的交集。取 30 天而不是 3 天：AA 结账常拖到月底，消费在前、收款在后是常态，窗口过短会把正当的 AA 判成拆分。同时 30 天覆盖一个自然月，与月结账单的口径一致。",
    codeRefs: [{ file: "shared/aml.ts", anchor: "AML_WINDOW_DAYS = 30" }],
    singleSource: true,
  },
  {
    id: "aml.large-report-line",
    name: "大额交易报告线（刻意未采用）",
    group: "aml",
    value: "50 万元",
    unit: "text",
    basis: "regulatory",
    source:
      "《金融机构大额交易和可疑交易报告管理办法》（中国人民银行令〔2016〕第 3 号）对个人账户境内转账的大额标准为 50 万元人民币。本项目**刻意不套用**这条线：赛题场景是个人日常转账（千元级），套 50 万等于形态判定永不触发，属于把监管条文当摆设。改用行内单笔限额作「压线」参照，并在技术文档写明这一取舍。",
    codeRefs: [{ file: "shared/aml.ts", anchor: "export function detectSplitPattern" }],
    singleSource: true,
    note: "写进表里比藏起来好：不采用某条规定，本身就是一个需要交代的设计决定。",
  },
  {
    id: "birthday.lead-days",
    name: "生日提前下单天数",
    group: "birthday",
    value: BIRTHDAY_LEAD_DAYS,
    unit: "days",
    basis: "industry",
    source:
      "履约时效倒推。鲜花、蛋糕这类时效商品需要提前备货与配送排期，行业惯例是提前 1—3 天下单；取 2 天，既留出配送缓冲，又不至于让「锁资金」与「真下单」隔得太远而失去可控性。",
    codeRefs: [{ file: "shared/state.ts", anchor: "BIRTHDAY_LEAD_DAYS = 2" }],
    singleSource: true,
  },
  {
    id: "birthday.default-budget",
    name: "生日预算缺省值",
    group: "birthday",
    value: 100000,
    unit: "cents",
    basis: "demo",
    source:
      "演示设定，且是本项目已知的缺陷：用户没说金额时，代码直接按 1000 元预锁/下单，而不是追问。金额 1000 元只是随意取的演示值。",
    codeRefs: [
      { file: "shared/rules.ts", anchor: "cleanAmount ?? 100000" },
      { file: "shared/rules.ts", anchor: "extractAmount(stripDate(text)) ?? 100000" },
      { file: "shared/state.ts", anchor: "amount === 0 ? 100000" },
    ],
    singleSource: false,
    note: "同一缺省值在三处硬编码。正确做法是把它收敛成一个常量并改成追问，本次只做对照表，不含修复。",
  },
  {
    id: "wealth.risk-levels",
    name: "投资者风险承受等级",
    group: "wealth",
    value: "1—5 级",
    unit: "level",
    basis: "regulatory",
    source:
      "《证券期货投资者适当性管理办法》（证监会令第 130 号）要求经营机构将投资者与产品按风险等级匹配。本项目用 1—5 整数级（1 最低、5 最高），产品风险等级高于客户承受等级即拒绝申购，与实际业务中的「不得向低风险承受能力投资者销售高风险产品」一致。",
    codeRefs: [{ file: "shared/state.ts", anchor: "export const RISK_LABEL" }],
    singleSource: true,
    note: "等级取值区间是行业通行做法，不是条文原文；条文只要求「匹配」，不规定分几级。",
  },
  {
    id: "token.confirm-ttl",
    name: "确认令牌有效期",
    group: "token",
    value: 120,
    unit: "seconds",
    basis: "industry",
    source:
      "行业惯例。一次性确认令牌的有效期通常在 1—3 分钟：短到让「误点确认」无法在事后很久才生效，长到够用户看清判定理由再决定。本项目取 120 秒，与提示语里「120 秒内有效」同源。",
    codeRefs: [
      { file: "track-pi/src/agent.ts", anchor: "...(this.options.policy ?? { confirmTtlSeconds: 120 })" },
      { file: "track-pi/src/agent.ts", anchor: "const policy = this.options.policy ?? { confirmTtlSeconds: 120 }" },
    ],
    singleSource: false,
    note: "同一缺省值在合并策略与取策略两处各写了一次。收敛成一个常量即可，本次只记录不修改。",
  },
];

/** 全量参数：分档的在前面，横向成表；其余一条一行。 */
export const PARAM_CATALOG: ParamEntry[] = [...transferParams, ...flatParams];

/** 依据类型的中文标签，表和文档共用一份，避免各处自己拼。 */
export const BASIS_LABEL: Record<ParamBasis, string> = {
  regulatory: "监管条文",
  industry: "行业惯例",
  demo: "演示设定",
};

/** 分组的展示顺序与标题。 */
export const GROUP_TITLE: Record<ParamGroup, string> = {
  transfer: "转账风控阈值（按客户档位）",
  installment: "分期成本测算",
  aml: "拆分形态核查",
  birthday: "跨场景：生日礼遇",
  wealth: "理财适当性",
  token: "确认令牌",
};
