/**
 * 应用入口：表单状态 -> 计算 -> 渲染。
 * 所有金额在 UI 层以「万元」录入，进入计算内核前统一转成「分」。
 */

import { buildPlan, compareMethods, aggregateByYear } from './core/plan.js';
import {
  LPR_5Y, RATE_PRESETS, FUND_PRESETS,
  rateToBp, fundRateFor, ratesFromLprPath, describeRatePath,
} from './core/rates.js';
import {
  FUND_CITIES, DEFAULT_CITY_ID, getCity, resolveQuota, describeQuota,
} from './core/quota.js';
import { renderKpis, mountPayoffHighlight, updatePayoffHighlight, renderCompare } from './ui/summary.js';
import { renderMonthlyTable, renderYearlyTable, renderPayoffTable, renderSplitNote } from './ui/tables.js';
import { renderStackedBars, renderPayoffChart, renderPaymentChart, renderPaymentCompareChart, renderInterestCompareChart } from './ui/charts.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const LPR_MAX_YEARS = 30;

const state = {
  mode: 'commercial',
  scheduleView: 'year',
  monthlyLimit: 24,
  selectedMonth: 120,
  // LPR 逐年重定价
  lprEnabled: false,
  lprSpreadBp: -45,
  lprPath: Array.from({ length: LPR_MAX_YEARS }, () => LPR_5Y * 100),
  lprScenario: 'flat',
  // 公积金额度政策
  fundCity: DEFAULT_CITY_ID,
  fundScope: 'couple',
  fundUplifts: [],
  fundQuota: null,
};

let plan = null;
let cmp = null;
let highlightRefs = null;
let debounceTimer = null;

/* ------------------------------------------------------------------ 读取 */

const centsFromWan = (wan) => Math.round(wan * 1e6);

function readNumber(selector) {
  const raw = Number($(selector).value);
  return Number.isFinite(raw) ? raw : NaN;
}

function readTerm() {
  const years = Math.round(readNumber('[data-term]'));
  if (!Number.isFinite(years) || years < 1 || years > 30) {
    throw new Error('贷款期限需在 1 ~ 30 年之间');
  }
  return { years, months: years * 12 };
}

function collectLoans() {
  const term = readTerm();
  const loans = [];

  const push = (kind, label) => {
    const wan = readNumber(`[data-amount="${kind}"]`);
    const ratePercent = readNumber(`[data-rate="${kind}"]`);
    if (!Number.isFinite(wan) || wan <= 0) return;
    if (!Number.isFinite(ratePercent) || ratePercent < 0) {
      throw new Error(`${label}的年利率填写有误`);
    }
    const loan = {
      label,
      principal: centsFromWan(wan),
      method: $(`[data-method="${kind}"]`).value,
    };
    // LPR 重定价只作用于商业贷款；公积金走国家统一利率，不套 LPR
    if (kind === 'commercial' && state.lprEnabled) {
      const lprDecimals = state.lprPath.slice(0, term.years).map((v) => v / 100);
      loan.annualRates = ratesFromLprPath(lprDecimals, state.lprSpreadBp, term.years);
    } else {
      loan.annualRate = ratePercent / 100;
    }
    loans.push(loan);
  };

  if (state.mode !== 'fund') push('commercial', '商业贷款');
  if (state.mode !== 'commercial') push('fund', '公积金');

  if (loans.length === 0) {
    throw new Error('请至少填写一笔大于 0 的贷款金额');
  }
  return { loans, months: term.months, years: term.years };
}

function readPenalty() {
  const rate = Math.max(readNumber('[data-penalty-rate]') || 0, 0) / 100;
  const free = Math.max(Math.round(readNumber('[data-penalty-free]') || 0), 0);
  return { penaltyRate: rate, penaltyFreeMonths: free };
}

/* ------------------------------------------------------------------ 计算 */

function recompute({ animate = false } = {}) {
  try {
    const { loans, months, years } = collectLoans();
    const { penaltyRate, penaltyFreeMonths } = readPenalty();

    plan = buildPlan({ months, loans, penaltyRate, penaltyFreeMonths });
    cmp = compareMethods({ months, loans });

    const maxMonth = plan.months;
    if (state.selectedMonth > maxMonth) state.selectedMonth = maxMonth;
    if (state.monthlyLimit > maxMonth) state.monthlyLimit = maxMonth;

    setError(null);
    renderAll(years, { animate });
  } catch (error) {
    setError(error.message);
  }
}

