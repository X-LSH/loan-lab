/**
 * 利率基准与换算。
 *
 * 数据来源与生效时间集中在此，避免界面上散落魔法数字。
 * 更新时只改这一个文件，并在 UI 的「利率说明」里同步日期。
 */

/** 5 年期以上 LPR，单位：小数 */
export const LPR_5Y = 0.035;
/** 1 年期 LPR */
export const LPR_1Y = 0.03;

export const RATE_BASELINE = Object.freeze({
  effective: '2026-10-20',
  label: '5 年期以上 LPR 3.50%',
  note: '中国人民银行授权全国银行间同业拆借中心公布，2026-11-20 维持不变',
});

/** 住房公积金贷款利率（全国统一） */
export const FUND_RATE = Object.freeze({
  first: { short: 0.021, long: 0.026 },
  second: { short: 0.02525, long: 0.03075 },
});

/** 1 个基点 = 0.01% */
export const BP = 0.0001;

/** 在基准利率上加减基点：applyBp(0.035, -45) => 0.0305 */
export function applyBp(baseRate, bp) {
  return Math.max(baseRate + Number(bp) * BP, 0);
}

/** 反推基点：rateToBp(0.0305, 0.035) => -45 */
export function rateToBp(rate, baseRate) {
  return Math.round((Number(rate) - baseRate) / BP);
}

/** 公积金按套数与期限取利率；6 个月以上按「5 年以上」档 */
export function fundRateFor({ firstHome = true, months = 360 } = {}) {
  const table = firstHome ? FUND_RATE.first : FUND_RATE.second;
  return months <= 60 ? table.short : table.long;
}

/** 组合贷中最常被引用的几个起点，供界面做快捷按钮 */
export const RATE_PRESETS = Object.freeze([
  { id: 'lpr', label: 'LPR 基准', hint: '3.50%', rate: LPR_5Y },
  { id: 'lpr-m30', label: 'LPR −30BP', hint: '3.20%', rate: applyBp(LPR_5Y, -30) },
  { id: 'lpr-m45', label: 'LPR −45BP', hint: '3.05%', rate: applyBp(LPR_5Y, -45) },
  { id: 'lpr-m60', label: 'LPR −60BP', hint: '2.90%', rate: applyBp(LPR_5Y, -60) },
]);

export const FUND_PRESETS = Object.freeze([
  { id: 'fund-first-long', label: '首套 · 5年以上', hint: '2.60%', rate: FUND_RATE.first.long },
  { id: 'fund-first-short', label: '首套 · 5年以下', hint: '2.10%', rate: FUND_RATE.first.short },
  { id: 'fund-second-long', label: '二套 · 5年以上', hint: '3.075%', rate: FUND_RATE.second.long },
  { id: 'fund-second-short', label: '二套 · 5年以下', hint: '2.525%', rate: FUND_RATE.second.short },
]);

/** 解析用户输入的百分数字符串："3.05" / "3.05%" -> 0.0305 */
export function parseRateInput(text) {
  const cleaned = String(text).replace(/[%\s]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return null;
  }
  return value / 100;
}

/* ---------------------------------------------------------------
   LPR 逐年重定价
   合同结构：执行利率 = 重定价日适用的 LPR + 加点（加点整个合同期固定）
   重定价周期为一年，即每 12 期取一次新 LPR。
   --------------------------------------------------------------- */

/**
 * 把 LPR 路径 + 加点 换算成逐年执行利率。
 * @param {number[]} lprPath 每年的 LPR（小数），不足 years 年时用最后一个值延伸
 * @param {number} spreadBp 加点，单位基点（1BP = 0.01%），可为负
 * @param {number} years 总年数
 */
export function ratesFromLprPath(lprPath, spreadBp, years) {
  const base = Array.isArray(lprPath) && lprPath.length > 0 ? lprPath : [LPR_5Y];
  const spread = Number(spreadBp) * BP;
  const out = [];
  for (let y = 0; y < years; y += 1) {
    const lpr = base[Math.min(y, base.length - 1)];
    out.push(Math.max(lpr + spread, 0));
  }
  return out;
}

/**
 * 生成常见的 LPR 走势情景，避免用户一格一格手填。
 * @param {object} opts
 * @param {number} opts.base 起始 LPR
 * @param {number} opts.years 年数
 * @param {number} [opts.stepBp] 每年变动基点，0 = 不变，-25 = 逐年降 25BP
 * @param {number} [opts.toRate] 终点 LPR（优先于 stepBp，用于"线性降到某值"）
 */
export function lprScenario({ base, years, stepBp = 0, toRate }) {
  const out = [];
  for (let y = 0; y < years; y += 1) {
    if (toRate !== undefined && years > 1) {
      const t = y / (years - 1);
      out.push(Math.max(base + (toRate - base) * t, 0));
    } else {
      out.push(Math.max(base + y * stepBp * BP, 0));
    }
  }
  return out;
}

/** 供 UI 展示：把逐年执行利率渲染成一行可读的摘要 */
export function describeRatePath(rates, spreadBp) {
  const first = rates[0] ?? LPR_5Y;
  const last = rates[rates.length - 1] ?? first;
  const spread = Number(spreadBp) * BP;
  if (rates.length <= 1) {
    return `固定 ${(first * 100).toFixed(3)}%${spread ? `（LPR ${((first - spread) * 100).toFixed(2)}% ${spreadBp >= 0 ? '+' : '−'}${Math.abs(spreadBp)}BP）` : ''}`;
  }
  const trend = Math.abs(last - first) < 1e-9 ? '各年相同' : last < first ? '逐年下行' : '逐年上行';
  return `第 1 年 ${(first * 100).toFixed(3)}% → 第 ${rates.length} 年 ${(last * 100).toFixed(3)}% · ${trend}`;
}
