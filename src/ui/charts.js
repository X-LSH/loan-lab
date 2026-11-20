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
  if (wan >= 1) return `${wan.toFixed(1)}万`;
  // 月供这类量级用「万」会全部糊成 0.3万，改用元
  return Math.round(cents / 100).toLocaleString('zh-CN');
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
 * 注册一条垂直渐变。stop 颜色交给 CSS 类控制，这样主题切换时
 * 渐变会跟着变，不需要重新计算。
 */
function attachGradient(svg, id, { classTop, classBottom }) {
  if (!svg.querySelector(`#${id}`)) {
    const defs = svg.querySelector('defs') ?? node('defs');
    const grad = node('linearGradient', { id, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(node('stop', { offset: '0%', class: classTop }));
    grad.append(node('stop', { offset: '100%', class: classBottom }));
    defs.append(grad);
    if (!defs.parentNode) svg.prepend(defs);
  }
  return `url(#${id})`;
}

/**
 * 年度本金 / 利息堆叠柱状图。
 * 等额本金呈现「本金柱等高、利息柱骤降」，等额本息则是「利息占大头并缓慢让位」。
 *
 * @param {'stack'|'percent'} [mode] stack = 绝对值；percent = 100% 堆叠，看占比变化
 */
export function renderStackedBars(container, years, mode = 'stack') {
  const W = 840;
  const H = 262;
  const PAD = { top: 14, right: 14, bottom: 32, left: 58 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const isPercent = mode === 'percent';

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  // 柱子用渐变：Apple Charts 的质感来自色块的渐隐，不是纯色块
  const fillP = attachGradient(svg, 'grad-comp-p', {
    classTop: 'stop-p-top',
    classBottom: 'stop-p-bottom',
  });
  const fillI = attachGradient(svg, 'grad-comp-i', {
    classTop: 'stop-i-top',
    classBottom: 'stop-i-bottom',
  });

  const maxRaw = Math.max(...years.map((y) => y.principal + y.interest));
  const yMax = isPercent ? 100 : niceScale(maxRaw);

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
      text(isPercent ? `${Math.round(value)}%` : axisLabel(value), {
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
    // 百分比模式下每根柱子等高，只看本金/利息的占比变化
    const pVal = isPercent ? (year.principal / total) * 100 : year.principal;
    const totalVal = isPercent ? 100 : total;

    const group = node('g', { class: 'bar-group' });

    const pTop = yOf(pVal);
    group.append(
      node('rect', {
        x,
        y: pTop,
        width: barW,
        height: Math.max(yOf(0) - pTop, 0),
        rx: 3,
        fill: fillP,
        class: 'bar-principal',
      }),
    );

    const iTop = yOf(totalVal);
    group.append(
      node('rect', {
        x,
        y: iTop,
        width: barW,
        height: Math.max(pTop - iTop, 0),
        rx: 3,
        fill: fillI,
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
 * 月供变化曲线。
 *
 * 重定价会让月供出现台阶（等额本息）或斜率转折（等额本金）。
 * 纵轴按实际月供范围放缩，不是从 0 起——否则几十块的跳变在百万级月供上看不出来，
 * 副标题里会写明这一点，避免误导。
 */
export function renderPaymentChart(container, rows, rateChanges, mode = 'line') {
  const W = 840;
  const H = 216;
  const PAD = { top: 16, right: 16, bottom: 30, left: 60 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const svg = node('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });

  const pays = rows.map((r) => r.payment);
  const rawMin = Math.min(...pays);
  const rawMax = Math.max(...pays);
  // 月供几乎不变时纵轴从 0 起更诚实：平线落在顶部，能对照月供占贷款额的比例。
  // 只有重定价造成明显台阶时才放缩纵轴，否则窄区间会把噪声放大成"变化"。
  const relativeSpan = rawMax > 0 ? (rawMax - rawMin) / rawMax : 0;
  const scaled = relativeSpan >= 0.02;
  const yMin = scaled ? Math.max(rawMin - (rawMax - rawMin) * 0.4, 0) : 0;
  const yMax = scaled ? rawMax + (rawMax - rawMin) * 0.4 : niceScale(rawMax);

  const n = rows.length;
  const xOf = (period) => PAD.left + ((period - 1) / Math.max(n - 1, 1)) * innerW;
  const yOf = (v) => PAD.top + innerH - ((v - yMin) / Math.max(yMax - yMin, 1)) * innerH;

  for (let i = 0; i <= 3; i += 1) {
    const value = yMin + ((yMax - yMin) / 3) * i;
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

  // 月供曲线
  const path = rows
    .map((r, i) => `${i === 0 ? 'M' : 'L'}${xOf(r.period).toFixed(1)},${yOf(r.payment).toFixed(1)}`)
    .join(' ');

  if (mode === 'area') {
    const fillArea = attachGradient(svg, 'grad-pay-area', {
      classTop: 'stop-accent-top',
      classBottom: 'stop-accent-bottom',
    });
    const areaD =
      `${path} L ${xOf(rows.at(-1).period).toFixed(1)},${yOf(yMin).toFixed(1)}` +
      ` L ${xOf(rows[0].period).toFixed(1)},${yOf(yMin).toFixed(1)} Z`;
    svg.append(node('path', { d: areaD, fill: fillArea, class: 'area-pay' }));
  }

  svg.append(
    node('path', {
      d: path,
      fill: 'none',
      class: 'line-payment',
      'stroke-width': 2,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }),
  );

  // 重定价竖线。rateChanges 由计算层给出，只含利率真正变化的时点——
  // 等额本金的月供每期都变，若每年都画竖线会把图糊住。
  const repricePoints = rateChanges.slice(1);
  let lastLabelRight = -Infinity;
  repricePoints.forEach((change, idx) => {
    const x = xOf(change.period);
    svg.append(
      node('line', {
        x1: x,
        y1: PAD.top,
        x2: x,
        y2: PAD.top + innerH,
        class: 'marker-line',
        'stroke-width': 1.2,
        'stroke-dasharray': '3 3',
      }),
    );
    svg.append(
      node('circle', { cx: x, cy: yOf(change.monthly), r: 3, class: 'dot-end' }),
    );

    // 标签密度控制：点太密时只标一部分，竖线仍在，信息不丢；
    // 再用上下交错降低叠字概率。文案只留利率数字，"重定价"三个字留给图例。
    const rateLabel = change.rates.map((r) => `${(r * 100).toFixed(2)}%`).join('/');
    const estimatedWidth = rateLabel.length * 5.4 + 10;
    const labelX = x + 4;
    if (labelX - lastLabelRight < 6) return;

    const y = PAD.top + 11 + (idx % 2) * 12.5;
    svg.append(
      text(rateLabel, {
        x: labelX,
        y,
        'font-size': 9.5,
        class: 'marker-text',
      }),
    );
    lastLabelRight = labelX + estimatedWidth;
  });

  // X 轴：年
  const totalYears = Math.ceil(n / 12);
  const tickEvery = totalYears > 20 ? 5 : totalYears > 10 ? 2 : 1;
  for (let y = 0; y <= totalYears; y += tickEvery) {
    const period = y === 0 ? 1 : Math.min(y * 12, n);
    svg.append(
      text(String(y), {
        x: xOf(period),
        y: H - 11,
        'text-anchor': 'middle',
        'font-size': 10.5,
        class: 'axis-text',
      }),
    );
  }

  mount(container, svg, '月供随时间变化的曲线，标出每次重定价的位置');
}

/** 期数序列 -> 金额序列的前缀和（累计已付利息） */
function cumulativeInterest(rows) {
  const out = [];
  let sum = 0;
  for (const r of rows) {
    sum += r.interest;
    out.push(sum);
  }
  return out;
}

function buildAxes(svg, { n, yMin, yMax, PAD, W, H, xOf, yOf, gridClass = 'grid-line' }) {
  for (let i = 0; i <= 3; i += 1) {
    const value = yMin + ((yMax - yMin) / 3) * i;
    const y = yOf(value);
    svg.append(
      node('line', {
        x1: PAD.left, y1: y, x2: W - PAD.right, y2: y,
        class: i === 0 ? 'grid-base' : gridClass, 'stroke-width': 1,
      }),
    );
    svg.append(
      text(axisLabel(value), {
        x: PAD.left - 9, y: y + 3.5,
        'text-anchor': 'end', 'font-size': 10.5, class: 'axis-text',
      }),
    );
  }

  const totalYears = Math.ceil(n / 12);
  const tickEvery = totalYears > 20 ? 5 : totalYears > 10 ? 2 : 1;
  for (let y = 0; y <= totalYears; y += tickEvery) {
    const period = y === 0 ? 1 : Math.min(y * 12, n);
    svg.append(
      text(String(y), {
        x: xOf(period), y: H - 11,
        'text-anchor': 'middle', 'font-size': 10.5, class: 'axis-text',
      }),
    );
  }
}

function linePath(values, xOf, yOf) {
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i + 1).toFixed(1)},${yOf(v).toFixed(1)}`)
    .join(' ');
}

function areaBetween(valuesTop, valuesBottom, xOf, yOf) {
  const top = valuesTop.map((v, i) => `${xOf(i + 1).toFixed(1)},${yOf(v).toFixed(1)}`);
  // map 已产生新数组，无需再浅拷贝；toReversed 也不会修改原数组
  const bottom = valuesBottom
    .map((v, i) => [i, v])
    .toReversed()
    .map(([i, v]) => `${xOf(i + 1).toFixed(1)},${yOf(v).toFixed(1)}`);
  return [...top, ...bottom].join(' ');
}

/**
 * 月供压力对比：等额本息是平线，等额本金是斜坡。
 * 两线之间的开口 = 前期要多扛的现金压力。
 */
export function renderPaymentCompareChart(container, rowsA, rowsB) {
  const W = 760;
  const H = 250;
  const PAD = { top: 16, right: 18, bottom: 30, left: 60 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  const fillSaved = attachGradient(svg, 'grad-cmp-pay', {
    classTop: 'stop-saved-top',
    classBottom: 'stop-saved-bottom',
  });

  const paysA = rowsA.map((r) => r.payment);
  const paysB = rowsB.map((r) => r.payment);
  const all = [...paysA, ...paysB];
  const rawMin = Math.min(...all);
  const rawMax = Math.max(...all);
  const span = Math.max(rawMax - rawMin, rawMax * 0.02);
  const yMin = Math.max(rawMin - span * 0.35, 0);
  const yMax = rawMax + span * 0.35;

  const n = Math.max(rowsA.length, rowsB.length);
  const xOf = (period) => PAD.left + ((period - 1) / Math.max(n - 1, 1)) * innerW;
  const yOf = (v) => PAD.top + innerH - ((v - yMin) / Math.max(yMax - yMin, 1)) * innerH;

  buildAxes(svg, { n, yMin, yMax, PAD, W, H, xOf, yOf });

  // 压力差：等额本金在下方，两线之间的面积是「省下的月供」
  svg.append(
    node('polygon', {
      points: areaBetween(paysA, paysB, xOf, yOf),
      fill: fillSaved,
      class: 'area-saved',
    }),
  );

  svg.append(
    node('path', {
      d: linePath(paysA, xOf, yOf), fill: 'none', class: 'line-plan',
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': '5 3',
    }),
  );
  svg.append(
    node('path', {
      d: linePath(paysB, xOf, yOf), fill: 'none', class: 'line-settle',
      'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }),
  );

  // 图例放在右上角，左上角留给 Y 轴刻度，避免挤成一团
  const legendY = PAD.top + 8;
  const rightEdge = W - PAD.right;
  svg.append(text('等额本金', {
    x: rightEdge, y: legendY + 3.5, 'text-anchor': 'end', 'font-size': 10.5, class: 'axis-text',
  }));
  svg.append(node('line', {
    x1: rightEdge - 52, y1: legendY, x2: rightEdge - 36, y2: legendY,
    class: 'line-settle', 'stroke-width': 2.2,
  }));
  svg.append(text('等额本息', {
    x: rightEdge - 80, y: legendY + 3.5, 'text-anchor': 'end', 'font-size': 10.5, class: 'axis-text',
  }));
  svg.append(node('line', {
    x1: rightEdge - 134, y1: legendY, x2: rightEdge - 118, y2: legendY,
    class: 'line-plan', 'stroke-width': 2, 'stroke-dasharray': '5 3',
  }));

  mount(container, svg, '两种还款方式的月供随时间变化对比');
}

/**
 * 累计已付利息对比：两条曲线之间的面积就是等额本金省下的利息。
 * 纵轴从 0 起，因为这是累计值，截断会夸大差距。
 */
export function renderInterestCompareChart(container, rowsA, rowsB) {
  const W = 760;
  const H = 250;
  const PAD = { top: 16, right: 18, bottom: 30, left: 60 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const svg = node('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  const fillSaved = attachGradient(svg, 'grad-cmp-int', {
    classTop: 'stop-saved-top',
    classBottom: 'stop-saved-bottom',
  });

  const intA = cumulativeInterest(rowsA);
  const intB = cumulativeInterest(rowsB);
  const yMax = niceScale(Math.max(intA.at(-1), intB.at(-1)));

  const n = Math.max(rowsA.length, rowsB.length);
  const xOf = (period) => PAD.left + ((period - 1) / Math.max(n - 1, 1)) * innerW;
  const yOf = (v) => PAD.top + innerH - (v / yMax) * innerH;

  buildAxes(svg, { n, yMin: 0, yMax, PAD, W, H, xOf, yOf });

  // 省息面积
  svg.append(
    node('polygon', {
      points: areaBetween(intA, intB, xOf, yOf),
      fill: fillSaved,
      class: 'area-saved',
    }),
  );

  svg.append(
    node('path', {
      d: linePath(intA, xOf, yOf), fill: 'none', class: 'line-plan',
      'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': '5 3',
    }),
  );
  svg.append(
    node('path', {
      d: linePath(intB, xOf, yOf), fill: 'none', class: 'line-settle',
      'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }),
  );

  // 终点标注：两条线各自累计利息
  svg.append(
    text(axisLabel(intA.at(-1)), {
      x: xOf(n) - 4, y: yOf(intA.at(-1)) - 8,
      'text-anchor': 'end', 'font-size': 10.5, class: 'label-plan', 'font-weight': 600,
    }),
  );
  svg.append(
    text(axisLabel(intB.at(-1)), {
      x: xOf(n) - 4, y: yOf(intB.at(-1)) + 15,
      'text-anchor': 'end', 'font-size': 10.5, class: 'marker-text', 'font-weight': 600,
    }),
  );

  // 图例与月供图保持一致
  const legendY = PAD.top + 8;
  const rightEdge = W - PAD.right;
  svg.append(text('等额本金', {
    x: rightEdge, y: legendY + 3.5, 'text-anchor': 'end', 'font-size': 10.5, class: 'axis-text',
  }));
  svg.append(node('line', {
    x1: rightEdge - 52, y1: legendY, x2: rightEdge - 36, y2: legendY,
    class: 'line-settle', 'stroke-width': 2.2,
  }));
  svg.append(text('等额本息', {
    x: rightEdge - 80, y: legendY + 3.5, 'text-anchor': 'end', 'font-size': 10.5, class: 'axis-text',
  }));
  svg.append(node('line', {
    x1: rightEdge - 134, y1: legendY, x2: rightEdge - 118, y2: legendY,
    class: 'line-plan', 'stroke-width': 2, 'stroke-dasharray': '5 3',
  }));

  mount(container, svg, '两种还款方式的累计已付利息对比');
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

  const fillSaved = attachGradient(svg, 'grad-payoff-saved', {
    classTop: 'stop-saved-top',
    classBottom: 'stop-saved-bottom',
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
  const areaBottom = points
    .toReversed()
    .map((p) => `${xOf(p.month / 12)},${yOf(p.totalOutlay)}`);
  svg.append(
    node('polygon', {
      points: [...areaTop, ...areaBottom].join(' '),
      fill: fillSaved,
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
