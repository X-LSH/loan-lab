import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FUND_CITIES, DEFAULT_CITY_ID, getCity,
  resolveQuota, roundQuota, describeQuota,
} from '../src/core/quota.js';

test('内置城市齐全，青岛为默认', () => {
  assert.ok(FUND_CITIES.length >= 6);
  assert.equal(DEFAULT_CITY_ID, 'qingdao');
  assert.equal(getCity('qingdao').name, '青岛');
  // 找不到时回落到第一个，不抛异常
  assert.equal(getCity('不存在的城市').name, '青岛');
});

test('青岛基础上限：双缴存 130 万 / 单缴存 90 万（2026-04-20 新政）', () => {
  const couple = resolveQuota({ cityId: 'qingdao', isCouple: true });
  const single = resolveQuota({ cityId: 'qingdao', isCouple: false });
  assert.equal(couple.final, 130);
  assert.equal(single.final, 90);
  assert.equal(couple.city.effective, '2026-04-20');
});

test('青岛多子女上浮 30%：双缴存 169 万 / 单缴存 117 万（与官方问答一致）', () => {
  const couple = resolveQuota({ cityId: 'qingdao', isCouple: true, upliftIds: ['multiChild'] });
  const single = resolveQuota({ cityId: 'qingdao', isCouple: false, upliftIds: ['multiChild'] });
  assert.equal(couple.final, 169);
  assert.equal(single.final, 117);
});

test('上浮叠加后按封顶截断：双缴存 240 万 / 单缴存 160 万', () => {
  const all = ['multiChild', 'existingHome', 'greenBuilding', 'talent', 'flexible'];
  const couple = resolveQuota({ cityId: 'qingdao', isCouple: true, upliftIds: all });
  const single = resolveQuota({ cityId: 'qingdao', isCouple: false, upliftIds: all });
  // 130 × (1+0.3+0.1+0.3+0.3+0.1) = 273 万，应被 240 截断
  assert.equal(couple.uplifted, 273);
  assert.equal(couple.final, 240);
  // 90 × 2.1 = 189 万，应被 160 截断
  assert.equal(single.uplifted, 189);
  assert.equal(single.final, 160);
});

test('顺序正确：上浮作用于算出的额度，不是直接加在封顶上', () => {
  const one = resolveQuota({ cityId: 'qingdao', isCouple: true, upliftIds: ['greenBuilding'] });
  // 正确：min(130 × 1.3, 240) = 169
  assert.equal(one.final, 169);
  // 错误做法：min(130, 240) × 1.3 = 169 在此例巧合相同，换封顶更紧的场景才暴露
  const capped = resolveQuota({
    cityId: 'qingdao',
    isCouple: true,
    upliftIds: ['multiChild', 'existingHome', 'greenBuilding', 'talent', 'flexible'],
  });
  // 若先封顶再上浮：240 × 2.1 = 504，明显偏离官方 240
  assert.ok(capped.final <= capped.capped, '上浮后不得突破封顶');
  assert.equal(capped.final, 240);
});

test('额度取整：5000 元整数倍，且不低于 1 万元', () => {
  assert.equal(roundQuota(100), 100);
  assert.equal(roundQuota(169), 169);
  assert.equal(roundQuota(123.4), 123.5, '1234000 -> 1235000');
  assert.equal(roundQuota(123.2), 123.0);
  assert.equal(roundQuota(0.3), 1, '不低于 1 万');
});

test('提供账户余额与缴存基数时，额度取多项最低值', () => {
  const r = resolveQuota({
    cityId: 'qingdao',
    isCouple: true,
    // 账户余额 3 万 × 20 倍 = 60 万，低于最高额度 130 万
    accountBalance: 3,
    // 基数 1 万/月 × 40% × 12 × 25 年 = 120 万
    monthlyBase: 1,
    years: 25,
  });
  assert.equal(r.byBalance, 60);
  assert.equal(r.byCapacity, 120);
  assert.equal(r.rawBase, 60);
  assert.equal(r.limitedBy, '账户余额倍数');
  assert.equal(r.final, 60);
});

test('还贷能力成为瓶颈时被正确识别', () => {
  const r = resolveQuota({
    cityId: 'qingdao',
    isCouple: true,
    accountBalance: 20, // 20 × 20 = 400 万，够高
    monthlyBase: 0.5, // 0.5 × 40% × 12 × 20 = 48 万
    years: 20,
  });
  assert.equal(r.byCapacity, 48);
  assert.equal(r.limitedBy, '还贷能力');
  assert.equal(r.final, 48);
});

test('账户余额低于起点按 1 万元计', () => {
  const r = resolveQuota({ cityId: 'qingdao', isCouple: false, accountBalance: 0.2 });
  assert.equal(r.byBalance, 20, '0.2 万按 1 万起点算，1 × 20 = 20 万');
});

test('未缴存明细时只按最高额度约束，不假装算出更低的数', () => {
  const r = resolveQuota({ cityId: 'qingdao', isCouple: true });
  assert.equal(r.byBalance, null);
  assert.equal(r.byCapacity, null);
  assert.equal(r.limitedBy, '最高额度');
});

test('其他城市额度与官方口径一致', () => {
  assert.equal(resolveQuota({ cityId: 'shanghai', isCouple: true }).final, 200);
  assert.equal(resolveQuota({ cityId: 'shanghai', isCouple: false }).final, 100);
  assert.equal(resolveQuota({ cityId: 'shenzhen', isCouple: true }).final, 130);
  assert.equal(resolveQuota({ cityId: 'guangzhou', isCouple: true }).final, 200);
  assert.equal(resolveQuota({ cityId: 'hangzhou', isCouple: true }).final, 180);
});

test('上海补充公积金上浮 20%，但受封顶限制', () => {
  const r = resolveQuota({ cityId: 'shanghai', isCouple: true, upliftIds: ['supplementary'] });
  // 200 × 1.2 = 240，正好等于封顶
  assert.equal(r.uplifted, 240);
  assert.equal(r.final, 240);
});

test('describeQuota 输出可读摘要', () => {
  const r = resolveQuota({ cityId: 'qingdao', isCouple: true, upliftIds: ['multiChild'] });
  const text = describeQuota(r);
  assert.ok(text.includes('青岛'));
  assert.ok(text.includes('双缴存'));
  assert.ok(text.includes('169.00'));
  assert.ok(text.includes('30%'));
});
