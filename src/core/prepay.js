import { buildSchedule, annuityPayment, METHOD } from './amortize.js';

/**
 * 部分提前还款。
 *
 * 与「一次性结清」不同，这里还款后合同继续，必须以结清点为新起点
 * 重建摊销表。两种策略：
 *   - shorten：月供不变，期数减少（总利息更省）
 *   - reduce ：期数不变，月供降低（月供压力更小）
 *
 * 金额全程整数分；新表末期以剩余本金兜底，与 buildSchedule 一致。
 */

export const PREPAY_STRATEGY = {
  SHORTEN: 'shorten',
  REDUCE: 'reduce',
};

/**
 * 由「本金 / 月利率 / 月供」反解还款期数。
 * 年金公式变形：n = -ln(1 − P·i / M) / ln(1+i)
 * 当 P·i ≥ M 时月供不足以覆盖利息，永不结清，抛错而不是返回 Infinity。
 */
function solveTerm(principal, i, monthly) {
  if (i <= 0) return Math.ceil(principal / monthly);
  const ratio = 1 - (principal * i) / monthly;
  if (ratio <= 0) {
    throw new RangeError('月供不足以覆盖剩余利息，无法按此月供缩期');
  }
  return Math.ceil(-Math.log(ratio) / Math.log(1 + i));
}

/**
 * @param {object} input
 * @param {object} input.schedule      buildSchedule 的结果
 * @param {number} input.prepayMonth   提前期数（1-based，必须小于总期数）
 * @param {number} input.prepayAmount  提前还款金额（分）
 * @param {'shorten'|'reduce'} [input.strategy]
 * @param {number} [input.penaltyRate]        违约金比例（按剩余本金）
 * @param {number} [input.penaltyFreeMonths]  免罚期（还款满 X 期后不再收）
 */
export function buildPrepayPlan(input) {
  const {
    schedule,
    prepayMonth,
    prepayAmount,
    strategy = PREPAY_STRATEGY.SHORTEN,
    penaltyRate = 0,
    penaltyFreeMonths = 0,
  } = input;

  const rows = schedule.rows;
  const months = rows.length;

  if (!Number.isInteger(prepayMonth) || prepayMonth < 1 || prepayMonth >= months) {
    throw new RangeError(`提前还款期数必须在 1 到 ${months - 1} 之间`);
  }
  if (!Number.isFinite(prepayAmount) || prepayAmount <= 0) {
    throw new RangeError('提前还款金额必须大于 0');
  }

  const row = rows[prepayMonth - 1];
  const beforeRemain = row.balance;
  const applied = Math.min(Math.round(prepayAmount), beforeRemain);
  const afterRemain = beforeRemain - applied;

  // 违约金按「提前还款前」的剩余本金计收；免罚期内为 0
  const penalty = prepayMonth <= penaltyFreeMonths ? 0 : Math.round(beforeRemain * penaltyRate);

  // 全部还清：退化为一次性结清
  if (afterRemain <= 0) {
    return buildFullPayoff({ rows, prepayMonth, applied, penalty, schedule, input });
  }

  const rate = row.annualRate;
  const i = rate / 12;
  const monthsLeft = months - prepayMonth;
  const isEpr = schedule.method === METHOD.EQUAL_PRINCIPAL;

  let newMonthly;
  let newMonthsLeft;

  if (strategy === PREPAY_STRATEGY.SHORTEN && !isEpr) {
    // 等额本息缩期：月供不变，反解剩余期数
    newMonthly = row.payment;
    newMonthsLeft = solveTerm(afterRemain, i, newMonthly);
  } else if (strategy === PREPAY_STRATEGY.SHORTEN && isEpr) {
    // 等额本金缩期：保持「每期还款本金」不变（那是合同约定），
    // 提前还掉一部分后，期数自然缩短。不能用 afterRemain/剩余期数——
    // 那等于每期本金变小，就成了降月供而非缩期。
    const perPrincipal = rows[0].principal;
    newMonthsLeft = Math.ceil(afterRemain / perPrincipal);
    newMonthly = null; // 等额本金月供逐期递减，无单一月供
  } else {
    // 降月供：期数不变，按剩余本金重算
    newMonthsLeft = monthsLeft;
    newMonthly = isEpr ? null : Math.round(annuityPayment(afterRemain, i, monthsLeft));
  }

  const totalMonths = prepayMonth + newMonthsLeft;

  // 以结清点为新起点重建摊销表
  const newSched = buildSchedule({
    principal: afterRemain,
    annualRate: rate,
    months: newMonthsLeft,
    method: isEpr ? METHOD.EQUAL_PRINCIPAL : METHOD.EQUAL_PAYMENT,
    // 缩期时月供是常数，必须传下去，否则会被年金公式按新期数重算
    fixedMonthly: strategy === PREPAY_STRATEGY.SHORTEN && !isEpr ? newMonthly : undefined,
  });

  const merged = [
    ...rows.slice(0, prepayMonth),
    ...newSched.rows.map((r) => ({ ...r, period: r.period + prepayMonth })),
  ];

  const totalInterest = merged.reduce((s, r) => s + r.interest, 0);
  const totalPayment = merged.reduce((s, r) => s + r.payment, 0);

  return {
    strategy,
    month: prepayMonth,
    prepayAmount: applied,
    penalty,
    beforeRemain,
    afterRemain,
    rate,
    newMonthly,
    newTotalMonths: totalMonths,
    monthsSaved: months - totalMonths,
    rows: merged,
    totals: {
      // 全周期总支出 = 各期月供 + 提前还款 + 违约金。
      // 若漏掉提前还款那笔，恒等式「总支出 = 本金 + 已付利息 + 违约金」就不成立。
      payment: totalPayment + applied + penalty,
      interest: totalInterest,
      penalty,
      // 必须是「贷款本金」，不是 rows[0].principal（那是第一期还的本金）
      principal: schedule.principal,
    },
    summary: {
      firstPayment: merged[prepayMonth].payment,
      lastPayment: merged.at(-1).payment,
    },
  };
}

/** 全部提前还清：退化为一次性结清，末期直接结平 */
function buildFullPayoff({ rows, prepayMonth, applied, penalty, schedule, input }) {
  const merged = rows.slice(0, prepayMonth);
  const totalInterest = merged.reduce((s, r) => s + r.interest, 0);
  return {
    strategy: input.strategy,
    month: prepayMonth,
    prepayAmount: applied,
    penalty,
    beforeRemain: rows[prepayMonth - 1].balance,
    afterRemain: 0,
    rate: rows[prepayMonth - 1].annualRate,
    newMonthly: 0,
    newTotalMonths: prepayMonth,
    monthsSaved: rows.length - prepayMonth,
    rows: merged,
    totals: {
      payment: merged.reduce((s, r) => s + r.payment, 0) + applied + penalty,
      interest: totalInterest,
      penalty,
      principal: schedule.principal,
    },
    summary: {
      firstPayment: merged[1]?.payment ?? 0,
      lastPayment: merged.at(-1).payment,
    },
  };
}

/**
 * 部分提前还款的收益对比：与「不还」相比省了多少。
 */
export function comparePrepay(originalSchedule, prepayPlan) {
  const origInterest = originalSchedule.totals.interest;
  const newInterest = prepayPlan.totals.interest;
  const saved = origInterest - newInterest - prepayPlan.penalty;
  return {
    originalInterest: origInterest,
    newInterest,
    penalty: prepayPlan.penalty,
    savedInterest: saved,
    savedMonths: originalSchedule.rows.length - prepayPlan.newTotalMonths,
  };
}
