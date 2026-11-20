/**
 * 摊销表生成器。
 *
 * 两种还款方式的会计规则严格按国内银行实务：
 *   1. 每期利息 = 上期末剩余本金 × 月利率，四舍五入到分。
 *   2. 等额本息：月供由年金公式定出并四舍五入，本金 = 月供 − 利息。
 *   3. 等额本金：每期本金 = 总额 / 期数，四舍五入，利息随余额递减。
 *   4. 最后一期永远用「剩余本金」兜底，吸收全部累计尾差。
 *
 * 利率分段（LPR 逐年重定价）：
 *   月利率取 年利率 / 12（名义利率按月计息），与国内房贷合同一致，
 *   不是 ((1+r)^(1/12) − 1) 那种有效年利率换算。
 *   当传入 annualRates 数组时，第 k 年（12 期为一段）使用 annualRates[k-1]，
 *   数组不够长时用最后一个值延伸。等额本息在**每个重定价周期起点**，
 *   用「当时的剩余本金 + 剩余期数 + 新利率」重算月供——既不是从头重算，
 *   也不是把新利率套进原始本金与原始期限，这两者都会算出错误的月供。
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
  const months = Math.round(Number(input.months));
  const method = input.method ?? METHOD.EQUAL_PAYMENT;

  if (!Number.isFinite(principal) || principal <= 0) {
    throw new RangeError('贷款本金必须为正数（单位：分）');
  }
  if (!Number.isFinite(months) || months < 1 || months > 600) {
    throw new RangeError('贷款期数需在 1 ~ 600 期之间');
  }
  if (method !== METHOD.EQUAL_PAYMENT && method !== METHOD.EQUAL_PRINCIPAL) {
    throw new RangeError(`未知还款方式: ${method}`);
  }

  let annualRates;
  if (Array.isArray(input.annualRates) && input.annualRates.length > 0) {
    annualRates = input.annualRates.map((r) => {
      const v = Number(r);
      if (!Number.isFinite(v) || v < 0) {
        throw new RangeError('年利率不能为负');
      }
      return v;
    });
  } else {
    const single = Number(input.annualRate);
    if (!Number.isFinite(single) || single < 0) {
      throw new RangeError('年利率不能为负');
    }
    annualRates = [single];
  }

  return { principal, months, method, annualRates };
}

/** 年金公式：M = P·i·(1+i)^n / ((1+i)^n − 1) */
export function annuityPayment(principal, monthlyRate, months) {
  if (principal <= 0 || months <= 0) return 0;
  if (monthlyRate === 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * monthlyRate * factor) / (factor - 1);
}

/**
 * @param {object} input
 * @param {number} input.principal 贷款本金，单位「分」
 * @param {number[]} [input.annualRates] 按年分段的年利率（小数），与 annualRate 二选一
 * @param {number} [input.annualRate]   固定年利率（小数），等价于 [annualRate]
 * @param {number} input.months 期数
 * @param {string} input.method 还款方式
 */
