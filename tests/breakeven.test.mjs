import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, METHOD } from '../src/core/amortize.js';
import { compareAtMonth, settleDiffCurve, tradeoff, bestSettlePoint } from '../src/core/breakeven.js';
import { toCents } from '../src/core/money.js';

function makeSchedules(overrides = {}) {
  const base = {
    principal: toCents(1_000_000),
    months: 360,
    annualRates: [0.0305],
    ...overrides,
  };
  return {
    a: buildSchedule({ ...base, method: METHOD.EQUAL_PAYMENT }),
    b: buildSchedule({ ...base, method: METHOD.EQUAL_PRINCIPAL }),
  };
}

test('第 0 期结清：两者都等于本金，没有差额', () => {
  const { a, b } = makeSchedules();
  const c = compareAtMonth(a, b, 0);
  assert.equal(c.diff, 0);
  assert.equal(c.a.totalOutlay, toCents(1_000_000));
  assert.equal(c.b.totalOutlay, toCents(1_000_000));
  assert.equal(c.cheaper, 'TIE');
});

test('还到期满：差额等于两者的总利息差', () => {
  const { a, b } = makeSchedules();
  const c = compareAtMonth(a, b, 360);
  const expected = a.totals.interest - b.totals.interest;
  assert.equal(c.diff, expected);
  assert.ok(c.diff > 0, '等额本金的总利息更少');
  assert.equal(c.cheaper, 'B');
});

test('总支出等于已付月供加结清现金', () => {
  const { a, b } = makeSchedules();
  for (const month of [0, 12, 60, 120, 240, 360]) {
    const c = compareAtMonth(a, b, month);
    assert.equal(c.a.totalOutlay, c.a.paid + c.a.settleCash, `A 在 ${month} 期`);
    assert.equal(c.b.totalOutlay, c.b.paid + c.b.settleCash, `B 在 ${month} 期`);
  }
});

test('差额随持有时间单调不减', () => {
  const { a, b } = makeSchedules();
  const curve = settleDiffCurve(a, b);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(
      curve[i].diff >= curve[i - 1].diff,
      `第 ${curve[i].month} 期的差额不应小于上一期`,
    );
  }
});

test('曲线首点是 0，终点是总利息差', () => {
  const { a, b } = makeSchedules();
  const curve = settleDiffCurve(a, b);
  assert.equal(curve[0].month, 0);
  assert.equal(curve[0].diff, 0);
  assert.equal(curve.at(-1).month, 360);
  assert.equal(curve.at(-1).diff, a.totals.interest - b.totals.interest);
});

test('采样步长不整除期数时，曲线仍以终点收尾', () => {
  const { a, b } = makeSchedules({ months: 350 });
  const curve = settleDiffCurve(a, b, { step: 12 });
  assert.equal(curve.at(-1).month, 350);
});

test('权衡摘要：省息与前期多付都为正，且多付期数短于全周期', () => {
  const { a, b } = makeSchedules();
  const t = tradeoff(a, b);
  assert.ok(t.savedInterest > 0, '等额本金省利息');
  assert.ok(t.extraCash > 0, '前期要垫更多现金');
  assert.ok(t.peakGap > 0, '首月月供更高');
  assert.ok(t.extraMonths > 0 && t.extraMonths < 360, '多付只发生在前期');
});

test('省息额最大的时点就是还到期满', () => {
  const { a, b } = makeSchedules();
  const curve = settleDiffCurve(a, b);
  const best = bestSettlePoint(curve);
  assert.equal(best.month, 360);
});

test('零利率下两者总支出相同（利息都为零）', () => {
  const { a, b } = makeSchedules({ annualRates: [0] });
  const c = compareAtMonth(a, b, 360);
  assert.equal(c.diff, 0);
  assert.equal(c.cheaper, 'TIE');
});

test('违约金只在前 penaltyFreeMonths 期内收取', () => {
  const { a, b } = makeSchedules();
  const opts = { penaltyRate: 0.01, penaltyFreeMonths: 12 };

  const early = compareAtMonth(a, b, 6, opts);
  assert.ok(early.a.penalty > 0, '第 6 期结清要付违约金');

  const late = compareAtMonth(a, b, 24, opts);
  assert.equal(late.a.penalty, 0, '第 24 期已过免罚期');
});
