/**
 * 还款方式权衡分析。
 *
 * 一个容易被误解的点：「等额本金更省利息」是没有例外的 —— 它还本金更快，
 * 利息自然更少。所以不存在「第几年开始互换优势」的临界点。
 *
 * 真正需要量化的是代价：它让你在前期多付多少现金，换来多少利息节省。
 * 对「打算 N 年后结清」的人来说，还要看那个时点上两者的总支出差。
 */

import { settleAtMonth } from './payoff.js';

/**
 * 同一时点结清，两种方式的全周期总支出（已付月供 + 结清现金）。
 *
 * @param {object} scheduleA 方式 A 的排期（通常是等额本息）
 * @param {object} scheduleB 方式 B 的排期（通常是等额本金）
 * @param {number} month 第几期结清，0 表示一开始就结清，等于总期数表示不提前
 * @returns {{ month: number, a: object, b: object, diff: number, cheaper: 'A'|'B'|'TIE' }}
 *   diff 为正表示 B 的总支出更低（B 更省）
 */
export function compareAtMonth(scheduleA, scheduleB, month, penaltyOpts = {}) {
  const a = settleAtMonth(scheduleA, month, penaltyOpts);
  const b = settleAtMonth(scheduleB, month, penaltyOpts);
  const diff = a.totalOutlay - b.totalOutlay;

  return {
    month: a.month,
    year: a.month / 12,
    a: {
      totalOutlay: a.totalOutlay,
      paid: a.paid,
      balance: a.balance,
      penalty: a.penalty ?? 0,
      settleCash: a.settleCash,
    },
    b: {
      totalOutlay: b.totalOutlay,
      paid: b.paid,
      balance: b.balance,
      penalty: b.penalty ?? 0,
      settleCash: b.settleCash,
    },
    diff,
    cheaper: diff > 0 ? 'B' : diff < 0 ? 'A' : 'TIE',
  };
}

/**
 * 全时点差额曲线：每年采样一次，末尾补上整期数。
 *
 * 用来回答「我持有得越久，这个选择的影响是变大还是变小」。
 */
export function settleDiffCurve(scheduleA, scheduleB, { step = 12, penaltyOpts = {} } = {}) {
  const total = scheduleA.rows.length;
  const points = [];

  for (let m = 0; m <= total; m += step) {
    const c = compareAtMonth(scheduleA, scheduleB, m, penaltyOpts);
    points.push({ month: m, year: m / 12, diff: c.diff, totalA: c.a.totalOutlay, totalB: c.b.totalOutlay });
  }

  // 采样步长不整除总期数时，补一个终点，避免曲线在最后一期前就断掉
  if (points.at(-1).month !== total) {
    const c = compareAtMonth(scheduleA, scheduleB, total, penaltyOpts);
    points.push({ month: total, year: total / 12, diff: c.diff, totalA: c.a.totalOutlay, totalB: c.b.totalOutlay });
  }

  return points;
}

/**
 * 权衡摘要：省息 vs 前期现金流压力。
 *
 * extraCash 只统计「B 的月供高于 A」的那段时期累计多付的现金，
 * 不减去后期 B 少付的部分 —— 后期少付是这笔投入的回报，不是成本。
 */
export function tradeoff(scheduleA, scheduleB) {
  const months = Math.min(scheduleA.rows.length, scheduleB.rows.length);

  let extraCash = 0;
  let extraMonths = 0;
  for (let i = 0; i < months; i += 1) {
    const gap = scheduleB.rows[i].payment - scheduleA.rows[i].payment;
    if (gap > 0) {
      extraCash += gap;
      extraMonths = i + 1;
    }
  }

  const savedInterest = scheduleA.totals.interest - scheduleB.totals.interest;
  const peakGap = scheduleB.summary.maxPayment - scheduleA.summary.maxPayment;

  return {
    /** A 比 B 多付的利息（正数表示 B 更省利息） */
    savedInterest,
    /** B 前期累计多付的现金 */
    extraCash,
    /** B 月供高于 A 的期数 */
    extraMonths,
    /** 首月月供差（B 高于 A） */
    peakGap,
    /** 每省 1 元利息，需要前期多垫多少钱 */
    cashPerYuanSaved: savedInterest > 0 ? extraCash / savedInterest : null,
  };
}

/**
 * 到第 month 期为止，B 相对 A 累计多付的现金（只累加正差）。
 *
 * 与 tradeoff().extraCash 的区别：那个是全周期的，这个按指定时点截断。
 * 讨论「持有 N 年」时不能拿全周期的数，否则会算出「第 10 年结清，
 * 但头 13 年在多付」这种自相矛盾的表述。
 */
export function cumulativeExtraCash(scheduleA, scheduleB, month) {
  const n = Math.min(month, scheduleA.rows.length, scheduleB.rows.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const gap = scheduleB.rows[i].payment - scheduleA.rows[i].payment;
    if (gap > 0) sum += gap;
  }
  return sum;
}

/**
 * 在曲线上找出省息额最大的时点 —— 对提前结清的人是关键决策点。
 */
export function bestSettlePoint(curve) {
  if (!curve.length) return null;
  let best = curve[0];
  for (const p of curve) {
    if (p.diff > best.diff) best = p;
  }
  return best;
}