function setError(message) {
  const el = $('#form-error');
  el.hidden = !message;
  el.textContent = message ?? '';
}

/* ------------------------------------------------------------------ 渲染 */

function renderAll(years, { animate = false } = {}) {
  renderKpis($('#kpis'), plan, { animate });
  renderSplitNote($('#split-note'), plan);
  updateTermNote(years);
  updateShares();
  updateQuota();

  if (!highlightRefs) {
    highlightRefs = mountPayoffHighlight($('#payoff-highlight'), plan);
    highlightRefs.slider.addEventListener('input', () => {
      state.selectedMonth = Number(highlightRefs.slider.value);
      updatePayoffHighlight(highlightRefs, plan, state.selectedMonth);
      renderPayoffTable($('#payoff-table'), plan.payoff, { selectedMonth: state.selectedMonth });
    });
  }
  updatePayoffHighlight(highlightRefs, plan, state.selectedMonth);

  redrawCharts();
  renderScheduleTable();
  renderPayoffTable($('#payoff-table'), plan.payoff, { selectedMonth: state.selectedMonth });
  renderCompare($('#compare-body'), cmp, plan);
}

function redrawCharts() {
  renderPaymentChart($('#chart-payment'), plan.merged.rows, plan.mergedRateChanges, chartModes.payment);
  renderStackedBars($('#chart-composition'), aggregateByYear(plan.merged), chartModes.composition);
  renderPayoffChart($('#chart-payoff'), plan.payoff);
  if (cmp) {
    renderPaymentCompareChart($('#chart-cmp-payment'), cmp.equalPayment.rows, cmp.equalPrincipal.rows);
    renderInterestCompareChart($('#chart-cmp-interest'), cmp.equalPayment.rows, cmp.equalPrincipal.rows);
  }
  updatePaymentChartSub();
}

function updatePaymentChartSub() {
  const el = $('#payment-chart-sub');
  if (!el || !plan) return;
  const s = plan.merged.summary;
  const scaled = s.maxPayment > 0 && (s.maxPayment - s.minPayment) / s.maxPayment >= 0.02;
  const axisNote = scaled
    ? '纵轴非零起点，只为看清台阶幅度。'
    : '纵轴从 0 起，可对照月供占贷款额的比例。';
  const changes = plan.mergedRateChanges;

  if (changes.length > 1) {
    const parts = changes.map(
      (c) => `第 ${Math.ceil(c.period / 12)} 年起 ${(c.monthly / 100).toFixed(2)}`,
    );
    el.textContent = `月供随重定价变化：${parts.join(' → ')}。${axisNote}`;
  } else {
    el.textContent =
      plan.schedules.some((x) => x.method === 'equal-principal')
        ? `等额本金下月供逐月递减；当前未启用逐年重定价，故无台阶。${axisNote}`
        : `固定利率下月供恒定；启用「LPR 逐年重定价」后会出现台阶。${axisNote}`;
  }
}

function renderScheduleTable() {
  const isCombo = plan.schedules.length > 1;
  const sub = $('#schedule-sub');
  const moreBtn = $('#schedule-more');

  if (state.scheduleView === 'year') {
    renderYearlyTable($('#schedule-table'), aggregateByYear(plan.merged));
    sub.textContent = `共 ${plan.months} 期，按年度汇总。「年还款合计」在等额本金下会逐年下降`;
    moreBtn.hidden = true;
  } else {
    const total = renderMonthlyTable($('#schedule-table'), plan.merged, {
      limit: state.monthlyLimit,
      isCombo,
    });
    sub.textContent = isCombo
      ? '合计列之后是每笔各自的月供，两笔的实际还款日与计息方式可能不同'
      : `共 ${total} 期，逐期列出本金与利息`;
    const shown = Math.min(state.monthlyLimit, total);
    moreBtn.hidden = shown >= total;
    moreBtn.textContent = `展开更多（已显示 ${shown} / ${total} 期）`;
  }
}

function updateTermNote(years) {
  const total = plan.merged.totals.principal;
  // 分 -> 万元：1 万元 = 1e6 分。这里曾误用 1e8，导致 100 万显示成 1.00 万
  $('#total-amount-note').textContent =
    `合计贷款 ${(total / 1e6).toFixed(2)} 万元 · ${years} 年 · ${plan.months} 期`;
}

