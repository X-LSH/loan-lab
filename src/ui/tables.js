/**
 * 表格渲染。所有金额输入为「分」，输出带千分位的元。
 */

import { formatCents } from '../core/money.js';

const yuan = (cents) => formatCents(cents);

function head(cells) {
  return `<thead><tr>${cells.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>`;
}

function row(cells, { className = '', data = '' } = {}) {
  return `<tr class="${className}" ${data}>${cells
    .map((c) => (typeof c === 'string' && c.startsWith('<') ? `<td>${c}</td>` : `<td>${c}</td>`))
    .join('')}</tr>`;
}

/**
 * 逐月明细。组合贷时追加每笔各自的月供，回答「这一期公积金还多少、商贷还多少」。
 */
export function renderMonthlyTable(tableEl, merged, { limit = 24, isCombo = false } = {}) {
  const labels = merged.rows[0]?.parts.map((p) => p.label) ?? [];
  const cols = ['期数', '月供合计', '偿还本金', '偿还利息', '期末剩余本金'];
  if (isCombo) cols.push(...labels.map((l) => `${l} 月供`));

  tableEl.querySelector('thead').outerHTML = head(cols);

  const tbody = tableEl.querySelector('tbody');
  const rows = merged.rows.slice(0, limit).map((r) => {
    const cells = [
      `<span class="dim">第 ${r.period} 期</span>`,
      `<span class="num">${yuan(r.payment)}</span>`,
      `<span class="num">${yuan(r.principal)}</span>`,
      `<span class="num">${yuan(r.interest)}</span>`,
      `<span class="num">${yuan(r.balance)}</span>`,
    ];
    if (isCombo) {
      cells.push(...r.parts.map((p) => `<span class="num dim">${yuan(p.payment)}</span>`));
    }
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  });

  tbody.innerHTML = rows.join('');
  return merged.rows.length;
}

/**
 * 按年汇总。等额本金下「年还款」逐年下降，等额本息下几乎持平——这个对比本身就是信息。
 */
export function renderYearlyTable(tableEl, years) {
  const cols = ['年度', '期数区间', '年还款合计', '其中本金', '其中利息', '年末剩余本金'];
  tableEl.querySelector('thead').outerHTML = head(cols);

  const tbody = tableEl.querySelector('tbody');
  tbody.innerHTML = years
    .map((y) => {
      const from = (y.year - 1) * 12 + 1;
      const to = Math.min(y.year * 12, (y.year - 1) * 12 + 12);
      return `<tr>
        <td>第 ${y.year} 年</td>
        <td class="dim">${from}–${to} 期</td>
        <td class="num em">${yuan(y.payment)}</td>
        <td class="num">${yuan(y.principal)}</td>
        <td class="num">${yuan(y.interest)}</td>
        <td class="num dim">${yuan(y.balance)}</td>
      </tr>`;
    })
    .join('');
}

/**
 * 结清测算表。行可点击，用于把上方高亮卡切到特定年份。
 */
export function renderPayoffTable(tableEl, payoff, { selectedMonth = null } = {}) {
  const cols = ['结清时点', '剩余本金', '结清当天现金', '已付月供', '全周期总支出', '省下利息'];
  tableEl.querySelector('thead').outerHTML = head(cols);

  const bodyPoints = payoff.points.filter((p) => p.month > 0);
  const tbody = tableEl.querySelector('tbody');
  tbody.innerHTML = bodyPoints
    .map((p) => {
      const yearLabel = p.isFinal ? '按期还完' : `第 ${p.year} 年`;
      const selected = selectedMonth === p.month ? ' is-selected' : '';
      return `<tr class="is-clickable${selected}" data-month="${p.month}" tabindex="0">
        <td>${yearLabel}</td>
        <td class="num">${yuan(p.balance)}</td>
        <td class="num em">${yuan(p.settleCash)}</td>
        <td class="num dim">${yuan(p.paid)}</td>
        <td class="num em">${yuan(p.totalOutlay)}</td>
        <td class="num pos">${p.savedInterest > 0 ? yuan(p.savedInterest) : '—'}</td>
      </tr>`;
    })
    .join('');
}

/** 组合贷两笔的占比与各自的利息负担 */
export function renderSplitNote(el, plan) {
  if (plan.schedules.length < 2) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.innerHTML = plan.weight
    .map(
      (w) => `<div class="split-item">
        <span class="split-name">${w.label}</span>
        <span class="split-val num">${yuan(w.principal)}</span>
        <span class="split-meta">占 ${(w.share * 100).toFixed(1)}% · ${w.methodLabel} · ${w.rateLabel} · 利息 ${yuan(w.totalInterest)}</span>
      </div>`,
    )
    .join('');
}
