/**
 * 金额一律以「分」为单位的整数在内部流转。
 *
 * 为什么不用元 + 浮点：等额本息要跑 360 期，每期都要四舍五入到分。
 * 若用浮点元累加，尾差会在第 300 期之后开始显形，最终出现"本金还完了
 * 还剩 0.01 元"或"最后一期是负数"的情况。整数分 + 末期兜底可以彻底消除。
 */

/** 元 -> 分（四舍五入） */
export function toCents(yuan) {
  return Math.round(Number(yuan) * 100);
}

/** 分 -> 元（数值，用于计算与格式化） */
export function toYuan(cents) {
  return cents / 100;
}

/** 银行惯例：对"分"四舍五入。只处理非负数。 */
export function roundCents(value) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`roundCents 收到非法数值: ${value}`);
  }
  return Math.round(value + Number.EPSILON * Math.sign(value || 1) * 0);
}

/** 千分位金额，例如 1234567 -> "12,345.67" */
export function formatCents(cents, { decimals = 2 } = {}) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const intPart = Math.floor(abs / 100);
  const fracPart = abs % 100;
  const grouped = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : '';
  if (decimals === 0) {
    return sign + grouped;
  }
  return `${sign}${grouped}.${String(fracPart).padStart(2, '0')}`;
}

/** 大额简写，用于卡片摘要：128.4 万 */
export function formatWan(cents) {
  const wan = cents / 100 / 10000;
  if (Math.abs(wan) >= 10000) {
    return `${(wan / 10000).toFixed(2)} 亿`;
  }
  return `${wan.toFixed(2)} 万`;
}

/** 百分比展示：0.035 -> "3.50%" */
export function formatPercent(rate, digits = 2) {
  return `${(rate * 100).toFixed(digits)}%`;
}