/** 组合贷时在每个贷款块右上角显示占比 */
function updateShares() {
  const total = plan.merged.totals.principal || 1;
  for (const kind of ['commercial', 'fund']) {
    const el = $(`[data-share="${kind}"]`);
    if (!el) continue;
    const match = plan.weight.find(
      (w) => w.label === (kind === 'commercial' ? '商业贷款' : '公积金'),
    );
    el.textContent = match ? `占 ${(match.share * 100).toFixed(1)}%` : '';
  }
}

/* ------------------------------------------------------------------ 利率提示 */

function updateRateHints() {
  const months = Math.round(readNumber('[data-term]')) * 12 || 360;

  const commercialInput = $('[data-rate="commercial"]');
  const commercialHint = $('[data-rate-hint="commercial"]');

  if (state.lprEnabled && state.mode !== 'fund') {
    // 启用重定价后，商贷利率由 LPR + 加点推出，输入框改为只读
    const firstRate = Math.max(state.lprPath[0] / 100 + state.lprSpreadBp * 0.0001, 0);
    commercialInput.value = (firstRate * 100).toFixed(3);
    commercialInput.readOnly = true;
    commercialInput.classList.add('is-readonly');
    commercialHint.textContent =
      `= LPR ${state.lprPath[0].toFixed(2)}% ${state.lprSpreadBp >= 0 ? '+' : '−'}${Math.abs(state.lprSpreadBp)}BP` +
      ` · 第 2 年起按新 LPR 重定价`;
    updateLprSummary();
  } else {
    commercialInput.readOnly = false;
    commercialInput.classList.remove('is-readonly');
    const commercial = Number(commercialInput.value);
    if (Number.isFinite(commercial)) {
      const bp = rateToBp(commercial / 100, LPR_5Y);
      if (Math.abs(bp) <= 300) {
        commercialHint.textContent =
          bp === 0
            ? '等于 5 年期以上 LPR 基准 3.50%'
            : `相当于 LPR 3.50% ${bp > 0 ? '加' : '减'} ${Math.abs(bp)} 个基点（${bp > 0 ? '+' : '−'}${Math.abs(bp)}BP）`;
      } else {
        commercialHint.textContent = '按固定年利率计算，与当前 LPR 偏离较大';
      }
    }
  }

  const fund = readNumber('[data-rate="fund"]');
  const fundHint = $('[data-rate-hint="fund"]');
  if (Number.isFinite(fund)) {
    const base = fundRateFor({ firstHome: true, months });
    const tier = months <= 60 ? '5 年以下' : '5 年期以上';
    const bp = rateToBp(fund / 100, base);
    fundHint.textContent =
      bp === 0
        ? `与公积金首套 ${tier}基准 ${(base * 100).toFixed(3)}% 一致`
        : `公积金首套 ${tier}基准 ${(base * 100).toFixed(3)}%，当前${bp > 0 ? '上浮' : '下浮'} ${Math.abs(bp)} 个基点`;
  }
}

/* ------------------------------------------------------------------ LPR 逐年重定价 */

function renderLprGrid() {
  const grid = $('[data-lpr-grid]');
  const years = Math.min(Math.round(readNumber('[data-term]')) || 30, LPR_MAX_YEARS);
  grid.innerHTML = Array.from({ length: years }, (_, i) => {
    const value = state.lprPath[i];
    const changed = Math.abs(value - LPR_5Y * 100) > 1e-9;
    return `<label class="lpr-cell${changed ? ' is-changed' : ''}">
      <span class="lpr-year">${i + 1}</span>
      <input class="input num" type="number" inputmode="decimal" step="0.05" min="0" max="20"
             value="${value.toFixed(2)}" data-lpr-year="${i}" aria-label="第 ${i + 1} 年 LPR" />
    </label>`;
  }).join('');
}

function updateLprSummary() {
  const el = $('[data-lpr-summary]');
  if (!el) return;
  const years = Math.min(Math.round(readNumber('[data-term]')) || 30, LPR_MAX_YEARS);
  const lprDecimals = state.lprPath.slice(0, years).map((v) => v / 100);
  const rates = ratesFromLprPath(lprDecimals, state.lprSpreadBp, years);
  el.textContent = `${describeRatePath(rates, state.lprSpreadBp)} · 共 ${years} 个重定价周期`;
}

