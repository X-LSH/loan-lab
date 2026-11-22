import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deedTaxRate,
  estimatePurchaseCosts,
  DEED_TAX,
  VAT_RATE,
  INCOME_TAX_RATE,
} from '../src/core/taxes.js';
import { toCents } from '../src/core/money.js';

test('首套 90㎡ 以下契税 1%，以上 1.5%', () => {
  assert.equal(deedTaxRate({ homeCount: 1, areaSqm: 89 }), DEED_TAX.FIRST_SMALL);
  assert.equal(deedTaxRate({ homeCount: 1, areaSqm: 90 }), DEED_TAX.FIRST_SMALL);
  assert.equal(deedTaxRate({ homeCount: 1, areaSqm: 90.1 }), DEED_TAX.FIRST_LARGE);
});

test('二套 90㎡ 以下 1%，以上 2%', () => {
  assert.equal(deedTaxRate({ homeCount: 2, areaSqm: 89 }), DEED_TAX.SECOND_SMALL);
  assert.equal(deedTaxRate({ homeCount: 2, areaSqm: 120 }), DEED_TAX.SECOND_LARGE);
});

test('三套及以上一律 3%，与面积无关', () => {
  assert.equal(deedTaxRate({ homeCount: 3, areaSqm: 60 }), DEED_TAX.THIRD_PLUS);
  assert.equal(deedTaxRate({ homeCount: 5, areaSqm: 200 }), DEED_TAX.THIRD_PLUS);
});

test('非住宅不分套数与面积，一律 3%', () => {
  assert.equal(
    deedTaxRate({ homeCount: 1, areaSqm: 50, isResidential: false }),
    DEED_TAX.NON_RESIDENTIAL,
  );
});

test('满两年免增值税，未满两年按 5.3% 全额征收', () => {
  const base = { price: toCents(2_000_000), areaSqm: 100, homeCount: 1 };
  assert.equal(estimatePurchaseCosts({ ...base, sellerYears: 1 }).vat, Math.round(toCents(2_000_000) * VAT_RATE));
  assert.equal(estimatePurchaseCosts({ ...base, sellerYears: 2 }).vat, 0);
  assert.equal(estimatePurchaseCosts({ ...base, sellerYears: 8 }).vat, 0);
});

test('满五唯一免个税，其他情况按 1% 核定', () => {
  const base = { price: toCents(2_000_000), areaSqm: 100, homeCount: 1 };
  assert.equal(
    estimatePurchaseCosts({ ...base, sellerYears: 6, isSellerOnlyHome: true }).incomeTax,
    0,
  );
  assert.equal(
    estimatePurchaseCosts({ ...base, sellerYears: 6, isSellerOnlyHome: false }).incomeTax,
    Math.round(toCents(2_000_000) * INCOME_TAX_RATE),
  );
  // 满五但不唯一，仍要交
  assert.ok(estimatePurchaseCosts({ ...base, sellerYears: 6 }).incomeTax > 0);
});

test('满二未满五：免增值税但仍有个税', () => {
  const r = estimatePurchaseCosts({
    price: toCents(2_000_000),
    areaSqm: 100,
    homeCount: 1,
    sellerYears: 3,
  });
  assert.equal(r.vat, 0);
  assert.ok(r.incomeTax > 0);
});

test('全周期总投入 = 房款 + 过户费用 + 利息', () => {
  const r = estimatePurchaseCosts({
    price: toCents(2_000_000),
    areaSqm: 100,
    homeCount: 1,
    sellerYears: 3,
    downPayment: toCents(600_000),
    totalInterest: toCents(500_000),
  });
  assert.equal(r.closingCosts, r.taxes + r.fees);
  assert.equal(r.totalOutlay, r.price + r.closingCosts + r.totalInterest);
});

test('总投入必须大于房款（不能漏算贷款本金）', () => {
  const r = estimatePurchaseCosts({
    price: toCents(2_000_000),
    areaSqm: 100,
    homeCount: 1,
    sellerYears: 3,
    downPayment: toCents(600_000),
    totalInterest: toCents(500_000),
  });
  // 曾经写成「首付 + 过户 + 利息」，把 140 万贷款本金整个漏掉
  assert.ok(r.totalOutlay > r.price, `总投入 ${r.totalOutlay} 应大于房款 ${r.price}`);
});

test('各项费用都是整数分', () => {
  const r = estimatePurchaseCosts({
    price: toCents(1_876_543),
    areaSqm: 88,
    homeCount: 2,
    sellerYears: 1,
    agencyRate: 0.023,
  });
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'number' && k !== 'closingRatio') {
      assert.ok(Number.isInteger(v), `${k} 应为整数分，实际 ${v}`);
    }
  }
});

test('零房款不产生 NaN', () => {
  const r = estimatePurchaseCosts({ price: 0, areaSqm: 90 });
  assert.equal(r.deed, 0);
  assert.equal(r.closingRatio, 0);
  assert.ok(Number.isFinite(r.totalOutlay));
});
