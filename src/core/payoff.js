/**
 * 提前结清测算。
 *
 * 这里要区分两个「钱」，混淆是绝大多数房贷计算器的通病：
 *   1. settleCash  —— 结清那天要一次性掏出的现金（剩余本金 + 违约金）
 *   2. totalOutlay —— 从放款到结清，整个周期一共花掉的钱（已付月供 + 结清现金）
 *
 * 恒等式（单测守护）：
 *   totalOutlay = principal + interestPaid + penalty
 *   savedInterest = totalInterest − interestPaid − penalty
 *
 * 因为两条路径偿还的本金完全相同，所以差额只会来自利息和违约金。
 */

/**
 * @param {object} options
 * @param {{rows:Array, totals:object}} options.schedule 单笔或合并后的摊销表
 * @param {number} [options.penaltyRate]     违约金率（对剩余本金计），0.01 表示 1%
 * @param {number} [options.penaltyFreeMonths] 还款满多少期后免违约金
 * @param {number} [options.intervalMonths]  采样间隔，默认 12 期（按年）
 * @param {boolean} [options.includeOrigin]  是否包含「第 0 期」起点
 */
export function payoffTimeline(options) {
  const {
    schedule,
    penaltyRate = 0,
    penaltyFreeMonths = 12,
    intervalMonths = 12,
    includeOrigin = true,
  } = options;

  const rows = schedule.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RangeError('摊销表为空，无法测算提前结清');
  }

  const n = rows.length;
  const principal = schedule.totals.principal;
  const originalTotal = schedule.totals.payment;
  const totalInterest = schedule.totals.interest;

  // 前缀和：prefix[k] 表示「正常还完前 k 期」的累计值
  const prefix = [{ paid: 0, interest: 0 }];
  for (const row of rows) {
    const prev = prefix[prefix.length - 1];
    prefix.push({ paid: prev.paid + row.payment, interest: prev.interest + row.interest });
  }

  const penaltyOf = (balance, month) => {
    if (penaltyRate <= 0) return 0;
    if (month >= penaltyFreeMonths) return 0;
    return Math.round(balance * penaltyRate);
  };

  const marks = [];
  if (includeOrigin) marks.push(0);
  for (let m = intervalMonths; m < n; m += intervalMonths) marks.push(m);
  marks.push(n);

  const points = marks.map((month) => {
    const balance = month === 0 ? principal : rows[month - 1].balance;
    const paid = prefix[month].paid;
    const interestPaid = prefix[month].interest;
    const penalty = penaltyOf(balance, month);
    const settleCash = balance + penalty;
    const totalOutlay = paid + settleCash;

    return {
      month,
      year: month / 12,
      balance,
      paid,
      interestPaid,
      penalty,
      settleCash,
      totalOutlay,
      savedInterest: originalTotal - totalOutlay,
      savedRatio: totalInterest > 0 ? (totalInterest - interestPaid - penalty) / totalInterest : 0,
      isPenaltyFree: penalty === 0 && penaltyRate > 0,
      isFinal: month === n,
    };
  });

  return {
    points,
    principal,
    originalTotal,
    totalInterest,
    penaltyRate,
    penaltyFreeMonths,
    intervalMonths,
    // 免违约金的最早采样点，UI 用来画参考线
    firstPenaltyFreeMonth: penaltyRate > 0 ? points.find((p) => p.month >= penaltyFreeMonths)?.month ?? null : 0,
  };
}

/**
 * 一次性结清只影响「结清日」的现金流，不影响已被替换掉的后续期数。
 * 给定一个具体月份，返回该月结清的完整结论；供表格行点击、URL 参数回填使用。
 * 单点直接计算，不展开整条时间线。
 */
export function settleAtMonth(schedule, month, { penaltyRate = 0, penaltyFreeMonths = 12 } = {}) {
  const rows = schedule.rows;
  const n = rows.length;
  const clamped = Math.min(Math.max(Math.round(month), 0), n);

  let paid = 0;
  let interestPaid = 0;
  for (let k = 0; k < clamped; k += 1) {
    paid += rows[k].payment;
    interestPaid += rows[k].interest;
  }

  const principal = schedule.totals.principal;
  const balance = clamped === 0 ? principal : rows[clamped - 1].balance;
  const penalty = penaltyRate > 0 && clamped < penaltyFreeMonths ? Math.round(balance * penaltyRate) : 0;
  const settleCash = balance + penalty;
  const totalOutlay = paid + settleCash;
  const totalInterest = schedule.totals.interest;

  return {
    month: clamped,
    year: clamped / 12,
    balance,
    paid,
    interestPaid,
    penalty,
    settleCash,
    totalOutlay,
    savedInterest: schedule.totals.payment - totalOutlay,
    savedRatio: totalInterest > 0 ? (totalInterest - interestPaid - penalty) / totalInterest : 0,
    isPenaltyFree: penalty === 0 && penaltyRate > 0,
    isFinal: clamped === n,
  };
}