function applyLprScenario(kind) {
  const base = LPR_5Y * 100;
  // 快捷情景只假设 10 年，之后持平。若按 30 年线性外推，-25BP/年 会把 LPR 减成负数，
  // 看似精确实则荒谬；把预测窗口说清楚比假装能算 30 年更重要。
  const HORIZON = 10;
  const valueAt = (index, stepPercent) => {
    const y = Math.min(index, HORIZON - 1);
    return Math.max(base + y * stepPercent, 0);
  };

  if (kind === 'flat') state.lprPath = Array.from({ length: LPR_MAX_YEARS }, () => base);
  if (kind === 'down') state.lprPath = Array.from({ length: LPR_MAX_YEARS }, (_, i) => valueAt(i, -0.25));
  if (kind === 'up') state.lprPath = Array.from({ length: LPR_MAX_YEARS }, (_, i) => valueAt(i, 0.25));
  state.lprScenario = kind;
  $$('[data-lpr-scenario]').forEach((b) => b.classList.toggle('is-active', b.dataset.lprScenario === kind));
  renderLprGrid();
  updateRateHints();
  recompute({ animate: true });
}

/* ------------------------------------------------------------------ 公积金额度 */

function renderFundQuota() {
  const citySelect = $('[data-fund-city]');
  citySelect.innerHTML = FUND_CITIES.map(
    (c) => `<option value="${c.id}"${c.id === state.fundCity ? ' selected' : ''}>${c.name}</option>`,
  ).join('');
  $('[data-fund-scope]').value = state.fundScope;
  renderUplifts();
}

function renderUplifts() {
  const city = getCity(state.fundCity);
  $('[data-uplifts]').innerHTML = city.uplifts
    .map((u) => {
      const active = state.fundUplifts.includes(u.id);
      return `<button type="button" class="chip${active ? ' is-active' : ''}" data-uplift="${u.id}"
                aria-pressed="${active}">+${Math.round(u.rate * 100)}% ${u.label}</button>`;
    })
    .join('');
}

/**
 * 计算并展示额度上限。这是「提示不阻断」——工具用于测算，
 * 用户有权模拟超出实际上限的方案，但必须知道自己超了多少。
 */