export function buildSchedule(input) {
  const { principal, months, method, annualRates } = normalize(input);
  const totalYears = Math.ceil(months / 12);

  const rows = [];
  const paymentSteps = [];
  const rateChanges = [];
  let balance = principal;

  const rateOf = (yearIndex) => annualRates[Math.min(yearIndex, annualRates.length - 1)];

  if (method === METHOD.EQUAL_PAYMENT) {
    // 只有利率真正变化时才重算月供。若每个周期起点都重算，
    // 固定利率下也会因逐期四舍五入累积得到略微不同的月供（差 1 分），
    // 破坏「月供恒定」这条合同约定。
    let activeMonthly = null;
    let activeRate = NaN;

    for (let year = 0; year < totalYears; year += 1) {
      const rate = rateOf(year);
      const i = rate / 12;
      const periodsLeft = months - year * 12;
      if (periodsLeft <= 0 || balance <= 0) break;

      if (activeMonthly === null || rate !== activeRate) {
        // 重定价：按「此刻的剩余本金 + 剩余期数」重算月供。
        // fixedMonthly 用于「部分提前还款后缩期」——此时月供是合同约定的常数，
        // 不能让年金公式按新期数重算，否则月供会变，违背缩期的约定。
        activeMonthly = input.fixedMonthly ?? Math.round(annuityPayment(balance, i, periodsLeft));
        activeRate = rate;
        paymentSteps.push({ period: year * 12 + 1, rate, monthly: activeMonthly });
        rateChanges.push({ period: year * 12 + 1, rate, monthly: activeMonthly });
      }

      for (let p = 0; p < 12; p += 1) {
        const k = year * 12 + p + 1;
        if (k > months) break;

        const interest = Math.round(balance * i);
        const isLast = k === months;

        // 月供恒定是写进合同的，只有最后一期才吸收累计尾差。
        // 若在这里对本金做 min() 截断，会因逐期四舍五入提前 1 分触发，
        // 导致月供出现 4490.44 / 4490.45 两种值，违背合同约定。
        let principalPart;
        let payment;
        if (isLast) {
          principalPart = balance;
          payment = principalPart + interest;
        } else {
          payment = activeMonthly;
          principalPart = payment - interest;
          if (principalPart <= 0) {
            throw new RangeError('月供不足以覆盖当期利息，贷款永不结清；请检查利率与期限');
          }
          if (principalPart > balance) {
            // 年金公式下理论上不会发生；真发生说明摊销已提前走完
            principalPart = balance;
            payment = principalPart + interest;
          }
        }

        balance = Math.max(balance - principalPart, 0);
        rows.push({ period: k, payment, principal: principalPart, interest, balance, annualRate: rate });
      }
    }
  } else {
    const basePart = Math.round(principal / months);
    for (let year = 0; year < totalYears; year += 1) {
      const rate = rateOf(year);
      const i = rate / 12;

      for (let p = 0; p < 12; p += 1) {
        const k = year * 12 + p + 1;
        if (k > months) break;

        const interest = Math.round(balance * i);
        const isLast = k === months;
        const principalPart = isLast ? balance : Math.min(basePart, balance);
        balance = Math.max(balance - principalPart, 0);
        rows.push({
          period: k,
          payment: principalPart + interest,
          principal: principalPart,
          interest,
          balance,
          annualRate: rate,
        });
      }
    }

    // 等额本金的月供每期递减，取每段首期作为该段的代表值（供画图）
    // 但「利率变化点」只记录真正发生重定价的年份，两者是不同的概念
    let activeRateForChange = NaN;
    for (let year = 0; year < totalYears; year += 1) {
      const k0 = year * 12 + 1;
      if (k0 > months) break;
      const row = rows[k0 - 1];
      const rate = rateOf(year);
      if (row) paymentSteps.push({ period: k0, rate, monthly: row.payment });
      if (rate !== activeRateForChange) {
        if (row) rateChanges.push({ period: k0, rate, monthly: row.payment });
        activeRateForChange = rate;
      }
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
    annualRates,
    annualRate: annualRates[0],
    months,
    method,
    rows,
    paymentSteps,
    /** 利率真正发生变化的时点，与 paymentSteps（月供档位）是两个概念 */
    rateChanges,
    totals,
    summary: {
      firstPayment: rows[0].payment,
      lastPayment: rows[rows.length - 1].payment,
      maxPayment: Math.max(...payments),
      minPayment: Math.min(...payments),
      totalInterest: totals.interest,
      totalPayment: totals.payment,
      interestRatio: totals.interest / principal,
      paymentSteps,
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
        ? {
            label: s.label,
            payment: row.payment,
            principal: row.principal,
            interest: row.interest,
            balance: row.balance,
            annualRate: row.annualRate,
          }
        : { label: s.label, payment: 0, principal: 0, interest: 0, balance: 0, annualRate: 0 };
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
