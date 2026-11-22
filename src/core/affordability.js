/**
 * 负担能力与压力测试。
 *
 * 视角与「算月供」相反：不是「这笔贷款月供多少」，而是
 * 「以我的收入，这笔月供算不算重」「利率涨到多少我就扛不住」。
 *
 * 所有金额为整数分，利率为年化小数（0.0305 = 3.05%）。
 * 银行实际审批口径各家不同，这里的 50% 是行业常见参考线，不作为承诺。
 */

import { annuityPayment } from './amortize.js';

/** 银行常见的月供收入比上限（本笔 + 其他负债） */
export const DEFAULT_MAX_DTI = 0.5;

/** 压力测试的利率上浮档位：+50bp 与 +100bp */
export const RATE_BUMPS = [0.005, 0.01];

/**
 * 评估月供是否在可承受范围内。
 *
 * @param {object} p
 * @param {number} p.monthlyIncome 家庭月收入（分）
 * @param {number} [p.monthlyDebt] 其他月度负债还款额（分）
 * @param {number} p.payment 本笔月供（分）
 * @param {number} [p.maxDti] 审批线，默认 50%
 * @returns {null|object} 收入缺失时返回 null，不编造结论
 */
export function assessAffordability({
  monthlyIncome,
  monthlyDebt = 0,
  payment,
  maxDti = DEFAULT_MAX_DTI,
}) {
  if (!Number.isFinite(monthlyIncome) || monthlyIncome <= 0) return null;
  if (!Number.isFinite(payment) || payment < 0) return null;

  const dti = payment / monthlyIncome;
  const totalDti = (payment + monthlyDebt) / monthlyIncome;
  /** 按审批线，本笔月供最多能占多少 */
  const paymentRoom = Math.max(0, monthlyIncome * maxDti - monthlyDebt);

  return {
    dti,
    totalDti,
    maxDti,
    paymentRoom,
    /** 正数表示还有余量，负数表示已经超出 */
    headroom: paymentRoom - payment,
    withinLimit: totalDti <= maxDti,
  };
}

/**
 * 压力测试：利率上浮后月供变成多少。
 *
 * @returns {Array<{ bump: number, annualRate: number, payment: number, delta: number, dti: number|null }>}
 */
export function stressTest({ principal, months, annualRate, payment, monthlyIncome, bumps = RATE_BUMPS }) {
  return bumps.map((bump) => {
    const stressed = annuityPayment(principal, (annualRate + bump) / 12, months);
    return {
      bump,
      annualRate: annualRate + bump,
      payment: stressed,
      delta: stressed - payment,
      dti: monthlyIncome > 0 ? stressed / monthlyIncome : null,
    };
  });
}

/**
 * 组合贷的压力测试：逐笔按各自的本金、期限、利率重算首月月供，再合并。
 *
 * 不能拿合并后的总月供乘个系数 —— 两笔的利率与还款方式可能不同，
 * 上浮同样的 bp 对不同贷款的影响比例并不一样。
 *
 * @param {object} schedule 单笔或合并排期（需要 schedules 或自身字段）
 * @param {number} bump 利率上浮（0.01 = +100bp）
 */
export function stressPlanPayment(schedules, bump) {
  return schedules.reduce((sum, s) => {
    const principal = s.totals?.principal ?? s.principal;
    const months = s.months;
    const baseRate = s.annualRate ?? 0;

    if (s.method === 'equal-principal') {
      // 等额本金首月 = 本金均摊 + 首月利息
      const monthly = (principal / months) + principal * ((baseRate + bump) / 12);
      return sum + Math.round(monthly);
    }
    // annuityPayment 返回的是浮点元，必须取整到分 —— 否则界面上会出现
    // 4,803.23512242428842 这种一眼就是 bug 的数字
    return sum + Math.round(annuityPayment(principal, (baseRate + bump) / 12, months));
  }, 0);
}

/**
 * 在给定月供上限下，能承受的最高年利率（二分法）。
 *
 * 月供随利率单调递增，所以二分法是安全且收敛很快的 —— 60 次迭代
 * 对 double 来说已经超过精度极限。
 *
 * @returns {number} 年化利率；连零利率都还不起时返回 0
 */
export function maxRateForPayment({ principal, months, maxPayment }) {
  if (!(principal > 0) || !(months > 0) || !(maxPayment > 0)) return 0;

  // 零利率时的月供就是本金均摊，连这个都超过上限，说明额度本身太高
  const floorPayment = principal / months;
  if (maxPayment <= floorPayment) return 0;

  let lo = 0;
  let hi = 0.3; // 年化 30% 作为上界，实际房贷远达不到
  for (let k = 0; k < 60; k += 1) {
    const mid = (lo + hi) / 2;
    if (annuityPayment(principal, mid / 12, months) > maxPayment) hi = mid;
    else lo = mid;
  }
  return lo;
}

/**
 * 在给定月供上限下，能贷到的最高本金（反向年金）。
 *
 * P = M · ((1+i)^n − 1) / (i · (1+i)^n)
 */
export function maxPrincipalForPayment({ months, annualRate, maxPayment }) {
  if (!(months > 0) || !(maxPayment > 0)) return 0;
  const i = annualRate / 12;
  if (i === 0) return Math.round(maxPayment * months);
  const f = Math.pow(1 + i, months);
  return Math.round((maxPayment * (f - 1)) / (i * f));
}

/**
 * 把评估结果翻译成一句判断，避免只看百分比不知道算不算重。
 */
export function affordabilityVerdict({ dti, withinLimit, maxDti }) {
  if (!withinLimit) return 'over';
  if (dti > maxDti * 0.8) return 'tight';
  if (dti > maxDti * 0.5) return 'moderate';
  return 'comfortable';
}
