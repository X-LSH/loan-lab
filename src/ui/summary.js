/**
 * 摘要类视图：KPI 卡、结清高亮卡、方式对比。
 *
 * 数字动效的取舍：只有「点按钮 / 切预设 / 首次加载」才滚动，
 * 输入框实时触发的更新直接落值——否则每敲一个数字都在追动画，手感很差。
 */

import { formatCents } from '../core/money.js';

const yuan = (cents) => formatCents(cents);
const wan = (cents) => (cents / 100 / 10000).toFixed(2);

const parseNum = (s) => Number(String(s).replace(/,/g, ''));

function formatNum(value, decimals, grouped) {
  const fixed = value.toFixed(decimals);
  if (!grouped) return fixed;
  const [int, frac] = fixed.split('.');
  const signed = int.startsWith('-');
  const digits = signed ? int.slice(1) : int;
  const groupedInt = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac ? `${groupedInt}.${frac}` : groupedInt;
  return signed ? `-${body}` : body;
}

/** 数字平滑滚动；小数位与千分位跟随目标字符串 */
function animateNumberText(el, nextText) {
  const prevText = el.textContent.trim();
  if (prevText === nextText) return;

  const from = parseNum(prevText);
  const to = parseNum(nextText);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    el.textContent = nextText;
    return;
  }

  const decimals = (nextText.split('.')[1] || '').length;
  const grouped = nextText.includes(',');
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || from === to) {
    el.textContent = nextText;
    return;
  }

  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const dur = 480;
  el._raf = requestAnimationFrame(function step(now) {
    const t = Math.min((now - t0) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = formatNum(from + (to - from) * eased, decimals, grouped);
    if (t < 1) {
      el._raf = requestAnimationFrame(step);
    } else {
      el.textContent = nextText;
    }
  });
}

function kpiHtml({ tone, label, value, unit, foot, small }) {
  return `<div class="kpi" data-tone="${tone}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value ${small ? 'is-small' : ''}"><span class="num">${value}</span><span class="kpi-unit">${unit}</span></div>
    <div class="kpi-foot">${foot}</div>
  </div>`;
}

function buildKpiData(plan) {
  const m = plan.merged;
  const isCombo = plan.schedules.length > 1;
  const years = plan.months / 12;
  const declining = plan.schedules.some((s) => s.method === 'equal-principal');
  const multiRate = (plan.mergedRateChanges?.length ?? 1) > 1;

  const first = m.summary.firstPayment;
  const last = m.summary.lastPayment;

  const paymentFoot = declining
    ? `末月降至 ${yuan(last)}`
    : multiRate
      ? `月供随重定价变化 · 末期 ${yuan(last)}`
      : `全期月供固定 · 末期 ${yuan(last)}`;

  return [
    {
      tone: 'neutral',
      label: '贷款总额',
      value: wan(m.totals.principal),
      unit: '万元',
      foot: `${years} 年 · ${plan.months} 期${isCombo ? ` · ${plan.schedules.length} 笔` : ''}${multiRate ? ' · 逐年重定价' : ''}`,
    },
    {
      tone: 'principal',
      label: isCombo ? '首月月供（合计）' : '首月月供',
      value: yuan(first),
      unit: '元',
      foot: paymentFoot,
    },
    {
      tone: 'interest',
      label: '全周期总利息',
      value: wan(m.totals.interest),
      unit: '万元',
      foot: `利息是本金 <strong>${((m.totals.interest / m.totals.principal) * 100).toFixed(1)}%</strong>`,
    },
    {
      tone: 'accent',
      label: '还到期总支出',
      value: wan(m.totals.payment),
      unit: '万元',
      foot: `本金 + 利息 · <strong>${yuan(m.totals.payment)} 元</strong>`,
    },
  ];
}

export function renderKpis(el, plan, { animate = false } = {}) {
  const data = buildKpiData(plan);

  if (!animate || el.children.length !== data.length) {
    el.innerHTML = data.map(kpiHtml).join('');
    return;
  }

  const cards = el.querySelectorAll('.kpi');
  data.forEach((item, index) => {
    const card = cards[index];
    card.dataset.tone = item.tone;
    card.querySelector('.kpi-label').textContent = item.label;
    const valueEl = card.querySelector('.kpi-value .num');
    const unitEl = card.querySelector('.kpi-unit');
    if (unitEl.textContent.trim() !== item.unit) unitEl.textContent = item.unit;
    animateNumberText(valueEl, item.value);
    card.querySelector('.kpi-foot').innerHTML = item.foot;
  });
}

/**
 * 结清高亮卡的骨架只创建一次，之后只更新数字。
 * 否则每次拖动滑块都会重建 DOM，输入事件会被打断，手感会碎。
 */
