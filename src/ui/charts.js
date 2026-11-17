/**
 * 自绘 SVG 图表。零依赖，便于离线与静态托管。
 *
 * 颜色一律走 CSS 类（见 styles/components.css），不写死色值，
 * 这样深色 / 浅色主题切换时图表能跟着变，不需要重新计算。
 *
 * 约定：所有传入金额单位都是「分」，本层只负责画，不做业务计算。
 */

const NS = 'http://www.w3.org/2000/svg';

function node(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  return el;
}

function text(content, attrs = {}) {
  const el = node('text', attrs);
  el.textContent = content;
  return el;
}

/** 万元轴标签，按量级自动切换小数位 */
function axisLabel(cents) {
  if (cents === 0) return '0';
  const wan = cents / 100 / 10000;
  if (wan >= 10000) return `${(wan / 10000).toFixed(1)}亿`;
  if (wan >= 100) return `${Math.round(wan)}万`;
  if (wan >= 10) return `${wan.toFixed(0)}万`;
  return `${wan.toFixed(1)}万`;
}

/**
 * 让最大值向上对齐到「能被格数整除、且本身好看」的刻度。
 * 直接对总量取整会把 5.09 万抬到 10 万，柱子只剩半截；先对「每格值」取整再乘回去更贴合。
 */
const NICE_MULTIPLIERS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceScale(maxValue, ticks = 4) {
  if (maxValue <= 0) return 1;
  const rough = maxValue / ticks;
  const exp = Math.pow(10, Math.floor(Math.log10(rough)));
  const n = rough / exp;
  const mult = NICE_MULTIPLIERS.find((m) => n <= m) ?? 10;
  return mult * exp * ticks;
}

const money = (cents) =>
  (cents / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 });

function mount(container, svg, label) {
  container.replaceChildren(svg);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
}

/**
 * 年度本金 / 利息堆叠柱状图。
 * 等额本金呈现「本金柱等高、利息柱骤降」，等额本息则是「利息占大头并缓慢让位」。
 */
