/**
 * 自绘 SVG 图表。零依赖，体积按需，便于离线与 GitHub Pages 部署。
 *
 * 约定：所有传入金额单位都是「分」，对外只负责画，不做业务计算。
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

function mount(container, svg, label) {
  container.replaceChildren(svg);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
}

/**
 * 年度本金 / 利息堆叠柱状图。
 * 等额本金呈现"本金柱等高等高、利息柱骤降"，等额本息则是"利息占大头并缓慢让位"。
 */
export function renderStackedBars(container, years) {
  const W = 840;
  const H = 260;
  const PAD = { top: 14, right: 14, bottom: 34, left: 62 };
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
  const barW = Math.max(Math.min(step * 0.6, 20), 2.5);

  // 网格与 Y 轴刻度
  for (let i = 0; i <= 4; i += 1) {
    const value = (yMax / 4) * i;
    const y = yOf(value);
    svg.append(
      node('line', {
        x1: PAD.left, y1: y, x2: W - PAD.right, y2: y,
        stroke: i === 0 ? '#ccd5e1' : '#edf1f6',
        'stroke-width': 1,
      }),
    );
    svg.append(
      text(axisLabel(value), {
        x: PAD.left - 9, y: y + 3.5,
        'text-anchor': 'end', 'font-size': 10.5, fill: '#7d899c',
      }),
    );
  }

  // 柱体
  years.forEach((year, index) => {
    const cx = PAD.left + step * index + step / 2;
    const x = cx - barW / 2;
    const total = year.principal + year.interest;

    const pTop = yOf(year.principal);
    const pBottom = yOf(0);
    svg.append(
      node('rect', {
        x, y: pTop, width: barW, height: Math.max(pBottom - pTop, 0),
        fill: '#4a8fe0', rx: 1.5,
      }),
    );

    const iTop = yOf(total);
    const iBottom = pTop;
    svg.append(
      node('rect', {
        x, y: iTop, width: barW, height: Math.max(iBottom - iTop, 0),
        fill: '#c98a3c', rx: 1.5,
      }),
    );

    const tip = node('title');
    tip.textContent = `第 ${year.year} 年｜本金 ${(year.principal / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元｜利息 ${(year.interest / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元`;
    const hit = node('rect', {
      x: cx - step / 2, y: PAD.top, width: step, height: innerH, fill: 'transparent',
    });
    hit.append(tip);
    svg.append(hit);

    // X 轴标签：年数多时隔几年标一次
    const every = years.length > 20 ? 5 : years.length > 12 ? 2 : 1;
    if ((index + 1) % every === 0 || index === 0) {
      svg.append(
        text(String(year.year), {
          x: cx, y: H - 12, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#7d899c',
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
  const H = 320;
  const PAD = { top: 18, right: 18, bottom: 36, left: 66 };
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

  // 网格
  for (let i = 0; i <= 4; i += 1) {
    const value = (yMax / 4) * i;
    const y = yOf(value);
    svg.append(
      node('line', {
        x1: PAD.left, y1: y, x2: W - PAD.right, y2: y,
        stroke: i === 0 ? '#ccd5e1' : '#edf1f6', 'stroke-width': 1,
      }),
    );
    svg.append(
      text(axisLabel(value), {
        x: PAD.left - 9, y: y + 3.5,
        'text-anchor': 'end', 'font-size': 10.5, fill: '#7d899c',
      }),
    );
  }

  // 省息面积：水平线（原计划）与结清曲线之间
  const areaTop = points.map((p) => `${xOf(p.month / 12)},${yOf(payoff.originalTotal)}`);
  const areaBottom = [...points].reverse().map((p) => `${xOf(p.month / 12)},${yOf(p.totalOutlay)}`);
  svg.append(
    node('polygon', {
      points: [...areaTop, ...areaBottom].join(' '),
      fill: '#2e8b63',
      'fill-opacity': 0.1,
      stroke: 'none',
    }),
  );

  // 原计划水平线
  svg.append(
    node('line', {
      x1: PAD.left, y1: yOf(payoff.originalTotal),
      x2: W - PAD.right, y2: yOf(payoff.originalTotal),
      stroke: '#4a8fe0', 'stroke-width': 2, 'stroke-dasharray': '6 4',
    }),
  );

  // 结清曲线
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.month / 12).toFixed(1)},${yOf(p.totalOutlay).toFixed(1)}`)
    .join(' ');
  svg.append(
    node('path', {
      d: linePath, fill: 'none', stroke: '#2e8b63',
      'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }),
  );

  // 采样点与悬浮提示
  points.forEach((p) => {
    const year = p.month / 12;
    const cx = xOf(year);
    const cy = yOf(p.totalOutlay);
    svg.append(node('circle', { cx, cy, r: 3.2, fill: '#fff', stroke: '#2e8b63', 'stroke-width': 2 }));
    const tip = node('title');
    tip.textContent = `第 ${year} 年结清｜全周期共花 ${(p.totalOutlay / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元｜省息 ${(p.savedInterest / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元`;
    const hit = node('circle', { cx, cy, r: 11, fill: 'transparent' });
    hit.append(tip);
    svg.append(hit);
  });

  // 免违约金起点标记
  const freePoint = points.find((p) => p.isPenaltyFree && p.month > 0);
  if (freePoint && payoff.penaltyRate > 0) {
    const fx = xOf(freePoint.month / 12);
    svg.append(
      node('line', {
        x1: fx, y1: PAD.top, x2: fx, y2: PAD.top + innerH,
        stroke: '#c98a3c', 'stroke-width': 1.2, 'stroke-dasharray': '3 3',
      }),
    );
    svg.append(
      text('免违约金', {
        x: fx + 5, y: PAD.top + 11, 'font-size': 10, fill: '#c98a3c',
      }),
    );
  }

  // 终点标注
  svg.append(
    text(`还到期 ${axisLabel(payoff.originalTotal)}`, {
      x: W - PAD.right - 2, y: yOf(payoff.originalTotal) - 8,
      'text-anchor': 'end', 'font-size': 10.5, fill: '#4a8fe0', 'font-weight': 600,
    }),
  );

  const last = points.at(-1);
  svg.append(
    node('circle', { cx: xOf(last.month / 12), cy: yOf(last.totalOutlay), r: 4, fill: '#2e8b63' }),
  );

  // X 轴刻度（单位「年」由卡片副标题承担，避免与起始 0 挤在一起）
  const tickEvery = totalYears > 20 ? 5 : totalYears > 10 ? 2 : 1;
  for (let y = 0; y <= totalYears; y += tickEvery) {
    svg.append(
      text(String(y), {
        x: xOf(y), y: H - 13, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#7d899c',
      }),
    );
  }

  mount(container, svg, '提前结清全周期总支出与不提前还款的对比曲线');
}
