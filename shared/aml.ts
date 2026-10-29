/**
 * 拆分形态与意图证据：把「形状」和「意图」拆成两条代码路径。
 *
 * 反洗钱有一条铁律——形状必须硬查，意图只能解释、不能豁免。
 * 客户说「我们是 AA」，不能因此放行一笔超限额的款项；反过来，
 * 一句「帮朋友转的」也不能让一批同额转账变得清白。
 *
 * 所以本模块分两层，而且**只出读数、不出结论**：
 *   1) detectSplitPattern：与意图无关的客观读数（笔数、金额、收款人、是否压线）；
 *   2) collectEvidence：系统里能不能找到对得上的单据与消费。
 * 判定（黄/红）留在 rules.ts，这里一行 level 都没有 ——
 * 这样答辩时可以指着两块代码说清：哪部分是事实，哪部分是判断。
 */

import type { BankState } from "./state.ts";

/**
 * 分转元：只用于拼说明文字，不参与任何计算。
 * 这里自带一份而不从 state.ts 引入，是为了避免 state.ts ↔ aml.ts 的循环引用。
 */
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * 证据回看窗口天数。
 *
 * 取 30 天而不是 3 天：AA 结账常常拖到月底，消费在前、收款在后是常态；
 * 窗口太紧会把真实分摊判成「没有消费事由」，那就成了冤案。
 */
export const AML_WINDOW_DAYS = 30;

/** 单笔金额与限额的比例达到这个值就算「压线」——贴着额度写，是规避额度最典型的写法。 */
const HUGGING_RATIO = 0.8;

/** 笔间金额极差超过这个百分比，就不算「同额拆分」，不套用本组规则。 */
const MAX_SPREAD_PCT = 20;

/** 一笔待核查的转账。 */
export interface AmlTransfer {
  payee: string;
  amountCents: number;
}

/** 拆分形态的客观读数：同一批数据，问谁算都是这个结果，与「意图」无关。 */
export interface SplitShape {
  /** 笔数。 */
  count: number;
  /** 每笔金额（同额时才有意义；不同额时取中位数口径的平均值）。 */
  perPaymentCents: number;
  /** 合计。 */
  totalCents: number;
  /** 最小一笔、最大一笔。 */
  minCents: number;
  maxCents: number;
  /** 笔间极差占最大值的百分比，0 表示每笔完全一样。 */
  spreadPct: number;
  /** 金额是否完全相同。 */
  allEqualAmount: boolean;
  /** 不同收款人的个数。 */
  distinctPayees: number;
  /** 单笔限额（来自当前主体的策略）。 */
  limitCents: number;
  /** 低于限额的笔数。 */
  belowLimitCount: number;
  /** 达到或超过限额的笔数。 */
  overLimitCount: number;
  /** 是否每笔都在限额下方。 */
  allBelowLimit: boolean;
  /** 合计是否越过单笔限额。 */
  totalOverLimit: boolean;
  /** 是否每笔都压在限额的 80%—100% 区间。 */
  huggingLimit: boolean;
}

/**
 * 算一份形状读数。
 *
 * 纯函数：不读时钟、不读状态，所以「同一批转账 → 同一份读数」是恒等式，
 * 对照演示里两屏读数一字不差，靠的就是这一点。
 */
export function detectSplitPattern(transfers: AmlTransfer[], limitCents: number): SplitShape {
  const amounts = transfers.map((item) => item.amountCents).filter((value) => Number.isFinite(value) && value > 0);
  const count = amounts.length;
  const totalCents = amounts.reduce((sum, value) => sum + value, 0);
  const minCents = count === 0 ? 0 : Math.min(...amounts);
  const maxCents = count === 0 ? 0 : Math.max(...amounts);
  const perPaymentCents = count === 0 ? 0 : Math.round(totalCents / count);
  const spreadPct = maxCents === 0 ? 0 : ((maxCents - minCents) / maxCents) * 100;
  const distinctPayees = new Set(transfers.map((item) => item.payee)).size;
  const belowLimitCount = amounts.filter((value) => value < limitCents).length;
  const overLimitCount = count - belowLimitCount;
  return {
    count,
    perPaymentCents,
    totalCents,
    minCents,
    maxCents,
    spreadPct,
    allEqualAmount: count > 0 && minCents === maxCents,
    distinctPayees,
    limitCents,
    belowLimitCount,
    overLimitCount,
    allBelowLimit: count > 0 && overLimitCount === 0,
    totalOverLimit: count > 0 && totalCents > limitCents,
    huggingLimit: count > 0 && amounts.every((value) => value >= limitCents * HUGGING_RATIO && value < limitCents),
  };
}

/**
 * 是否构成「拆分形态」：多笔、金额接近、收款人各异、每笔都在限额下方。
 *
 * 注意这里**没有**「合计必须超限额」这一条。多笔同额本身就值得看一眼，
 * 至于有没有真的想规避额度，是后面压线规则与人工复核的事 ——
 * 把「值得看一眼」和「有罪」分开，是这套判定的基本立场。
 */
export function isSplitShape(shape: SplitShape): boolean {
  return shape.count >= 3 && shape.distinctPayees >= 3 && shape.allBelowLimit && shape.spreadPct <= MAX_SPREAD_PCT && shape.perPaymentCents > 0;
}