export function renderStackedBars(container, years) {
  const W = 840;
  const H = 262;
  const PAD = { top: 14, right: 14, bottom: 32, left: 58 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const maxRaw = Math.max(...years.map((y) => y.principal + y.interest));
  const yMax = niceScale(maxRaw);

  const yOf = (v) => PAD.top + innerH - (v / yMax) * innerH;
  const step = innerW / Math.max(years.length, 1);
  const barW = Math.max(Math.min(step * 0.58, 19), 2.5);

  for (let i = 0; i <= 4; i += 1) {
    const value = (yMax / 4) * i;
    const y = yOf(value);
    svg.append(
      node('line', {
        x1: PAD.left,
        y1: y,
        x2: W - PAD.right,
        y2: y,
        class: i === 0 ? 'grid-base' : 'grid-line',
        'stroke-width': 1,
      }),
    );
    svg.append(
      text(axisLabel(value), {
        x: PAD.left - 9,
        y: y + 3.5,
        'text-anchor': 'end',
        'font-size': 10.5,
        class: 'axis-text',
      }),
    );
  }

  years.forEach((year, index) => {
    const cx = PAD.left + step * index + step / 2;
    const x = cx - barW / 2;
    const total = year.principal + year.interest;

    const group = node('g', { class: 'bar-group' });

    const pTop = yOf(year.principal);
    group.append(
      node('rect', {
        x,
        y: pTop,
        width: barW,
        height: Math.max(yOf(0) - pTop, 0),
        rx: 1.5,
        class: 'bar-principal',
      }),
    );

    const iTop = yOf(total);
    group.append(
      node('rect', {
        x,
        y: iTop,
        width: barW,
        height: Math.max(pTop - iTop, 0),
        rx: 1.5,
        class: 'bar-interest',
      }),
    );

    const hit = node('rect', {
      x: cx - step / 2,
      y: PAD.top,
      width: step,
      height: innerH,
      fill: 'transparent',
    });
    hit.append(
      node('title'),
    );
    hit.firstChild.textContent = `第 ${year.year} 年｜本金 ${money(year.principal)} 元｜利息 ${money(year.interest)} 元`;
    group.append(hit);
    svg.append(group);

    const every = years.length > 20 ? 5 : years.length > 12 ? 2 : 1;
    if ((index + 1) % every === 0 || index === 0) {
      svg.append(
        text(String(year.year), {
          x: cx,
          y: H - 11,
          'text-anchor': 'middle',
          'font-size': 10.5,
          class: 'axis-text',
        }),
      );
    }
  });

  mount(container, svg, '每年度偿还本金与利息的堆叠柱状图');
}

/**
 * 提前结清双线图。
 *
 * 横轴：在第几年结清（0 表示放款即结清）
 * 纵轴：整个贷款周期一共花掉的钱
 *
 * 水平线 = 老老实实还到期。上升曲线 = 第 N 年结清。
 * 两者之间的填充面积，就是提前结清省下的利息（含违约金影响）。
 */
export function renderPayoffChart(container, payoff) {
  const points = payoff.points;
  const W = 840;
  const H = 316;
  const PAD = { top: 18, right: 18, bottom: 34, left: 62 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const totalYears = points.at(-1).month / 12;
  const yMax = niceScale(payoff.originalTotal);
  const xOf = (year) => PAD.left + (year / totalYears) * innerW;
  const yOf = (v) => PAD.top + innerH - (v / yMax) * innerH;

  for (let i = 0; i <= 4; i += 1) {
    const value = (yMax / 4) * i;
    const y = yOf(value);
    svg.append(
      node('line', {
        x1: PAD.left,
        y1: y,
        x2: W - PAD.right,
        y2: y,
        class: i === 0 ? 'grid-base' : 'grid-line',
        'stroke-width': 1,
      }),
    );
    svg.append(
      text(axisLabel(value), {
        x: PAD.left - 9,
        y: y + 3.5,
        'text-anchor': 'end',
        'font-size': 10.5,
        class: 'axis-text',
      }),
    );
  }

  // 省息面积：水平线（原计划）与结清曲线之间
  const areaTop = points.map((p) => `${xOf(p.month / 12)},${yOf(payoff.originalTotal)}`);
  const areaBottom = [...points]
    .reverse()
    .map((p) => `${xOf(p.month / 12)},${yOf(p.totalOutlay)}`);
  svg.append(
    node('polygon', {
      points: [...areaTop, ...areaBottom].join(' '),
      class: 'area-saved',
    }),
  );

  // 原计划水平线
  svg.append(
    node('line', {
      x1: PAD.left,
      y1: yOf(payoff.originalTotal),
      x2: W - PAD.right,
      y2: yOf(payoff.originalTotal),
      class: 'line-plan',
      'stroke-width': 2,
      'stroke-dasharray': '6 4',
    }),
  );

  // 结清曲线
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.month / 12).toFixed(1)},${yOf(p.totalOutlay).toFixed(1)}`)
    .join(' ');
  svg.append(
    node('path', {
      d: linePath,
      fill: 'none',
      class: 'line-settle',
      'stroke-width': 2.2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  // 采样点与悬浮提示
  points.forEach((p) => {
    const year = p.month / 12;
    const cx = xOf(year);
    const cy = yOf(p.totalOutlay);
    const group = node('g', { class: 'point-group' });
    group.append(node('circle', { cx, cy, r: 3.2, class: 'dot-settle', 'stroke-width': 2 }));
    const hit = node('circle', { cx, cy, r: 11, fill: 'transparent' });
    const tip = node('title');
    tip.textContent = `第 ${year} 年结清｜全周期共花 ${money(p.totalOutlay)} 元｜省息 ${money(p.savedInterest)} 元`;
    hit.append(tip);
    group.append(hit);
    svg.append(group);
  });

  // 免违约金起点标记
  const freePoint = points.find((p) => p.isPenaltyFree && p.month > 0);
  if (freePoint && payoff.penaltyRate > 0) {
    const fx = xOf(freePoint.month / 12);
    svg.append(
      node('line', {
        x1: fx,
        y1: PAD.top,
        x2: fx,
        y2: PAD.top + innerH,
        class: 'marker-line',
        'stroke-width': 1.2,
        'stroke-dasharray': '3 3',
      }),
    );
    svg.append(
      text('免违约金', {
        x: fx + 5,
        y: PAD.top + 11,
        'font-size': 10,
        class: 'marker-text',
      }),
    );
  }

  // 终点标注
  svg.append(
    text(`还到期 ${axisLabel(payoff.originalTotal)}`, {
      x: W - PAD.right - 2,
      y: yOf(payoff.originalTotal) - 9,
      'text-anchor': 'end',
      'font-size': 10.5,
      class: 'label-plan',
      'font-weight': 600,
    }),
  );

  const last = points.at(-1);
  svg.append(
    node('circle', { cx: xOf(last.month / 12), cy: yOf(last.totalOutlay), r: 4, class: 'dot-end' }),
  );

  // X 轴刻度（单位「年」由卡片副标题承担，避免与起始 0 挤在一起）
  const tickEvery = totalYears > 20 ? 5 : totalYears > 10 ? 2 : 1;
  for (let y = 0; y <= totalYears; y += tickEvery) {
    svg.append(
      text(String(y), {
        x: xOf(y),
        y: H - 12,
        'text-anchor': 'middle',
        'font-size': 10.5,
        class: 'axis-text',
      }),
    );
  }

  mount(container, svg, '提前结清全周期总支出与不提前还款的对比曲线');
}
