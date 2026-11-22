import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annuityPayment } from '../src/core/amortize.js';
import {
  assessAffordability,
  stressTest,
  maxRateForPayment,
  maxPrincipalForPayment,
  affordabilityVerdict,
  RATE_BUMPS,
} from '../src/core/affordability.js';
import { toCents } from '../src/core/money.js';

test('月供收入比按本笔与合计两种口径分别给出', () => {
  const r = assessAffordability({
    monthlyIncome: toCents(30000),
    monthlyDebt: toCents(3000),
    payment: toCents(12000),
  });
  assert.ok(Math.abs(r.dti - 0.4) < 1e-9, '本笔占 40%');
  assert.ok(Math.abs(r.totalDti - 0.5) < 1e-9, '合计占 50%');
  assert.equal(r.withinLimit, true, '刚好卡在线上算通过');
});

test('超出审批线时 headroom 为负', () => {
  const r = assessAffordability({
    monthlyIncome: toCents(20000),
    monthlyDebt: toCents(4000),
    payment: toCents(9000),
  });
  assert.equal(r.withinLimit, false);
  assert.ok(r.headroom < 0, '已经超了');
  assert.equal(r.headroom, toCents(20000) * 0.5 - toCents(4000) - toCents(9000));
});

test('收入缺失时不编造结论', () => {
  assert.equal(assessAffordability({ monthlyIncome: 0, payment: toCents(5000) }), null);
  assert.equal(assessAffordability({ monthlyIncome: NaN, payment: toCents(5000) }), null);
});

test('压力测试：上浮后月供变高，且上浮越多越高', () => {
  const base = {
    principal: toCents(1_000_000),
    months: 360,
    annualRate: 0.0305,
    payment: annuityPayment(toCents(1_000_000), 0.0305 / 12, 360),
    monthlyIncome: toCents(30000),
  };
  const rows = stressTest(base);
  assert.equal(rows.length, RATE_BUMPS.length);
  assert.ok(rows[0].payment > base.payment);
  assert.ok(rows[1].payment > rows[0].payment);
  assert.ok(rows[0].delta > 0);
  assert.ok(Math.abs(rows[0].annualRate - (0.0305 + 0.005)) < 1e-9);
});

test('最高贷款额度与年金公式互逆', () => {
  const months = 360;
  const annualRate = 0.0305;
  const maxPayment = toCents(8000);

  const principal = maxPrincipalForPayment({ months, annualRate, maxPayment });
  const actual = annuityPayment(principal, annualRate / 12, months);

  // 反推出来的额度，其月供应恰好落在上限附近（容许分位取整误差）
  assert.ok(Math.abs(actual - maxPayment) <= 2, `月供 ${actual} 应接近 ${maxPayment}`);
});

test('最高可承受利率与年金公式互逆', () => {
  const principal = toCents(1_000_000);
  const months = 360;
  const maxPayment = toCents(5000);

  const rate = maxRateForPayment({ principal, months, maxPayment });
  const actual = annuityPayment(principal, rate / 12, months);

  assert.ok(rate > 0, '应该有正的承受区间');
  assert.ok(Math.abs(actual - maxPayment) <= 2, `月供 ${actual} 应接近 ${maxPayment}`);
});

test('月供上限低于本金均摊时，最高利率为零', () => {
  const principal = toCents(1_000_000);
  const months = 360;
  // 零利率月供约 2778 元，这里给 2000，怎么都还不起
  const rate = maxRateForPayment({ principal, months, maxPayment: toCents(2000) });
  assert.equal(rate, 0);
});

test('利率越高，同样月供能贷到的额度越少', () => {
  const months = 360;
  const maxPayment = toCents(8000);
  const low = maxPrincipalForPayment({ months, annualRate: 0.03, maxPayment });
  const high = maxPrincipalForPayment({ months, annualRate: 0.05, maxPayment });
  assert.ok(low > high);
});

test('零利率下额度等于月供乘期数', () => {
  const p = maxPrincipalForPayment({ months: 100, annualRate: 0, maxPayment: toCents(5000) });
  assert.equal(p, toCents(500000));
});

test('结论分档覆盖四档', () => {
  assert.equal(affordabilityVerdict({ dti: 0.9, withinLimit: false, maxDti: 0.5 }), 'over');
  assert.equal(affordabilityVerdict({ dti: 0.45, withinLimit: true, maxDti: 0.5 }), 'tight');
  assert.equal(affordabilityVerdict({ dti: 0.3, withinLimit: true, maxDti: 0.5 }), 'moderate');
  assert.equal(affordabilityVerdict({ dti: 0.15, withinLimit: true, maxDti: 0.5 }), 'comfortable');
});
