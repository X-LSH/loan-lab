/**
 * 各地住房公积金贷款额度政策。
 *
 * 这里只做「最高额度约束 + 上浮叠加」，不做完整额度测算——
 * 真实可贷额度还要按账户余额倍数、还贷能力等四项取最低值，
 * 那些依赖个人缴存明细，各地公式也不统一。
 * 本模块把上限算准，把「还要看缴存明细」讲清楚。
 *
 * 顺序不可颠倒：先算出可贷额度 → 再按上浮比例放大 → 最后用封顶值截断。
 * 若直接在上限上加比例，会算出高于官方封顶的数字。
 *
 * 金额单位统一为「万元」，与界面输入一致；取整规则见 roundQuota。
 */

/** 各城市最高贷款额度（万元）。effective 为政策生效日期 */
export const FUND_CITIES = [
  {
    id: 'qingdao',
    name: '青岛',
    effective: '2026-04-20',
    source: '青岛市住房公积金管理中心',
    /** 基础最高额度：couple = 借款人及配偶均符合申贷条件 */
    maxQuota: { couple: 130, single: 90 },
    /** 各项上浮叠加后的封顶 */
    maxQuotaCapped: { couple: 240, single: 160 },
    uplifts: [
      { id: 'multiChild', label: '多子女家庭（2 个及以上子女）', rate: 0.3 },
      { id: 'existingHome', label: '购买新建商品房现房', rate: 0.1 },
      { id: 'greenBuilding', label: '高品质住宅 / 绿色建筑一星及以上', rate: 0.3 },
      { id: 'talent', label: '高层次人才 / 全日制博士', rate: 0.3 },
      { id: 'flexible', label: '灵活就业连续缴存满 2 年', rate: 0.1 },
    ],
    calcRules: {
      balanceMultiplier: 20,
      balanceMultiplierSpecial: 25,
      balanceFloor: 1,
      capacityRate: 0.4,
      maxYears: 30,
    },
    notes: [
      '额度以 1 万元为起点，按 5000 元整数倍确定',
      '首套与二套额度相同，差别在利率',
      '新市民（非青岛户籍或落户不满 3 年）与青年人（35 岁及以下）按账户余额 25 倍计算',
    ],
  },
  {
    id: 'beijing',
    name: '北京',
    effective: '2026-08',
    source: '北京住房公积金管理中心',
    maxQuota: { couple: 120, single: 120 },
    maxQuotaCapped: { couple: 340, single: 340 },
    uplifts: [
      { id: 'multiChild', label: '二孩及以上多子女家庭', rate: 0.33 },
      { id: 'greenBuilding', label: '绿色建筑 / 超低能耗建筑', rate: 0.2 },
    ],
    calcRules: {
      balanceMultiplier: 20,
      balanceMultiplierSpecial: 25,
      balanceFloor: 1,
      capacityRate: 0.5,
      maxYears: 30,
    },
    notes: [
      '额度与缴存年限挂钩，此处只约束上限',
      '城六区户籍家庭在城六区外购房等条件可叠加上浮，最高 340 万元',
    ],
  },
  {
    id: 'shanghai',
    name: '上海',
    effective: '2026-02',
    source: '上海市公积金管理中心',
    maxQuota: { couple: 200, single: 100 },
    maxQuotaCapped: { couple: 240, single: 120 },
    uplifts: [{ id: 'supplementary', label: '缴交补充公积金', rate: 0.2 }],
    calcRules: {
      balanceMultiplier: 20,
      balanceMultiplierSpecial: 25,
      balanceFloor: 1,
      capacityRate: 0.4,
      maxYears: 30,
    },
    notes: ['含补充公积金时家庭 240 万、个人 120 万', '2026 年 2 月「沪七条」大幅上调'],
  },
  {
    id: 'guangzhou',
    name: '广州',
    effective: '2026-04',
    source: '广州住房公积金管理中心',
    maxQuota: { couple: 200, single: 100 },
    maxQuotaCapped: { couple: 360, single: 180 },
    uplifts: [
      { id: 'child1', label: '一孩家庭', rate: 0.1 },
      { id: 'child2', label: '二孩家庭', rate: 0.4 },
      { id: 'child3', label: '三孩及以上家庭', rate: 0.5 },
      { id: 'greenBuilding', label: '一星级绿色建筑 / 装配式建筑', rate: 0.1 },
    ],
    calcRules: {
      balanceMultiplier: 10,
      balanceMultiplierSpecial: 10,
      balanceFloor: 1,
      capacityRate: 0.5,
      maxYears: 30,
    },
    notes: ['额度 = 账户余额×10 + 月缴存额×到退休年龄月数', '2026 年 4 月由 80/160 万上调至 100/200 万'],
  },
  {
    id: 'shenzhen',
    name: '深圳',
    effective: '2026-04',
    source: '深圳市住房公积金管理中心',
    maxQuota: { couple: 130, single: 70 },
    maxQuotaCapped: { couple: 351, single: 180 },
    uplifts: [
      { id: 'newlywed', label: '初婚初育居民家庭', rate: 0.5 },
      { id: 'multiChild', label: '两个及以上子女家庭', rate: 0.7 },
    ],
    calcRules: {
      balanceMultiplier: 14,
      balanceMultiplierSpecial: 16,
      balanceFloor: 1,
      capacityRate: 0.5,
      maxYears: 30,
    },
    notes: ['2026 年 4 月由 60/110 万上调至 70/130 万'],
  },
  {
    id: 'hangzhou',
    name: '杭州',
    effective: '2026-03',
    source: '杭州住房公积金管理中心',
    maxQuota: { couple: 180, single: 100 },
    maxQuotaCapped: { couple: 306, single: 180 },
    uplifts: [
      { id: 'newCitizen', label: '新市民 / 青年人家庭', rate: 0.2 },
      { id: 'talent', label: '高层次人才家庭', rate: 0.5 },
      { id: 'multiChild', label: '多子女家庭', rate: 0.6 },
      { id: 'greenBuilding', label: '绿色低碳建筑 / 以旧换新', rate: 0.2 },
    ],
    calcRules: {
      balanceMultiplier: 20,
      balanceMultiplierSpecial: 20,
      balanceFloor: 1,
      capacityRate: 0.4,
      maxYears: 30,
    },
    notes: ['人群类与房屋类上浮可择高叠加，最高叠加上浮 80%'],
  },
];