function updateQuota() {
  const result = resolveQuota({
    cityId: state.fundCity,
    isCouple: state.fundScope === 'couple',
    upliftIds: state.fundUplifts,
  });
  state.fundQuota = result;

  const info = $('[data-quota-info]');
  if (info) {
    info.innerHTML =
      `当前上限 <strong>${result.final.toFixed(2)} 万元</strong> · ` +
      `${describeQuota(result)}<br />` +
      `${result.city.notes[0]}。实际可贷额度还需按账户余额倍数与还贷能力取最低，此处仅校验上限。`;
  }

  const warn = $('[data-quota-warning]');
  if (!warn) return;
  const amount = readNumber('[data-amount="fund"]');
  const over = Number.isFinite(amount) ? amount - result.final : -Infinity;

  if (over > 1e-9) {
    warn.hidden = false;
    warn.innerHTML =
      `已超出当地上限 <strong>${over.toFixed(2)} 万元</strong>（${result.city.name} ${result.final.toFixed(2)} 万）。` +
      `这是测算工具，可以继续算，但实际申请会被拒绝。<br />` +
      `<button type="button" class="btn-clip" data-quota-clip>裁剪到 ${result.final.toFixed(2)} 万</button>`;
  } else {
    warn.hidden = true;
    warn.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ 预设 */

function renderPresets() {
  const build = (kind, presets) => {
    const el = $(`[data-presets="${kind}"]`);
    el.innerHTML = presets
      .map(
        (p) =>
          `<button type="button" class="chip" data-set-rate="${kind}" data-value="${p.rate}" title="${p.label}">${p.hint}</button>`,
      )
      .join('');
  };
  build('commercial', RATE_PRESETS);
  build('fund', FUND_PRESETS);
}

/* ------------------------------------------------------------------ 事件 */

function setMode(mode) {
  state.mode = mode;
  $$('.seg-btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  $('[data-block="commercial"]').hidden = mode === 'fund';
  $('[data-block="fund"]').hidden = mode === 'commercial';
  updateRateHints();
  recompute({ animate: true });
}

const THEMES = ['dark', 'light', 'xiaomi'];

/* ------------------------------------------------------------------ 卡片模块化 */

/** 图表形态切换状态：payment 折线/面积，composition 堆叠/百分比 */
const chartModes = { payment: 'line', composition: 'stack' };

const COLLAPSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/**
 * 给标记为 .is-collapsible 的卡片注入折叠按钮并绑定事件。
 * 按钮由 JS 注入而不是写死在 HTML，避免每个卡片都重复一段图标 markup。
 * 折叠状态写 localStorage，刷新后保持。
 */
function mountCardTools() {
  $$('.card.is-collapsible').forEach((card) => {
    const key = `loanlab-card-${card.dataset.card ?? ''}`;
    if (!card.querySelector('.card-collapse')) {
      let actions = card.querySelector('.card-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'card-actions';
        card.querySelector('.card-head')?.append(actions);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card-tool card-collapse';
      btn.setAttribute('aria-label', '折叠卡片');
      btn.title = '折叠';
      btn.innerHTML = COLLAPSE_ICON;
      actions.prepend(btn);
    }

    try {
      if (localStorage.getItem(key) === 'collapsed') card.classList.add('is-collapsed');
    } catch {
      /* 隐私模式忽略 */
    }

    card.querySelector('.card-collapse').addEventListener('click', () => {
      const collapsed = card.classList.toggle('is-collapsed');
      try {
        localStorage.setItem(key, collapsed ? 'collapsed' : 'expanded');
      } catch {
        /* 忽略 */
      }
    });
  });

  // 图表形态切换
  $$('[data-chart-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.chartToggle;
      if (target === 'payment') {
        chartModes.payment = chartModes.payment === 'line' ? 'area' : 'line';
        btn.classList.toggle('is-active', chartModes.payment === 'area');
        btn.setAttribute('aria-label', chartModes.payment === 'area' ? '切换为折线图' : '切换为面积图');
      } else if (target === 'composition') {
        chartModes.composition = chartModes.composition === 'stack' ? 'percent' : 'stack';
        btn.classList.toggle('is-active', chartModes.composition === 'percent');
        btn.setAttribute('aria-label', chartModes.composition === 'percent' ? '切换为绝对值视图' : '切换为百分比视图');
      }
      redrawCharts();
    });
  });
}

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('loanlab-theme', next);
  } catch {
    /* 隐私模式下写不进去，不影响本次使用 */
  }
  $$('[data-theme-set]').forEach((btn) => {
    const active = btn.dataset.themeSet === next;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function scheduleRecompute() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => recompute(), 160);
}

