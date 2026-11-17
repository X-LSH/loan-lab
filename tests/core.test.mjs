import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSchedule, mergeSchedules, annuityPayment, METHOD } from '../src/core/amortize.js';
import { payoffTimeline, settleAtMonth } from '../src/core/payoff.js';
import { buildPlan, compareMethods, aggregateByYear } from '../src/core/plan.js';
import { applyBp, rateToBp, fundRateFor, parseRateInput, LPR_5Y, FUND_RATE } from '../src/core/rates.js';
import { toCents, formatCents, formatWan, formatPercent } from '../src/core/money.js';

/** 基准案例：100 万元、3.5%、30 年 */
const BASE = { principal: toCents(1_000_000), annualRate: 0.035, months: 360 };

function assertNearlyEqual(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: 实际 ${actual}，期望 ${expected}（容差 ${tolerance}）`,
  );
}

// ---------------------------------------------------------------- 摊销表

test('等额本息：月供与公开基准表一致（100万/3.5%/30年 = 4490.45 元）', () => {
  const s = buildSchedule({ ...BASE, method: METHOD.EQUAL_PAYMENT });
  assert.equal(s.rows[0].payment, 449045);
  assert.equal(s.summary.firstPayment, 449045);
});

test('等额本息：前 n-1 期月供恒定，末期吸收尾差', () => {
  const s = buildSchedule({ ...BASE, method: METHOD.EQUAL_PAYMENT });
  const fixed = s.rows.slice(0, -1).map((r) => r.payment);
  assert.equal(new Set(fixed).size, 1, '除末期外月供应完全相同');
  // 360 期各把利息四舍五入到分，累计尾差实测 1.93 元，全部由末期吸收。
  // 上界设 5 元：足以发现真正的算法错误，又能容纳合理的舍入残差。
  assert.ok(Math.abs(s.rows.at(-1).payment - 449045) < 500, '末期偏差应在 5 元以内');
});

test('等额本息：总利息与公开基准一致（约 61.66 万元）', () => {
  const s = buildSchedule({ ...BASE, method: METHOD.EQUAL_PAYMENT });
  assertNearlyEqual(s.totals.interest, toCents(616_600), toCents(500), '总利息');
  assertNearlyEqual(s.totals.payment, toCents(1_616_600), toCents(500), '总还款');
});

test('等额本金：首月月供 5694.45 元，逐月递减', () => {
  const s = buildSchedule({ ...BASE, method: METHOD.EQUAL_PRINCIPAL });
  assert.equal(s.summary.firstPayment, 569445);
  assert.equal(s.rows[0].principal, 277778);
  for (let k = 1; k < s.rows.length; k += 1) {
    assert.ok(s.rows[k].payment < s.rows[k - 1].payment, '月供应单调递减');
  }
});

test('两种方式本金合计都精确等于贷款额（尾差被消化）', () => {
  for (const method of [METHOD.EQUAL_PAYMENT, METHOD.EQUAL_PRINCIPAL]) {
    const s = buildSchedule({ ...BASE, method });
    assert.equal(s.totals.principal, BASE.principal, `${method} 本金合计`);
    assert.equal(s.rows.at(-1).balance, 0, `${method} 末期余额归零`);
  }
});

test('等额本金总利息低于等额本息', () => {
  const ep = buildSchedule({ ...BASE, method: METHOD.EQUAL_PAYMENT });
  const epr = buildSchedule({ ...BASE, method: METHOD.EQUAL_PRINCIPAL });
  assert.ok(epr.summary.totalInterest < ep.summary.totalInterest);
});

test('总还款恒等于本金加利息', () => {
  for (const method of [METHOD.EQUAL_PAYMENT, METHOD.EQUAL_PRINCIPAL]) {
    const s = buildSchedule({ ...BASE, method });
    assert.equal(s.totals.payment, s.totals.principal + s.totals.interest);
  }
});

test('零利率退化为等额本金，两种方式总利息为 0', () => {
  for (const method of [METHOD.EQUAL_PAYMENT, METHOD.EQUAL_PRINCIPAL]) {
    const s = buildSchedule({ principal: toCents(120_000), annualRate: 0, months: 12, method });
    assert.equal(s.summary.totalInterest, 0);
    assert.equal(s.totals.principal, toCents(120_000));
    assert.equal(s.rows[0].payment, 1000000, '12 万分 12 期，每期 1 万元');
  }
});

test('单期贷款可直接结清', () => {
  const s = buildSchedule({ principal: toCents(10_000), annualRate: 0.036, months: 1, method: METHOD.EQUAL_PAYMENT });
  assert.equal(s.rows.length, 1);
  assert.equal(s.totals.principal, toCents(10_000));
  assert.equal(s.rows[0].interest, 3000, '10000 元 × 3.6% / 12 = 30 元');
});

test('非法输入被拒绝', () => {
  assert.throws(() => buildSchedule({ principal: 0, annualRate: 0.03, months: 12 }), RangeError);
  assert.throws(() => buildSchedule({ principal: 100, annualRate: -0.01, months: 12 }), RangeError);
  assert.throws(() => buildSchedule({ principal: 100, annualRate: 0.03, months: 0 }), RangeError);
  assert.throws(() => buildSchedule({ principal: 100, annualRate: 0.03, months: 12, method: 'x' }), RangeError);
});

test('年金公式在零利率时返回本金均值', () => {
  assert.equal(annuityPayment(120000, 0, 12), 10000);
});

// ---------------------------------------------------------------- 组合贷

test('组合贷：合并表月供等于两笔之和', () => {
  const plan = buildPlan({
    months: 360,
    loans: [
      { label: '公积金', principal: toCents(600_000), annualRate: 0.026, method: METHOD.EQUAL_PAYMENT },
      { label: '商业贷款', principal: toCents(400_000), annualRate: 0.0305, method: METHOD.EQUAL_PAYMENT },
    ],
  });
  assert.equal(plan.merged.rows[0].payment, plan.schedules[0].rows[0].payment + plan.schedules[1].rows[0].payment);
  assert.equal(plan.merged.totals.principal, toCents(1_000_000));
  assert.equal(plan.merged.rows.length, 360);
  assert.equal(plan.weight.length, 2);
  assertNearlyEqual(plan.weight[0].share, 0.6, 1e-9, '公积金额度占比');
});

test('组合贷：两笔可各用不同还款方式', () => {
  const plan = buildPlan({
    months: 240,
    loans: [
      { label: '公积金', principal: toCents(500_000), annualRate: 0.026, method: METHOD.EQUAL_PRINCIPAL },
      { label: '商业贷款', principal: toCents(500_000), annualRate: 0.0305, method: METHOD.EQUAL_PAYMENT },
    ],
  });
  assert.equal(plan.schedules[0].method, METHOD.EQUAL_PRINCIPAL);
  assert.equal(plan.schedules[1].method, METHOD.EQUAL_PAYMENT);
  assert.ok(plan.merged.rows[1].payment < plan.merged.rows[0].payment, '合计月供应逐月下降（含等额本金）');
});

test('组合贷：期限不一致时，先到期的一笔后续计 0，不补造数据', () => {
  const long = buildSchedule({ principal: 100000, annualRate: 0.03, months: 24, method: METHOD.EQUAL_PAYMENT });
  const short = buildSchedule({ principal: 100000, annualRate: 0.03, months: 12, method: METHOD.EQUAL_PAYMENT });
  const merged = mergeSchedules([long, short]);
  assert.equal(merged.rows.length, 24);
  assert.equal(merged.rows[12].parts[1].payment, 0, '第 13 期起短贷为 0');
  assert.ok(merged.rows[12].payment > 0, '长贷仍在还款');
  assert.equal(merged.rows.at(-1).balance, 0);
});

// ---------------------------------------------------------------- 提前结清

test('结清恒等式：总支出 = 本金 + 已付利息 + 违约金', () => {
  const plan = buildPlan({
    months: 360,
    loans: [
      { label: '公积金', principal: toCents(600_000), annualRate: 0.026, method: METHOD.EQUAL_PAYMENT },
      { label: '商业贷款', principal: toCents(400_000), annualRate: 0.0305, method: METHOD.EQUAL_PAYMENT },
    ],
    penaltyRate: 0.01,
    penaltyFreeMonths: 12,
  });
  for (const p of plan.payoff.points) {
    assert.equal(
      p.totalOutlay,
      plan.payoff.principal + p.interestPaid + p.penalty,
      `第 ${p.month} 期结清的支出恒等式`,
    );
    assert.equal(
      p.savedInterest,
      plan.payoff.totalInterest - p.interestPaid - p.penalty,
      `第 ${p.month} 期结清的节省恒等式`,
    );
  }
});

test('结清：第 0 期只需还本金，末期等于原计划总额', () => {
  const plan = buildPlan({
    months: 360,
    loans: [{ label: '商贷', principal: toCents(1_000_000), annualRate: 0.0305, method: METHOD.EQUAL_PAYMENT }],
    penaltyRate: 0,
  });
  const origin = plan.payoff.points[0];
  assert.equal(origin.totalOutlay, toCents(1_000_000));
  assert.equal(origin.savedInterest, plan.payoff.totalInterest);

  const final = plan.payoff.points.at(-1);
  assert.equal(final.month, 360);
  assert.equal(final.totalOutlay, plan.payoff.originalTotal);
  assert.equal(final.savedInterest, 0);
});

test('结清：越早结清总支出越低（单调性）', () => {
  const plan = buildPlan({
    months: 360,
    loans: [{ label: '商贷', principal: toCents(1_000_000), annualRate: 0.0305, method: METHOD.EQUAL_PAYMENT }],
    penaltyRate: 0,
  });
  const outs = plan.payoff.points.map((p) => p.totalOutlay);
  for (let k = 1; k < outs.length; k += 1) {
    assert.ok(outs[k] >= outs[k - 1], `第 ${k} 个采样点支出不应低于前一档`);
  }
});

test('违约金：免罚期前的结清点收费，之后免收', () => {
  const plan = buildPlan({
    months: 120,
    loans: [{ label: '商贷', principal: toCents(500_000), annualRate: 0.03, method: METHOD.EQUAL_PAYMENT }],
    penaltyRate: 0.02,
    penaltyFreeMonths: 36,
  });
  const at12 = plan.payoff.points.find((p) => p.month === 12);
  const at36 = plan.payoff.points.find((p) => p.month === 36);
  assert.ok(at12.penalty > 0, '第 12 期应有违约金');
  assert.equal(at12.penalty, Math.round(at12.balance * 0.02));
  assert.equal(at36.penalty, 0, '满 36 期后免收');
});

test('违约金率为 0 时任何时点都不收费', () => {
  const plan = buildPlan({
    months: 60,
    loans: [{ label: '商贷', principal: toCents(300_000), annualRate: 0.03, method: METHOD.EQUAL_PRINCIPAL }],
    penaltyRate: 0,
    penaltyFreeMonths: 999,
  });
  assert.ok(plan.payoff.points.every((p) => p.penalty === 0));
});

test('settleAtMonth 与时间线同月采样结果一致', () => {
  const plan = buildPlan({
    months: 240,
    loans: [{ label: '商贷', principal: toCents(800_000), annualRate: 0.031, method: METHOD.EQUAL_PAYMENT }],
    penaltyRate: 0.01,
    penaltyFreeMonths: 12,
  });
  for (const point of plan.payoff.points) {
    const single = settleAtMonth(plan.merged, point.month, { penaltyRate: 0.01, penaltyFreeMonths: 12 });
    assert.equal(single.totalOutlay, point.totalOutlay, `第 ${point.month} 期一致性`);
    assert.equal(single.settleCash, point.settleCash);
  }
});

test('settleAtMonth 越界时钳制到合法区间', () => {
  const plan = buildPlan({
    months: 60,
    loans: [{ label: '商贷', principal: toCents(300_000), annualRate: 0.03, method: METHOD.EQUAL_PAYMENT }],
  });
  assert.equal(settleAtMonth(plan.merged, 999, {}).month, 60);
  assert.equal(settleAtMonth(plan.merged, -5, {}).month, 0);
});

// ---------------------------------------------------------------- 方案对比

test('方案对比：等额本金节省的利息为正，且首月月供更高', () => {
  const cmp = compareMethods({
    months: 360,
    loans: [{ label: '商贷', principal: toCents(1_000_000), annualRate: 0.035, method: METHOD.EQUAL_PAYMENT }],
  });
  assert.ok(cmp.delta.interestSaved > 0);
  assert.ok(cmp.delta.firstPaymentDiff > 0);
  assert.equal(cmp.equalPayment.firstPayment, 449045);
});

test('按年聚合：30 年的各年本金合计等于贷款额', () => {
  const s = buildSchedule({ ...BASE, method: METHOD.EQUAL_PAYMENT });
  const years = aggregateByYear(s);
  assert.equal(years.length, 30);
  const sum = years.reduce((acc, y) => acc + y.principal, 0);
  assert.equal(sum, BASE.principal);
  assert.ok(years[0].interest > years[29].interest, '利息逐年下降');
});

// ---------------------------------------------------------------- 利率工具

test('LPR 加减基点换算正确且可逆', () => {
  assertNearlyEqual(applyBp(LPR_5Y, -45), 0.0305, 1e-9, 'LPR−45BP');
  assertNearlyEqual(applyBp(LPR_5Y, -60), 0.029, 1e-9, 'LPR−60BP');
  assert.equal(rateToBp(0.0305, LPR_5Y), -45);
  assert.equal(rateToBp(LPR_5Y, LPR_5Y), 0);
});

test('公积金利率按套数与期限分档', () => {
  assert.equal(fundRateFor({ firstHome: true, months: 360 }), FUND_RATE.first.long);
  assert.equal(fundRateFor({ firstHome: true, months: 60 }), FUND_RATE.first.short);
  assert.equal(fundRateFor({ firstHome: false, months: 360 }), FUND_RATE.second.long);
  assert.equal(fundRateFor({ firstHome: false, months: 24 }), FUND_RATE.second.short);
});

test('百分数输入解析', () => {
  assertNearlyEqual(parseRateInput('3.05'), 0.0305, 1e-9, '裸数字');
  assertNearlyEqual(parseRateInput('3.05%'), 0.0305, 1e-9, '带百分号');
  assertNearlyEqual(parseRateInput(' 2.6 '), 0.026, 1e-9, '带空格');
  assert.equal(parseRateInput('abc'), null);
  assert.equal(parseRateInput('-1'), null);
});

// ---------------------------------------------------------------- 金额格式化

test('金额格式化与解析', () => {
  assert.equal(toCents(4490.45), 449045);
  assert.equal(formatCents(449045), '4,490.45');
  assert.equal(formatCents(100000000), '1,000,000.00');
  assert.equal(formatCents(123456789), '1,234,567.89');
  assert.equal(formatWan(100000000), '100.00 万');
  assert.equal(formatPercent(0.0305), '3.05%');
});

test('构造层面：组合贷本金分配之和等于总贷款', () => {
  const plan = buildPlan({
    months: 300,
    loans: [
      { label: '公积金', principal: toCents(700_000), annualRate: 0.026, method: METHOD.EQUAL_PAYMENT },
      { label: '商业贷款', principal: toCents(500_000), annualRate: 0.0305, method: METHOD.EQUAL_PRINCIPAL },
    ],
  });
  assert.equal(plan.merged.totals.principal, toCents(1_200_000));
  assert.equal(plan.schedules[0].rows.length, 300);
  assert.equal(plan.schedules[1].rows.length, 300);
});
