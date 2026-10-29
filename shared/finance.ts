/**
 * 分期成本测算：把「月费率」翻译成真实年化。
 *
 * 银行说「月费率 0.6%、分 12 期」，收的手续费是 本金 × 0.6% × 12 = 7.2%；
 * 但本金是逐月还掉的，平均占用资金只有本金的一半左右，所以真实年化接近 13%。
 *
 * 这不是文字游戏：拿「名义年费率」回答用户，是消费者权益保护里最典型的
 * 信息披露瑕疵。监管要求展示年化利率（IRR 口径），不是一个行业偏好。
 *
 * 本模块只做算术，不读写状态，因此可以在判定阶段直接调用，
 * 不会出现「判一次就把数据改了」的问题。
 */

/** 分期方案的成本画像。金额一律分，百分比一律「数值即百分数」（7.2 表示 7.2%）。 */
export interface InstallmentQuote {
  /** 分期本金，分。 */
  principalCents: number;
  /** 期数。 */
  periods: number;
  /** 月费率，0.006 表示 0.6%。 */
  monthlyFeeRate: number;
  /** 每期还款，分。本金均摊 + 每期手续费，可能带小数（如 893.33）。 */
  perPaymentCents: number;
  /** 手续费合计，分。 */
  totalFeeCents: number;
  /** 还款总额，分。 */
  totalRepayCents: number;
  /** 名义年费率，百分数（7.2）。 */
  nominalAnnualPct: number;
  /** 反解出的月利率，小数（0.010862）。 */
  monthlyRate: number;
  /** 真实年化，单利口径（月利率 × 12），百分数。行业口径的「年化利率」指这个。 */
  annualSimplePct: number;
  /** 真实年化，复利口径（(1+月利率)^12 − 1），百分数。 */
  annualEffectivePct: number;
  /** 真实年化 ÷ 名义年费率，用来提示「差了几倍」。 */
  multiplier: number;
}

/**
 * 分期参数的合法区间。单独导出成对象，是为了让 `shared/params.ts` 的
 * 「参数对照表」能直接引用同一份值 —— 表格里的数字永远等于代码里的数字，
 * 不靠人手抄。改这里等于同时改计算与对照表。
 *
 * 期数上限取 60 期：银行分期最长一般 36 期，留到 60 期足够，超出的属于非法输入。
 * 月费率上限取 5%：超过这个数不可能是正常分期，按非法输入处理，避免算出荒唐结果。
 */
export const INSTALLMENT_LIMITS = { maxPeriods: 60, maxMonthlyFeeRate: 0.05 } as const;

const MAX_PERIODS = INSTALLMENT_LIMITS.maxPeriods;
const MAX_MONTHLY_FEE_RATE = INSTALLMENT_LIMITS.maxMonthlyFeeRate;

/**
 * 二分法解月利率：让「每期还款的现值之和」等于本金。
 *
 * 目标函数单调递减（利率越高，同样现金流的现值越小），所以二分一定收敛；
 * 迭代 200 次能把误差压到远小于 0.01 个基点，比任何展示精度都细。
 */
function solveMonthlyRate(principalCents: number, perPaymentCents: number, periods: number): number {
  const npv = (rate: number): number => {
    let sum = 0;
    for (let k = 1; k <= periods; k += 1) sum += perPaymentCents / (1 + rate) ** k;
    return sum - principalCents;
  };
  // 零费率时现值恰好等于本金，直接返回，避免二分把 0 当成区间下界反复试探。
  if (npv(0) <= 0) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * 算一笔分期。
 *
 * 返回 null 表示参数不合法（本金非正、期数越界、费率越界），
 * 由调用方决定是拦红还是追问槽位 —— 本函数不替业务做判定。
 */
export function installmentQuote(
  principalCents: number,
  periods: number,
  monthlyFeeRate: number,
): InstallmentQuote | null {
  if (!Number.isFinite(principalCents) || principalCents <= 0) return null;
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS) return null;
  if (!Number.isFinite(monthlyFeeRate) || monthlyFeeRate < 0 || monthlyFeeRate > MAX_MONTHLY_FEE_RATE) return null;

  const perPaymentCents = principalCents / periods + principalCents * monthlyFeeRate;
  const totalFeeCents = principalCents * monthlyFeeRate * periods;
  const monthlyRate = solveMonthlyRate(principalCents, perPaymentCents, periods);

  const nominalAnnualPct = monthlyFeeRate * 12 * 100;
  const annualSimplePct = monthlyRate * 12 * 100;
  const annualEffectivePct = ((1 + monthlyRate) ** 12 - 1) * 100;

  return {
    principalCents,
    periods,
    monthlyFeeRate,
    perPaymentCents,
    totalFeeCents,
    totalRepayCents: principalCents + totalFeeCents,
    nominalAnnualPct,
    monthlyRate,
    annualSimplePct,
    annualEffectivePct,
    multiplier: nominalAnnualPct === 0 ? 1 : annualSimplePct / nominalAnnualPct,
  };
}