function bindEvents() {
  $$('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  $$('[data-amount], [data-rate], [data-method]').forEach((input) => {
    input.addEventListener('input', () => {
      updateRateHints();
      scheduleRecompute();
    });
    input.addEventListener('change', () => {
      updateRateHints();
      scheduleRecompute();
    });
  });

  $('[data-term]').addEventListener('input', () => {
    renderLprGrid();
    updateRateHints();
    scheduleRecompute();
  });

  $$('[data-term-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('[data-term]').value = btn.dataset.termPreset;
      $$('[data-term-preset]').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderLprGrid();
      recompute({ animate: true });
    });
  });

  $('[data-penalty-rate]').addEventListener('input', scheduleRecompute);
  $('[data-penalty-free]').addEventListener('input', scheduleRecompute);

  // 利率快捷预设
  document.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-set-rate]');
    if (!chip) return;
    const kind = chip.dataset.setRate;
    const rate = Number(chip.dataset.value);
    $(`[data-rate="${kind}"]`).value = String(Number((rate * 100).toFixed(4)));
    $$(`[data-presets="${kind}"] .chip`).forEach((c) => c.classList.toggle('is-active', c === chip));
    updateRateHints();
    recompute({ animate: true });
  });

  // 主题切换
  $$('[data-theme-set]').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeSet));
  });

  // LPR 逐年重定价
  $('[data-lpr-enabled]').addEventListener('change', (event) => {
    state.lprEnabled = event.target.checked;
    $('[data-lpr-config]').hidden = !state.lprEnabled;
    updateRateHints();
    recompute({ animate: true });
  });

  $('[data-lpr-spread]').addEventListener('input', () => {
    const raw = readNumber('[data-lpr-spread]');
    state.lprSpreadBp = Number.isFinite(raw) ? raw : 0;
    updateRateHints();
    scheduleRecompute();
  });

  $$('[data-lpr-scenario]').forEach((btn) => {
    btn.addEventListener('click', () => applyLprScenario(btn.dataset.lprScenario));
  });

  // 逐年 LPR 输入（事件委托，grid 会整体重绘）
  $('[data-lpr-grid]').addEventListener('input', (event) => {
    const input = event.target.closest('[data-lpr-year]');
    if (!input) return;
    const index = Number(input.dataset.lprYear);
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0) return;
    state.lprPath[index] = value;
    input.closest('.lpr-cell')?.classList.toggle('is-changed', Math.abs(value - LPR_5Y * 100) > 1e-9);
    state.lprScenario = 'custom';
    $$('[data-lpr-scenario]').forEach((b) => b.classList.remove('is-active'));
    updateRateHints();
    scheduleRecompute();
  });

  // 公积金额度政策
  $('[data-fund-city]').addEventListener('change', (event) => {
    state.fundCity = event.target.value;
    // 换城市后上浮项可能不同，清掉旧选择避免留着无效勾选
    state.fundUplifts = [];
    renderUplifts();
    updateQuota();
    recompute({ animate: true });
  });

  $('[data-fund-scope]').addEventListener('change', (event) => {
    state.fundScope = event.target.value;
    updateQuota();
    recompute({ animate: true });
  });

  $('[data-uplifts]').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-uplift]');
    if (!chip) return;
    const id = chip.dataset.uplift;
    state.fundUplifts = state.fundUplifts.includes(id)
      ? state.fundUplifts.filter((x) => x !== id)
      : [...state.fundUplifts, id];
    renderUplifts();
    updateQuota();
    recompute({ animate: true });
  });

  // 一键裁剪到上限
  $('[data-quota-warning]').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-quota-clip]');
    if (!btn || !state.fundQuota) return;
    $('[data-amount="fund"]').value = String(state.fundQuota.final);
    updateQuota();
    recompute({ animate: true });
  });

  // Tab 切换
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('is-active', active);
        t.setAttribute('aria-selected', String(active));
      });
      $$('.tab-panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
      });
      if (tab.dataset.tab === 'schedule' || tab.dataset.tab === 'payoff') {
        // 从 display:none 恢复显示后重绘，确保 viewBox 拿到正确宽度
        requestAnimationFrame(redrawCharts);
      }
    });
  });

  // 表格视图切换
  $$('[data-schedule-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.scheduleView = btn.dataset.scheduleView;
      state.monthlyLimit = 24;
      $$('[data-schedule-view]').forEach((b) => b.classList.toggle('is-active', b === btn));
      renderScheduleTable();
    });
  });

  $('#schedule-more').addEventListener('click', () => {
    state.monthlyLimit += 24;
    renderScheduleTable();
  });

  // 结清表行交互
  $('#payoff-table').addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-month]');
    if (!row) return;
    selectMonth(Number(row.dataset.month));
  });

  $('#payoff-table').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('tr[data-month]');
    if (!row) return;
    event.preventDefault();
    selectMonth(Number(row.dataset.month));
  });
}

function selectMonth(month) {
  state.selectedMonth = month;
  updatePayoffHighlight(highlightRefs, plan, month);
  renderPayoffTable($('#payoff-table'), plan.payoff, { selectedMonth: month });
}

/* ------------------------------------------------------------------ 启动 */

function init() {
  renderPresets();
  renderLprGrid();
  renderFundQuota();
  mountCardTools();
  bindEvents();
  // head 里的内联脚本已按系统偏好或 localStorage 设好主题，这里只同步按钮状态
  applyTheme(document.documentElement.dataset.theme || 'dark');
  $$('[data-term-preset]').forEach((b) => b.classList.toggle('is-active', b.dataset.termPreset === '30'));
  $$('[data-lpr-scenario]').forEach((b) => b.classList.toggle('is-active', b.dataset.lprScenario === 'flat'));
  updateRateHints();
  recompute({ animate: true });
}

init();
