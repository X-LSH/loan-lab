/**
 * 摊销表生成器。
 *
 * 两种还款方式的会计规则严格按国内银行实务：
 *   1. 每期利息 = 上期末剩余本金 × 月利率，四舍五入到分。
 *   2. 等额本息：月供由年金公式定出并四舍五入，本金 = 月供 − 利息。
 *   3. 等额本金：每期本金 = 总额 / 期数，四舍五入，利息随余额递减。
 *   4. 最后一期永远用「剩余本金」兜底，吸收全部累计尾差。
 *
 * 月利率取 年利率 / 12（名义利率按月计息），这与国内房贷合同一致，
 * 不是 ((1+r)^(1/12) − 1) 那种有效年利率换算。
 */

export const METHOD = Object.freeze({
  EQUAL_PAYMENT: 'equal-payment',
  EQUAL_PRINCIPAL: 'equal-principal',
});

export const METHOD_LABEL = Object.freeze({
  [METHOD.EQUAL_PAYMENT]: '等额本息',
  [METHOD.EQUAL_PRINCIPAL]: '等额本金',
});

function normalize(input) {
  const principal = Math.round(Number(input.principal));
  const annualRate = Number(input.annualRate);
  const months = Math.round(Number(input.months));
  const method = input.method ?? METHOD.EQUAL_PAYMENT;

  if (!Number.isFinite(principal) || principal <= 0) {
    throw new RangeError('贷款本金必须为正数（单位：分）');
  }
  if (!Number.isFinite(annualRate) || annualRate < 0) {
    throw new RangeError('年利率不能为负');
  }
  if (!Number.isFinite(months) || months < 1 || months > 600) {
    throw new RangeError('贷款期数需在 1 ~ 600 期之间');
  }
  if (method !== METHOD.EQUAL_PAYMENT && method !== METHOD.EQUAL_PRINCIPAL) {
    throw new RangeError(`未知还款方式: ${method}`);
  }
  return { principal, annualRate, months, method };
}

/** 年金公式：M = P·i·(1+i)^n / ((1+i)^n − 1) */
export function annuityPayment(principal, monthlyRate, months) {
  if (monthlyRate === 0) {
    return principal / months;
  }
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

/**
 * @param {{principal:number, annualRate:number, months:number, method:string, label?:string}} input
 *        principal 单位为「分」，annualRate 为小数（0.035 表示 3.5%）
 */
export function buildSchedule(input) {
  const { principal, annualRate, months, method } = normalize(input);
  const i = annualRate / 12;

  const rows = [];
  let balance = principal;

  if (method === METHOD.EQUAL_PAYMENT) {
    const monthly = Math.round(annuityPayment(principal, i, months));
    for (let k = 1; k <= months; k += 1) {
      const interest = Math.round(balance * i);
      const principalPart = k === months ? balance : Math.min(monthly - interest, balance);
      if (k < months && principalPart <= 0) {
        throw new RangeError('月供不足以覆盖当期利息，贷款永不结清；请检查利率与期限');
      }
      // 付款额恒等于本金 + 利息，避免被 min() 兜底后与真实本金变动脱节。
      const payment = principalPart + interest;
      balance = Math.max(balance - principalPart, 0);
      rows.push({ period: k, payment, principal: principalPart, interest, balance });
    }
  } else {
    const basePart = Math.round(principal / months);
    for (let k = 1; k <= months; k += 1) {
      const interest = Math.round(balance * i);
      const principalPart = k === months ? balance : Math.min(basePart, balance);
      balance = Math.max(balance - principalPart, 0);
      rows.push({ period: k, payment: principalPart + interest, principal: principalPart, interest, balance });
    }
  }

  const totals = rows.reduce(
    (acc, r) => {
      acc.payment += r.payment;
      acc.principal += r.principal;
      acc.interest += r.interest;
      return acc;
    },
    { payment: 0, principal: 0, interest: 0 },
  );

  // 硬约束：本金合计必须等于贷款额，否则说明尾差逻辑被破坏。
  if (totals.principal !== principal) {
    throw new Error(`本金合计校验失败: ${totals.principal} != ${principal}`);
  }

  const payments = rows.map((r) => r.payment);
  return {
    label: input.label ?? '',
    principal,
    annualRate,
    months,
    method,
    rows,
    totals,
    summary: {
      firstPayment: rows[0].payment,
      lastPayment: rows[rows.length - 1].payment,
      maxPayment: Math.max(...payments),
      minPayment: Math.min(...payments),
      totalInterest: totals.interest,
      totalPayment: totals.payment,
      interestRatio: totals.interest / principal,
    },
  };
}

/**
 * 把多笔贷款（组合贷）合并成一张月度现金流表。
 * 期限不同时，先到期的那笔后续各期按 0 计，不补造数据。
 */
export function mergeSchedules(list) {
  const valid = list.filter(Boolean);
  if (valid.length === 0) {
    throw new RangeError('没有可合并的贷款');
  }
  const maxLen = Math.max(...valid.map((s) => s.rows.length));
  const rows = [];

  for (let k = 1; k <= maxLen; k += 1) {
    const parts = valid.map((s) => {
      const row = s.rows[k - 1];
      return row
        ? { label: s.label, payment: row.payment, principal: row.principal, interest: row.interest, balance: row.balance }
        : { label: s.label, payment: 0, principal: 0, interest: 0, balance: 0 };
    });
    const total = parts.reduce(
      (acc, p) => {
        acc.payment += p.payment;
        acc.principal += p.principal;
        acc.interest += p.interest;
        acc.balance += p.balance;
        return acc;
      },
      { payment: 0, principal: 0, interest: 0, balance: 0 },
    );
    rows.push({ period: k, ...total, parts });
  }

  const totals = rows.reduce(
    (acc, r) => {
      acc.payment += r.payment;
      acc.principal += r.principal;
      acc.interest += r.interest;
      return acc;
    },
    { payment: 0, principal: 0, interest: 0 },
  );

  const payments = rows.map((r) => r.payment);
  return {
    label: '合计',
    rows,
    totals,
    months: maxLen,
    summary: {
      firstPayment: rows[0].payment,
      lastPayment: rows[rows.length - 1].payment,
      maxPayment: Math.max(...payments),
      minPayment: Math.min(...payments),
      totalInterest: totals.interest,
      totalPayment: totals.payment,
      interestRatio: totals.interest / totals.principal,
    },
  };
}
