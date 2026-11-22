/**
 * 购房税费估算。
 *
 * 重要边界：这是**常见口径的估算**，不是官方计算器。
 * 契税、增值税、个税的征收细节各地差异很大（尤其是一线城市与
 * 非普通住宅的认定），实际以当地税务与房管部门为准。
 * 这里只做量级判断：让你知道「除了房款还要准备多少钱」。
 *
 * 政策依据（2026 年全国通用口径）：
 * - 契税：首套 90㎡ 以下 1%、以上 1.5%；二套 90㎡ 以下 1%、以上 2%；
 *   三套及以上 3%；非住宅 3%
 * - 增值税及附加：个人住房满 2 年免征；未满 2 年按 5.3% 全额征收
 * - 个人所得税：满五唯一免征；否则通常按总价 1% 核定征收
 * - 中介费：市场惯例 1%–3%，默认 2%
 */

/** 契税税率表 */
export const DEED_TAX = Object.freeze({
  FIRST_SMALL: 0.01, // 首套 ≤90㎡
  FIRST_LARGE: 0.015, // 首套 >90㎡
  SECOND_SMALL: 0.01, // 二套 ≤90㎡
  SECOND_LARGE: 0.02, // 二套 >90㎡
  THIRD_PLUS: 0.03, // 三套及以上
  NON_RESIDENTIAL: 0.03, // 非住宅
});

/** 增值税及附加：未满两年按 5.3% 全额征收 */
export const VAT_RATE = 0.053;
/** 个人所得税核定征收率 */
export const INCOME_TAX_RATE = 0.01;
/** 不动产登记费（住宅 80 元） */
export const REGISTRATION_FEE = 8000;

/** 面积分界线：90㎡ */
const AREA_THRESHOLD = 90;

/**
 * 契税税率。
 *
 * @param {object} p
 * @param {number} p.homeCount 家庭住房套数（含本次），1 / 2 / 3+
 * @param {number} p.areaSqm 建筑面积（㎡）
 * @param {boolean} [p.isResidential] 是否住宅，默认 true
 */
export function deedTaxRate({ homeCount = 1, areaSqm = 0, isResidential = true }) {
  if (!isResidential) return DEED_TAX.NON_RESIDENTIAL;
  if (homeCount >= 3) return DEED_TAX.THIRD_PLUS;

  const small = areaSqm <= AREA_THRESHOLD;
  if (homeCount === 1) return small ? DEED_TAX.FIRST_SMALL : DEED_TAX.FIRST_LARGE;
  return small ? DEED_TAX.SECOND_SMALL : DEED_TAX.SECOND_LARGE;
}

/**
 * 估算购房的一次性税费与费用。
 *
 * @param {object} p
 * @param {number} p.price 房款总价（分）
 * @param {number} p.areaSqm 建筑面积（㎡）
 * @param {number} [p.homeCount] 含本次的住房套数
 * @param {boolean} [p.isResidential] 是否住宅
 * @param {number} [p.sellerYears] 卖家持有年限
 * @param {boolean} [p.isSellerOnlyHome] 卖家是否唯一住房
 * @param {number} [p.agencyRate] 中介费率
 * @param {number} [p.downPayment] 首付款（分）
 * @param {number} [p.totalInterest] 全周期贷款利息（分），用于算总成本
 * @returns {object}
 */
export function estimatePurchaseCosts({
  price,
  areaSqm = 0,
  homeCount = 1,
  isResidential = true,
  sellerYears = 0,
  isSellerOnlyHome = false,
  agencyRate = 0.02,
  downPayment = 0,
  totalInterest = 0,
}) {
  const safePrice = Math.max(0, Math.round(price || 0));

  const deed = Math.round(safePrice * deedTaxRate({ homeCount, areaSqm, isResidential }));
  const vat = sellerYears >= 2 ? 0 : Math.round(safePrice * VAT_RATE);
  const incomeTax =
    sellerYears >= 5 && isSellerOnlyHome ? 0 : Math.round(safePrice * INCOME_TAX_RATE);
  const agency = Math.round(safePrice * Math.max(0, agencyRate));
  const registration = isResidential ? REGISTRATION_FEE : Math.round(REGISTRATION_FEE * 6.9); // 非住宅 550 元

  const taxes = deed + vat + incomeTax;
  const fees = agency + registration;
  /** 除房款外，过户阶段还要一次掏出来的钱 */
  const closingCosts = taxes + fees;
  /** 从签约到还完，全部现金投入 = 房款 + 过户费用 + 全周期利息。
      这里必须用**房款**而不是首付 —— 贷款本金也是你要还的钱，
      只加首付会把总投入少算一大截。 */
  const totalOutlay = safePrice + closingCosts + totalInterest;

  return {
    price: safePrice,
    deed,
    vat,
    incomeTax,
    agency,
    registration,
    taxes,
    fees,
    closingCosts,
    downPayment,
    totalInterest,
    totalOutlay,
    /** 税费相当于房款的百分比，便于直观感受 */
    closingRatio: safePrice > 0 ? closingCosts / safePrice : 0,
  };
}
