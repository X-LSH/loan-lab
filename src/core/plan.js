/**
 * 编排层：把「用户输入」翻译成「完整测算结果」。
 * UI 只依赖这一层，不直接碰摊销算法细节。
 */

import { buildSchedule, mergeSchedules, METHOD, METHOD_LABEL } from './amortize.js';
import { payoffTimeline } from './payoff.js';

/**
 * @param {object} input
 * @param {number} input.months 总期数（组合贷两笔共用，符合银行实务）
 * @param {Array<{label:string, principal:number, annualRate:number, method:string}>} input.loans
 *        principal 单位为「分」
 * @param {number} [input.penaltyRate]        违约金率
 * @param {number} [input.penaltyFreeMonths]  免违约金月数
 */
export function buildPlan(input) {
  const { months, loans, penaltyRate = 0, penaltyFreeMonths = 12 } = input;

  if (!Array.isArray(loans) || loans.length === 0) {
    throw new RangeError('至少需要一笔贷款');
  }

  const schedules = loans.map((loan) =>
    buildSchedule({
      principal: loan.principal,
      annualRate: loan.annualRate,
      annualRates: loan.annualRates,
      months,
      method: loan.method ?? METHOD.EQUAL_PAYMENT,
      label: loan.label,
    }),
  );

  const merged = mergeSchedules(schedules);

  const payoff = payoffTimeline({
    schedule: merged,
    penaltyRate,
    penaltyFreeMonths,
    intervalMonths: 12,
  });

  /** 合并后的月供轨迹：把各笔 paymentSteps 按期号对齐求和 */
  const mergedSteps = buildMergedByPeriod(schedules, (s) => s.paymentSteps);
  /** 合并后的利率变化点，供月供图画重定价竖线 */
  const mergedRateChanges = buildMergedByPeriod(schedules, (s) => s.rateChanges);

  return {
    months,
    schedules,
    merged,
    payoff,
    penaltyRate,
    penaltyFreeMonths,
    mergedSteps,
    mergedRateChanges,
    /** 首月两笔各自的构成，用于「月供拆解」展示 */
    firstMonthBreakdown: merged.rows[0]?.parts ?? [],
    /** 各笔在总贷款中的占比 */
    weight: schedules.map((s) => ({
      label: s.label,
      principal: s.principal,
      share: s.principal / merged.totals.principal,
      methodLabel: METHOD_LABEL[s.method],
      annualRates: s.annualRates,
      rateLabel: s.annualRates.length > 1 ? '逐年重定价' : `${(s.annualRates[0] * 100).toFixed(3)}%`,
      totalInterest: s.summary.totalInterest,
      firstPayment: s.summary.firstPayment,
    })),
  };
}

/**
 * 把多笔的某类时点（月供档位 / 利率变化点）按期号对齐合并。
 * 保留 rate 字段——上一版为了画图把 rate 丢了，导致图上一条重定价竖线都画不出来。
 */
function buildMergedByPeriod(schedules, pick) {
  const byPeriod = new Map();
  for (const s of schedules) {
    for (const item of pick(s)) {
      const entry = byPeriod.get(item.period) ?? {
        period: item.period,
        monthly: 0,
        rates: [],
      };
      entry.monthly += item.monthly;
      entry.rates.push(item.rate);
      byPeriod.set(item.period, entry);
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.period - b.period);
}

/**
 * 同一组贷款，全部按等额本息 vs 全部按等额本金，做横向对比。
 * 组合贷下这是「如果两笔都换成另一种方式」的假设性对比，不是合同现状。
 */
export function compareMethods({ months, loans }) {
  const asEqualPayment = buildPlan({
    months,
    loans: loans.map((l) => ({ ...l, method: METHOD.EQUAL_PAYMENT })),
  });
  const asEqualPrincipal = buildPlan({
    months,
    loans: loans.map((l) => ({ ...l, method: METHOD.EQUAL_PRINCIPAL })),
  });

  const ep = asEqualPayment.merged;
  const epr = asEqualPrincipal.merged;

  return {
    equalPayment: {
      method: METHOD.EQUAL_PAYMENT,
      label: METHOD_LABEL[METHOD.EQUAL_PAYMENT],
      firstPayment: ep.summary.firstPayment,
      lastPayment: ep.summary.lastPayment,
      totalInterest: ep.summary.totalInterest,
      totalPayment: ep.summary.totalPayment,
      rows: ep.rows,
    },
    equalPrincipal: {
      method: METHOD.EQUAL_PRINCIPAL,
      label: METHOD_LABEL[METHOD.EQUAL_PRINCIPAL],
      firstPayment: epr.summary.firstPayment,
      lastPayment: epr.summary.lastPayment,
      totalInterest: epr.summary.totalInterest,
      totalPayment: epr.summary.totalPayment,
      rows: epr.rows,
    },
    delta: {
      interestSaved: ep.summary.totalInterest - epr.summary.totalInterest,
      firstPaymentDiff: epr.summary.firstPayment - ep.summary.firstPayment,
    },
  };
}

/** 按年聚合本金/利息，供图表使用（360 期画柱子会糊成一团） */
export function aggregateByYear(schedule) {
  const years = [];
  schedule.rows.forEach((row, index) => {
    const y = Math.floor(index / 12);
    if (!years[y]) {
      years[y] = {
        year: y + 1,
        principal: 0,
        interest: 0,
        payment: 0,
        balance: 0,
        rate: row.annualRate,
      };
    }
    years[y].principal += row.principal;
    years[y].interest += row.interest;
    years[y].payment += row.payment;
    years[y].balance = row.balance;
  });
  return years;
}