export function mountPayoffHighlight(el, plan) {
  el.innerHTML = `
    <div class="hl-head">
      <div>
        <div class="hl-title" data-hl-title></div>
        <p class="card-sub">拖动滑块切换年份，或点击下方表格任意一行</p>
      </div>
    </div>
    <div class="slider-row">
      <span class="slider-end">1 年</span>
      <input class="slider" type="range" min="12" max="${plan.months}" step="12" value="${Math.min(120, plan.months)}" data-hl-slider aria-label="选择结清年份" />
      <span class="slider-end" data-slider-max>${plan.months / 12} 年</span>
    </div>
    <div class="hl-grid" data-hl-grid></div>
  `;
  return {
    title: el.querySelector('[data-hl-title]'),
    slider: el.querySelector('[data-hl-slider]'),
    maxLabel: el.querySelector('[data-slider-max]'),
    grid: el.querySelector('[data-hl-grid]'),
  };
}

/**
 * 刻意把「结清现金」和「全周期总支出」并排放在一起，因为这两个数字
 * 最容易被混为一谈：前者是当天要转账的金额，后者是这件事的总成本。
 */
export function updatePayoffHighlight(refs, plan, selectedMonth) {
  const payoff = plan.payoff;
  const point = payoff.points.find((p) => p.month === selectedMonth) ?? payoff.points[1];

  refs.slider.max = String(plan.months);
  if (Number(refs.slider.value) !== point.month) refs.slider.value = String(point.month);
  if (refs.maxLabel) refs.maxLabel.textContent = `${plan.months / 12} 年`;

  const yearLabel = point.isFinal ? '按期还完（不提前结清）' : `第 ${point.year} 年结清`;
  const tone = point.savedInterest > 0 ? 'pos' : '';
  refs.title.textContent = `${yearLabel}${point.month > 0 && !point.isFinal ? ` · 已正常还完 ${point.month} 期` : ''}`;

  refs.grid.innerHTML = `
    <div class="hl-item">
      <div class="hl-k">结清当天要支付</div>
      <div class="hl-v">${yuan(point.settleCash)}<span class="kpi-unit">元</span></div>
      <div class="hl-note">剩余本金 ${yuan(point.balance)}${point.penalty > 0 ? ` + 违约金 ${yuan(point.penalty)}` : '，无违约金'}</div>
    </div>
    <div class="hl-item">
      <div class="hl-k">全周期总支出</div>
      <div class="hl-v">${yuan(point.totalOutlay)}<span class="kpi-unit">元</span></div>
      <div class="hl-note">已付月供 ${yuan(point.paid)} + 结清现金</div>
    </div>
    <div class="hl-item">
      <div class="hl-k">比还到期省下利息</div>
      <div class="hl-v ${tone}">${yuan(Math.max(point.savedInterest, 0))}<span class="kpi-unit">元</span></div>
      <div class="hl-note">省掉全部利息的 ${(point.savedRatio * 100).toFixed(1)}%</div>
    </div>
    <div class="hl-item">
      <div class="hl-k">已付利息</div>
      <div class="hl-v">${yuan(point.interestPaid)}<span class="kpi-unit">元</span></div>
      <div class="hl-note">原计划总利息 ${wan(payoff.totalInterest)} 万元</div>
    </div>
  `;
}

export function renderCompare(el, cmp, plan) {
  const isCombo = plan.schedules.length > 1;
  const ep = cmp.equalPayment;
  const epr = cmp.equalPrincipal;

  const card = (data, badge, badgeClass) => `
    <div class="cmp-card">
      <h3>${data.label}<span class="badge ${badgeClass}">${badge}</span></h3>
      <div class="cmp-row"><span>首月月供</span><span class="num">${yuan(data.firstPayment)} 元</span></div>
      <div class="cmp-row"><span>末月月供</span><span class="num">${yuan(data.lastPayment)} 元</span></div>
      <div class="cmp-row"><span>总利息</span><span class="num">${yuan(data.totalInterest)} 元</span></div>
      <div class="cmp-row"><span>总还款</span><span class="num">${yuan(data.totalPayment)} 元</span></div>
    </div>
  `;

  const gap = cmp.delta.firstPaymentDiff;
  const saved = cmp.delta.interestSaved;

  el.innerHTML = `
    <div class="cmp-grid">
      ${card(ep, '前期压力小', 'is-accent')}
      ${card(epr, '总利息少', 'is-saved')}
    </div>
    <div class="cmp-verdict">
      等额本金比等额本息<strong>少付利息 ${yuan(saved)} 元</strong>，代价是首月要多还 <strong>${yuan(gap)} 元</strong>，之后逐月递减。
      如果前期现金流吃紧，等额本息的固定月供更容易安排；如果打算在 10 年内提前结清，
      两者的利息差距会缩小——因为差距主要产生在还款后期。
      ${isCombo ? '<br />组合贷下这是「两笔同时切换」的假设性对比，实际可与银行分别约定。' : ''}
    </div>
  `;
}