export const DEFAULT_CITY_ID = 'qingdao';

export function getCity(cityId) {
  return FUND_CITIES.find((c) => c.id === cityId) ?? FUND_CITIES[0];
}

/** 规整到「元」精度，清掉 0.4×12×25 = 120.00000000000001 这类浮点尾巴 */
const trimYuan = (wan) => Math.round(wan * 10000) / 10000;

/**
 * 计算公积金额度上限。
 *
 * 青岛等城市的口径是：先按四项计算出可贷额度（此处取最高额度作为代表），
 * 再按上浮比例放大，最后用封顶值截断。顺序不可颠倒。
 *
 * @param {object} input
 * @param {string} input.cityId
 * @param {boolean} [input.isCouple] 借款人及配偶均符合申贷条件
 * @param {string[]} [input.upliftIds] 命中的上浮情形
 * @param {number} [input.accountBalance] 账户正常缴存余额（万元），提供则参与取最低
 * @param {number} [input.monthlyBase] 月缴存工资基数（万元/月），提供则参与取最低
 * @param {number} [input.years] 额度计算年限
 * @returns {{city, isCouple, upliftRate, base, uplifted, capped, final, byBalance, byCapacity, limitedBy}|null}
 */
export function resolveQuota(input) {
  const city = getCity(input.cityId);
  const isCouple = input.isCouple !== false;
  const upliftIds = Array.isArray(input.upliftIds) ? input.upliftIds : [];

  const base = isCouple ? city.maxQuota.couple : city.maxQuota.single;
  const cap = isCouple ? city.maxQuotaCapped.couple : city.maxQuotaCapped.single;

  const hits = city.uplifts.filter((u) => upliftIds.includes(u.id));
  const upliftRate = hits.reduce((sum, u) => sum + u.rate, 0);

  // 1) 先算可贷额度：最高额度是四项约束之一，这里取它作为代表；
  //    若用户填了缴存明细，则一并参与取最低值。
  const candidates = [{ label: '最高额度', value: base }];

  let byBalance = null;
  if (Number.isFinite(input.accountBalance)) {
    const mult = input.accountBalance > 0 ? city.calcRules.balanceMultiplier : 0;
    byBalance = trimYuan(Math.max(input.accountBalance, city.calcRules.balanceFloor) * mult);
    candidates.push({ label: '账户余额倍数', value: byBalance });
  }

  let byCapacity = null;
  if (Number.isFinite(input.monthlyBase) && Number.isFinite(input.years)) {
    const years = Math.min(input.years, city.calcRules.maxYears);
    byCapacity = trimYuan(input.monthlyBase * city.calcRules.capacityRate * 12 * years);
    candidates.push({ label: '还贷能力', value: byCapacity });
  }

  const rawBase = Math.min(...candidates.map((c) => c.value));
  const limitedBy = candidates.reduce((min, c) => (c.value < min.value ? c : min)).label;

  // 2) 再上浮
  const uplifted = trimYuan(rawBase * (1 + upliftRate));
  // 3) 最后封顶
  const final = Math.min(uplifted, cap);

  return {
    city,
    isCouple,
    upliftRate,
    hits,
    base,
    rawBase,
    uplifted,
    capped: cap,
    final: roundQuota(final),
    byBalance,
    byCapacity,
    limitedBy,
  };
}

/**
 * 青岛口径：额度以 1 万元为起点，按 5000 元的整数倍确定。
 * 其他城市规则类似，此处统一处理。
 */
export function roundQuota(wan) {
  const yuan = wan * 10000;
  const rounded = Math.max(Math.round(yuan / 5000) * 5000, 10000);
  return rounded / 10000;
}

/** 给界面用的一句话摘要 */
export function describeQuota(result) {
  if (!result) return '';
  const { city, isCouple, upliftRate, final, limitedBy } = result;
  const who = isCouple ? '双缴存' : '单缴存';
  const upliftPart = upliftRate > 0 ? `（含上浮 ${(upliftRate * 100).toFixed(0)}%）` : '';
  return `${city.name} · ${who}上限 ${final.toFixed(2)} 万${upliftPart} · ${city.effective} 起执行`;
}