/** 形状读数的一句话说明：对照演示里两屏并排显示的就是这一行。 */
export function describeShape(shape: SplitShape): string {
  if (shape.count === 0) return "没有可核查的转账笔数，算不出形状读数";
  const limitText = shape.allBelowLimit
    ? `每笔都在单笔限额 ${money(shape.limitCents)} 元下方`
    : `${shape.overLimitCount} 笔达到或超过单笔限额 ${money(shape.limitCents)} 元`;
  return (
    `${shape.count} 笔、每笔 ${money(shape.perPaymentCents)} 元、合计 ${money(shape.totalCents)} 元；` +
    `收款人 ${shape.distinctPayees} 个，笔间极差 ${shape.spreadPct.toFixed(1)}%；` +
    `${limitText}${shape.totalOverLimit ? `，合计已越过单笔限额 ${money(shape.totalCents - shape.limitCents)} 元` : ""}`
  );
}

/** 一条证据：ok=false 表示这一项缺失，缺口要写清缺的是什么。 */
export interface EvidenceItem {
  key: "record" | "relationship" | "purpose";
  label: string;
  ok: boolean;
  detail: string;
}

export interface EvidenceResult {
  items: EvidenceItem[];
  /** 支持「这是消费分摊」的证据项数，0—3。 */
  support: number;
  /** 缺失项的中文名，直接进判定 detail。 */
  missing: string[];
}

export interface EvidenceOptions {
  /** 判定基准时刻，单测要能固定住它。 */
  now?: number;
  /** 回看窗口天数，默认 AML_WINDOW_DAYS。 */
  windowDays?: number;
  /** 已经认定对上的收款单 id；不传就按收款人与每笔金额自动找。 */
  linkedCollectionId?: string;
}

/** 同一批收款人：顺序无关，但人数必须一样。 */
function samePayees(left: string[], right: string[]): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  return left.every((name) => right.includes(name));
}

/**
 * 找证据：这批转账能不能在系统内对上账。
 *
 * 三项证据都指向同一件事——「这笔钱有出处、有单据、有对象」：
 *   record        有没有一份 AA 收款单，人数、每人金额、收款人都对得上；
 *   relationship  收款人是不是通讯录里的人；
 *   purpose       有没有一笔能覆盖这批金额的消费，且这笔消费没被别的收款单占用。
 *
 * 第三项是关键：**一笔消费只能解释一次分摊**。否则把同一笔 216 元的超市消费
 * 反复拿出来，就能给任意多批拆分背书。
 */
export function collectEvidence(
  state: BankState,
  batch: { payees: string[]; perPaymentCents: number },
  options: EvidenceOptions = {},
): EvidenceResult {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? AML_WINDOW_DAYS;
  const payees = batch.payees;
  const batchTotalCents = batch.perPaymentCents * payees.length;

  // 一、单据：收款人一致、每人金额一致的 AA 收款单。
  const record = state.collections.find(
    (item) => item.perPersonCents === batch.perPaymentCents && samePayees(item.payers, payees),
  );
  const linkedId = options.linkedCollectionId ?? record?.id;

  // 二、对象：收款人是否在通讯录里。
  const known = payees.filter((name) => state.contacts.some((contact) => contact.name === name));
  const outsiders = payees.filter((name) => !state.contacts.some((contact) => contact.name === name));

  // 三、事由：窗口内能覆盖本批金额的消费，且没被别的收款单占用。
  const since = now - windowDays * 86400000;
  const candidates = state.bills.filter(
    (bill) => bill.kind === "purchase" && bill.at >= since && bill.amountCents >= batchTotalCents && bill.amountCents <= batchTotalCents * 1.5,
  );
  const claimedByOther = (billId: string): string | null => {
    const bill = state.bills.find((item) => item.id === billId);
    if (bill === undefined) return null;
    const claim = state.collections.find((item) => item.totalCents === bill.amountCents && item.id !== linkedId);
    return claim === undefined ? null : claim.id;
  };
  const usable = candidates.find((bill) => claimedByOther(bill.id) === null);
  const claimed = candidates.find((bill) => claimedByOther(bill.id) !== null);

  const items: EvidenceItem[] = [
    {
      key: "record",
      label: "分摊单据",
      ok: record !== undefined,
      detail:
        record === undefined
          ? `系统里没有与这 ${payees.length} 人、每人 ${money(batch.perPaymentCents)} 元对得上的 AA 收款单`
          : `对上 ${record.id} 号收款单：${record.title} ${money(record.totalCents)} 元、${record.headcount} 人、每人 ${money(record.perPersonCents)} 元，收款人一致`,
    },
    {
      key: "relationship",
      label: "收款对象",
      ok: payees.length > 0 && outsiders.length === 0,
      detail:
        payees.length === 0
          ? "没有可核验的收款人，对象维度无法成立"
          : outsiders.length === 0
            ? `${payees.length} 位收款人全部在通讯录（${payees.join("、")}）`
            : `${known.length}/${payees.length} 位收款人在通讯录：${outsiders.join("、")} 不在册，收款对象无法核验`,
    },
    {
      key: "purpose",
      label: "消费事由",
      ok: usable !== undefined,
      detail:
        usable !== undefined
          ? `对上 ${new Date(usable.at).toISOString().slice(0, 10)} 的消费：${usable.merchant} ${money(usable.amountCents)} 元，能覆盖本批 ${money(batchTotalCents)} 元`
          : claimed !== undefined
            ? `${money(claimed.amountCents)} 元的消费已被 ${claimedByOther(claimed.id)} 号收款单占用，一笔消费只能解释一次分摊`
            : `近 ${windowDays} 天内没有能覆盖 ${money(batchTotalCents)} 元的消费记录`,
    },
  ];

  return {
    items,
    support: items.filter((item) => item.ok).length,
    missing: items.filter((item) => !item.ok).map((item) => item.label),
  };
}
