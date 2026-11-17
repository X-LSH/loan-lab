/**
 * 摘要类视图：KPI 卡、结清高亮卡、方式对比。
 */

import { formatCents } from '../core/money.js';

const yuan = (cents) => formatCents(cents);
const wan = (cents) => (cents / 100 / 10000).toFixed(2);

function kpi({ label, value, unit, foot, small = false }) {
  return `<div class="kpi">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value ${small ? 'is-small' : ''}"><span class="num">${value}</span><span class="kpi-unit">${unit}</span></div>
    <div class="kpi-foot">${foot}</div>
  </div>`;
}

export function renderKpis(el, plan) {
  const m = plan.merged;
  const isCombo = plan.schedules.length > 1;
  const years = plan.months / 12;
  const declining = plan.schedules.some((s) => s.method === 'equal-principal');

  const first = m.summary.firstPayment;
  const last = m.summary.lastPayment;
  const paymentFoot = declining
    ? `末月降至 ${yuan(last)}`
    : `全期月供固定 · 末期 ${yuan(last)}`;

  el.innerHTML = [
    kpi({
      label: '贷款总额',
      value: wan(m.totals.principal),
      unit: '万元',
      foot: `${years} 年 · ${plan.months} 期${isCombo ? ` · ${plan.schedules.length} 笔` : ''}`,
    }),
    kpi({
      label: isCombo ? '首月月供（合计）' : '首月月供',
      value: yuan(first),
      unit: '元',
      foot: paymentFoot,
    }),
    kpi({
      label: '全周期总利息',
      value: wan(m.totals.interest),
      unit: '万元',
      foot: `利息是本金 <strong>${((m.totals.interest / m.totals.principal) * 100).toFixed(1)}%</strong>`,
    }),
    kpi({
      label: '还到期总支出',
      value: wan(m.totals.payment),
      unit: '万元',
      foot: `本金 + 利息 · <strong>${yuan(m.totals.payment)} 元</strong>`,
    }),
  ].join('');
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

  const card = (data, { recommended = false } = {}) => `
    <div class="cmp-card">
      <h3>${data.label}${recommended ? '<span class="badge">前期压力小</span>' : '<span class="badge" style="background:var(--saved-soft);color:var(--saved)">总利息少</span>'}</h3>
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
      ${card(ep, { recommended: true })}
      ${card(epr)}
    </div>
    <div class="cmp-verdict">
      等额本金比等额本息<strong>少付利息 ${yuan(saved)} 元</strong>，代价是首月要多还 <strong>${yuan(gap)} 元</strong>，之后逐月递减。
      如果前期现金流吃紧，等额本息的固定月供更容易安排；如果打算在 10 年内提前结清，
      两者的利息差距会缩小——因为差距主要产生在还款后期。
      ${isCombo ? '<br />组合贷下这是「两笔同时切换」的假设性对比，实际可与银行分别约定。' : ''}
    </div>
  `;
}
