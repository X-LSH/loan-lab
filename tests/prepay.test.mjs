import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSchedule, METHOD, annuityPayment } from '../src/core/amortize.js';
import { buildPrepayPlan, comparePrepay, PREPAY_STRATEGY } from '../src/core/prepay.js';

const P = 100000000; // 100 万 = 1e8 分

const baseSchedule = () =>
  buildSchedule({ principal: P, annualRate: 0.035, months: 360, method: METHOD.EQUAL_PAYMENT });

test('缩期：月供不变，期数减少，剩余本金被摊完', () => {
  const sched = baseSchedule();
  const origMonthly = sched.rows[0].payment;

  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000, // 30 万
    strategy: PREPAY_STRATEGY.SHORTEN,
  });

  assert.equal(plan.newMonthly, origMonthly, '缩期月供应与原月供一致');
  assert.ok(plan.newTotalMonths < 360, '期数应减少');
  assert.ok(plan.monthsSaved > 0, '应有节省的期数');
  assert.equal(plan.rows.at(-1).balance, 0, '末期剩余本金归零');
  assert.ok(plan.totals.interest < sched.totals.interest, '总利息应下降');
});

test('降月供：期数不变，月供下降', () => {
  const sched = baseSchedule();
  const origMonthly = sched.rows[0].payment;

  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.REDUCE,
  });

  assert.equal(plan.newTotalMonths, 360, '期数不变');
  assert.ok(plan.newMonthly < origMonthly, '月供应下降');
  assert.equal(plan.rows.at(-1).balance, 0);
});

test('恒等式：总支出 = 本金 + 已付利息 + 违约金', () => {
  const sched = baseSchedule();
  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
    penaltyRate: 0.01,
    penaltyFreeMonths: 0,
  });

  assert.equal(
    plan.totals.payment,
    plan.totals.principal + plan.totals.interest + plan.totals.penalty,
    '支出恒等式',
  );
});

test('违约金：免罚期内不收，免罚期后按剩余本金计收', () => {
  const sched = baseSchedule();

  const free = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 12,
    prepayAmount: 20000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
    penaltyRate: 0.01,
    penaltyFreeMonths: 24,
  });
  assert.equal(free.penalty, 0, '免罚期内违约金为 0');

  const charged = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 20000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
    penaltyRate: 0.01,
    penaltyFreeMonths: 24,
  });
  assert.equal(
    charged.penalty,
    Math.round(charged.beforeRemain * 0.01),
    '免罚期后按剩余本金计收',
  );
});

test('全部还清退化为一次性结清', () => {
  const sched = baseSchedule();
  const remain = sched.rows[119].balance;

  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: remain + 100000, // 超过剩余本金
    strategy: PREPAY_STRATEGY.SHORTEN,
    penaltyRate: 0.01,
    penaltyFreeMonths: 0,
  });

  assert.equal(plan.afterRemain, 0, '提前还款后余额归零');
  assert.equal(plan.newTotalMonths, 120, '就还到第 120 期为止');
  assert.equal(plan.rows.length, 120);
  // 前 120 期是原摊销表，末期余额是「提前还款前」的余额，不是 0
  assert.equal(plan.rows.at(-1).balance, plan.beforeRemain);
});

test('缩期的期数反解正确：新表月供保持原月供，末期才吸收尾差', () => {
  const sched = baseSchedule();
  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
  });

  // 缩期的核心约定：月供不变，只缩短期数。逐期检查，末期除外。
  for (let k = 120; k < plan.rows.length - 1; k += 1) {
    assert.equal(plan.rows[k].payment, plan.newMonthly, `第 ${k + 1} 期月供应保持 ${plan.newMonthly}`);
  }
  // 末期可以略低（吸收四舍五入尾差），但不能高于月供
  assert.ok(plan.rows.at(-1).payment <= plan.newMonthly, '末期月供不得高于固定月供');
});

test('等额本金：缩期与降月供都能算，且末期归零', () => {
  const sched = buildSchedule({
    principal: P,
    annualRate: 0.035,
    months: 360,
    method: METHOD.EQUAL_PRINCIPAL,
  });

  const shorten = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
  });
  assert.equal(shorten.rows.at(-1).balance, 0);
  assert.ok(shorten.newTotalMonths < 360);

  const reduce = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.REDUCE,
  });
  assert.equal(reduce.newTotalMonths, 360);
  assert.equal(reduce.rows.at(-1).balance, 0);
});

test('comparePrepay 给出节省口径', () => {
  const sched = baseSchedule();
  const plan = buildPrepayPlan({
    schedule: sched,
    prepayMonth: 120,
    prepayAmount: 30000000,
    strategy: PREPAY_STRATEGY.SHORTEN,
    penaltyRate: 0.01,
    penaltyFreeMonths: 0,
  });

  const cmp = comparePrepay(sched, plan);
  assert.equal(cmp.originalInterest, sched.totals.interest);
  assert.equal(cmp.newInterest, plan.totals.interest);
  assert.equal(
    cmp.savedInterest,
    sched.totals.interest - plan.totals.interest - plan.penalty,
    '节省 = 原利息 − 新利息 − 违约金',
  );
  assert.ok(cmp.savedInterest > 0);
  assert.equal(cmp.savedMonths, 360 - plan.newTotalMonths);
});

test('边界：提前还款期数越界应报错', () => {
  const sched = baseSchedule();
  assert.throws(
    () => buildPrepayPlan({ schedule: sched, prepayMonth: 360, prepayAmount: 1000000 }),
    RangeError,
  );
  assert.throws(
    () => buildPrepayPlan({ schedule: sched, prepayMonth: 0, prepayAmount: 1000000 }),
    RangeError,
  );
});
