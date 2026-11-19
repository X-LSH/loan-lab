/**
 * 浏览器冒烟测试：真实加载页面、操作表单、读回渲染结果。
 * 单测只覆盖算法，这里覆盖「算法算对了但界面没显示」这一类问题。
 *
 * 用法: node tools/smoke.mjs
 * 前置: 另开一个终端跑 node tools/serve.mjs（默认 8080）
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDP, sleep } from './cdp-lib.mjs';

const URL_UNDER_TEST = process.env.APP_URL ?? 'http://127.0.0.1:8080/index.html';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9345);
const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/LSH/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function launchBrowser() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'loanlab-'));
  const proc = spawn(
    CHROME,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,960',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return { proc, userDataDir };
    } catch {
      /* 还没起来 */
    }
    await sleep(100);
  }
  throw new Error('浏览器在 12 秒内未就绪');
}

const { proc, userDataDir } = await launchBrowser();
const cdp = await CDP.connectPage(DEBUG_PORT);

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.setViewport(1440, 960);

  const text = (selector) =>
    cdp.eval(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').trim()`);
  const count = (selector) => cdp.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const value = (selector) => cdp.eval(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
  const settle = async (ms = 380) => sleep(ms);

  /* ---------------------------------------------- 1. 首屏 */
  await cdp.navigate(URL_UNDER_TEST);
  await settle(950);

  check('页面标题正确', (await cdp.eval('document.title')).includes('房贷测算台'));
  check('无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.join(' | ') || '无');
  check('无控制台错误', cdp.consoleErrors.length === 0, cdp.consoleErrors.join(' | ') || '无');

  check('渲染 4 张指标卡', (await count('.kpi')) === 4);
  check('图例存在', (await count('.legend .legend-item')) === 2);

  const firstPayment = await text('.kpi:nth-child(2) .kpi-value .num');
  check('默认利率 3.05%（LPR−45BP）首月月供 4,243.05', firstPayment === '4,243.05', firstPayment);

  const totalInterest = await text('.kpi:nth-child(3) .kpi-value .num');
  check('默认利率下总利息 52.75 万', totalInterest === '52.75', totalInterest);

  // 切到 LPR 基准 3.50%，与公开房贷基准表对标
  await cdp.setInput('[data-rate="commercial"]', '3.5');
  await settle(480);
  const benchPayment = await text('.kpi:nth-child(2) .kpi-value .num');
  check('利率 3.50% 时首月月供 4,490.45（对标公开基准）', benchPayment === '4,490.45', benchPayment);
  check('利率 3.50% 时总利息 61.66 万', (await text('.kpi:nth-child(3) .kpi-value .num')) === '61.66');
  check('利率提示换算为 LPR 基准', (await text('[data-rate-hint="commercial"]')).includes('基准'));
  const termNote = await text('#total-amount-note');
  check('合计贷款金额换算正确', termNote.includes('100.00 万元'), termNote);

  check('五个图表已绘制（月供 / 构成 / 结清 / 月供对比 / 利息对比）',
    (await count('.chart-box svg')) === 5, String(await count('.chart-box svg')));

  /* ---------------------------------------------- 2. 还款计划 */
  check('年度表默认展开 30 行', (await count('#schedule-table tbody tr')) === 30);

  const firstYear = await cdp.eval(
    `document.querySelector('#schedule-table tbody tr')?.innerText.replace(/\\s+/g, ' ')`,
  );
  check('首年行包含本金与利息列', /第 1 年/.test(firstYear) && firstYear.split(' ').length >= 5, firstYear);

  await cdp.click('[data-schedule-view="month"]');
  await settle(200);
  check('逐月视图显示 24 期', (await count('#schedule-table tbody tr')) === 24);

  await cdp.click('#schedule-more');
  await settle(200);
  check('展开更多后显示 48 期', (await count('#schedule-table tbody tr')) === 48);
  check('展开按钮文案显示进度', (await text('#schedule-more')).includes('48 / 360'));

  await cdp.click('[data-schedule-view="year"]');
  await settle(200);
  check('切回年度视图恢复 30 行', (await count('#schedule-table tbody tr')) === 30);

  /* ---------------------------------------------- 3. 提前结清 */
  await cdp.click('.tab[data-tab="payoff"]');
  await settle(400);
  check('结清面板显示', await cdp.eval(`document.querySelector('[data-panel="payoff"]').classList.contains('is-active')`));
  check('结清表 30 行（不含第 0 行）', (await count('#payoff-table tbody tr')) === 30);

  const hlBefore = await text('#payoff-highlight [data-hl-title]');
  check('高亮卡默认停在第 10 年', hlBefore.includes('第 10 年'), hlBefore);

  const settleCash = await cdp.eval(
    `document.querySelectorAll('#payoff-highlight .hl-v')[0]?.innerText.trim()`,
  );
  check('结清当天现金已渲染为金额', /^[\d,]+\.\d{2}/.test(settleCash), settleCash);

  const outlay10 = await cdp.eval(
    `Number(document.querySelectorAll('#payoff-highlight .hl-v')[1]?.innerText.replace(/[^\\d.]/g, ''))`,
  );
  const outlayAll = Number(
    (await cdp.eval(
      `document.querySelectorAll('.kpi')[3].querySelector('.kpi-value .num').innerText.replace(/,/g, '')`,
    )) * 10000,
  );
  check('第 10 年结清的总支出低于还到期', outlay10 > 0 && outlay10 < outlayAll, `${outlay10} < ${outlayAll}`);

  // 点击表格第 5 行（第 5 年）
  await cdp.eval(`document.querySelectorAll('#payoff-table tbody tr')[4].click()`);
  await settle(250);
  const hlAfter = await text('#payoff-highlight [data-hl-title]');
  check('点击表格行后高亮卡切到第 5 年', hlAfter.includes('第 5 年'), hlAfter);
  check('选中的行有高亮样式', (await count('#payoff-table tbody tr.is-selected')) === 1);

  // 拖动滑块到最早一档
  await cdp.setRange('#payoff-highlight input[type="range"]', 12);
  await settle(250);
  check('滑块拖到 1 年后高亮卡同步', (await text('#payoff-highlight [data-hl-title]')).includes('第 1 年'));

  /* ---------------------------------------------- 4. 组合贷 */
  await cdp.click('.seg-btn[data-mode="combo"]');
  await settle(720);
  check('组合贷显示两个贷款块',
    (await cdp.eval(`!document.querySelector('[data-block="commercial"]').hidden && !document.querySelector('[data-block="fund"]').hidden`)));

  await cdp.setInput('[data-amount="commercial"]', '40');
  await cdp.setInput('[data-amount="fund"]', '60');
  await settle(500);

  check('组合贷总额为 100 万', (await text('.kpi:nth-child(1) .kpi-value .num')) === '100.00');
  check('显示两笔的占比拆解', (await count('#split-note .split-item')) === 2);
  const splitText = await text('#split-note');
  check('拆解条不含 NaN', !splitText.includes('NaN'), splitText.slice(0, 90));
  check('拆解条显示利率', /\d+(\.\d+)?%|逐年重定价/.test(splitText), splitText.slice(0, 90));

  const comboPayment = Number((await text('.kpi:nth-child(2) .kpi-value .num')).replace(/,/g, ''));
  check('组合贷月供低于纯商贷（公积金占比拉低）', comboPayment > 0 && comboPayment < 4490.45, String(comboPayment));

  // 分笔月供列只在逐月视图出现
  await cdp.click('.tab[data-tab="schedule"]');
  await settle(200);
  await cdp.click('[data-schedule-view="month"]');
  await settle(250);
  check('组合贷逐月表出现分笔月供列',
    await cdp.eval(`(() => {
      const ths = [...document.querySelectorAll('#schedule-table thead th')].map(t => t.innerText);
      return ths.filter(t => t.includes('月供')).length >= 3;
    })()`));
  check('逐月表 7 列（合计 + 两笔）',
    (await cdp.eval(`document.querySelectorAll('#schedule-table thead th').length`)) === 7);
  await cdp.click('[data-schedule-view="year"]');
  await settle(200);

  /* ---------------------------------------------- 5. 等额本金 */
  await cdp.click('.seg-btn[data-mode="commercial"]');
  await settle(560);
  await cdp.setInput('[data-amount="commercial"]', '100');
  await cdp.setInput('[data-rate="commercial"]', '3.5');
  await settle(480);
  await cdp.eval(`(() => {
    const el = document.querySelector('[data-method="commercial"]');
    el.value = 'equal-principal';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(480);

  const principalFirstText = await text('.kpi:nth-child(2) .kpi-value .num');
  const principalFirstNum = Number(principalFirstText.replace(/,/g, ''));
  check('等额本金首月月供 5,694.45（本金 2,777.78 + 利息 2,916.67）', principalFirstText === '5,694.45', principalFirstText);
  check('等额本金月供脚注提到末月', (await text('.kpi:nth-child(2) .kpi-foot')).includes('末月'));

  const interestEP = Number(await text('.kpi:nth-child(3) .kpi-value .num'));
  check('等额本金总利息低于等额本息', interestEP < 61.66, String(interestEP));

  /* ---------------------------------------------- 6. 方式对比 */
  await cdp.click('.tab[data-tab="compare"]');
  await settle(300);
  check('对比面板渲染两张卡', (await count('#compare-body .cmp-card')) === 2);
  check('对比给出结论句', (await text('#compare-body .cmp-verdict')).includes('少付利息'));

  /* ---------------------------------------------- 7. 期限与校验 */
  await cdp.setInput('[data-term]', '10');
  await settle(500);
  check('改为 10 年后首月月供上升', Number((await text('.kpi:nth-child(2) .kpi-value .num')).replace(/,/g, '')) > principalFirstNum);
  check('10 年总利息低于 30 年', Number(await text('.kpi:nth-child(3) .kpi-value .num')) < interestEP);

  await cdp.setInput('[data-amount="commercial"]', '0');
  await settle(450);
  check('金额为零时给出错误提示',
    await cdp.eval(`!document.querySelector('#form-error').hidden`),
    await text('#form-error'));

  await cdp.setInput('[data-amount="commercial"]', '100');
  await cdp.setInput('[data-term]', '30');
  await settle(450);
  check('修正输入后错误提示消失',
    await cdp.eval(`document.querySelector('#form-error').hidden`));

  /* ---------------------------------------------- 8. LPR 逐年重定价 */
  await cdp.click('.tab[data-tab="schedule"]');
  await settle(220);
  await cdp.eval(`(() => { document.querySelector('#lpr-section').open = true; })()`);
  await settle(160);

  await cdp.click('[data-lpr-enabled]');
  await settle(620);
  check('开启 LPR 重定价后商贷利率变为只读',
    await cdp.eval(`document.querySelector('[data-rate="commercial"]').readOnly`));
  check('利率提示显示 LPR + 加点',
    (await text('[data-rate-hint="commercial"]')).includes('LPR'),
    await text('[data-rate-hint="commercial"]'));
  check('逐年 LPR 编辑器按 30 年展开', (await count('[data-lpr-year]')) === 30);

  const interestBefore = Number(await text('.kpi:nth-child(3) .kpi-value .num'));
  await cdp.click('[data-lpr-scenario="down"]');
  await settle(720);
  const interestAfter = Number(await text('.kpi:nth-child(3) .kpi-value .num'));
  check('LPR 逐年下行后总利息下降', interestAfter < interestBefore,
    `${interestBefore} -> ${interestAfter}`);
  check('逐年摘要显示下行趋势',
    (await text('[data-lpr-summary]')).includes('下行'),
    await text('[data-lpr-summary]'));

  // 月供图出现重定价标记
  await settle(320);
  const markers = await count('#chart-payment .marker-text');
  check('月供图标出重定价位置', markers >= 2, `${markers} 个标记`);
  check('月供图副标题列出各段月供',
    (await text('#payment-chart-sub')).includes('起'),
    await text('#payment-chart-sub'));

  // 手动改某一格 LPR
  await cdp.setInput('[data-lpr-year="5"]', '2.20');
  await settle(520);
  check('手改 LPR 后该格高亮',
    await cdp.eval(`document.querySelectorAll('.lpr-cell.is-changed').length > 0`));
  check('手改 LPR 后摘要标记为自定义路径',
    (await text('[data-lpr-summary]')).includes('→') ||
    (await cdp.eval(`[...document.querySelectorAll('[data-lpr-scenario]')].every(b => !b.classList.contains('is-active'))`)));

  await cdp.click('[data-lpr-enabled]');
  await settle(520);
  check('关闭 LPR 重定价后利率恢复可写',
    await cdp.eval(`!document.querySelector('[data-rate="commercial"]').readOnly`));

  /* ---------------------------------------------- 9. 公积金额度约束 */
  await cdp.click('.seg-btn[data-mode="combo"]');
  await settle(720);
  await cdp.click('.tab[data-tab="schedule"]');
  await settle(240);

  const quotaText = await text('[data-quota-info]');
  check('青岛默认双缴存上限 130 万', quotaText.includes('130.00'), quotaText);

  await cdp.eval(`(() => {
    const el = document.querySelector('[data-fund-scope]');
    el.value = 'single';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(560);
  check('单缴存上限 90 万', (await text('[data-quota-info]')).includes('90.00'));

  await cdp.eval(`(() => {
    const el = document.querySelector('[data-fund-scope]');
    el.value = 'couple';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(560);
  await cdp.click('[data-uplift="multiChild"]');
  await settle(560);
  check('多子女上浮 30% 后为 169 万', (await text('[data-quota-info]')).includes('169.00'));

  await cdp.setInput('[data-amount="fund"]', '200');
  await settle(560);
  check('超限显示警告', await cdp.eval(`!document.querySelector('[data-quota-warning]').hidden`));
  check('警告内含一键裁剪按钮', (await count('[data-quota-clip]')) === 1);

  await cdp.click('[data-quota-clip]');
  await settle(620);
  check('裁剪后金额等于上限 169', (await value('[data-amount="fund"]')) === '169',
    String(await value('[data-amount="fund"]')));
  check('裁剪后警告消失', await cdp.eval(`document.querySelector('[data-quota-warning]').hidden`));

  await cdp.eval(`(() => {
    const el = document.querySelector('[data-fund-city]');
    el.value = 'shanghai';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(620);
  check('切到上海后上限 200 万', (await text('[data-quota-info]')).includes('200.00'));

  await cdp.eval(`(() => {
    const el = document.querySelector('[data-fund-city]');
    el.value = 'qingdao';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle(560);

  /* ---------------------------------------------- 10. 还款方式对比图 */
  await cdp.click('.tab[data-tab="compare"]');
  await settle(560);
  check('对比图各含两条曲线', await cdp.eval(`
    document.querySelectorAll('#chart-cmp-payment path').length === 2 &&
    document.querySelectorAll('#chart-cmp-interest path').length === 2
  `));
  check('对比图含省息面积填充', await cdp.eval(`
    document.querySelectorAll('#chart-cmp-payment polygon').length >= 1 &&
    document.querySelectorAll('#chart-cmp-interest polygon').length >= 1
  `));
  check('累计利息图标注终值', await cdp.eval(`
    [...document.querySelectorAll('#chart-cmp-interest text')].some(t => /万|\\d{3}/.test(t.textContent))
  `));

  /* ---------------------------------------------- 11. 主题切换 */
  const bgLight = await cdp.eval('getComputedStyle(document.body).backgroundColor');
  await cdp.click('[data-theme-set="dark"]');
  await settle(620);
  check('主题可切到深色', (await cdp.eval('document.documentElement.dataset.theme')) === 'dark');
  const bgDark = await cdp.eval('getComputedStyle(document.body).backgroundColor');
  check('深色主题改变了页面背景', bgDark !== bgLight, `${bgLight} -> ${bgDark}`);
  check('主题偏好写入 localStorage', (await cdp.eval(`localStorage.getItem('loanlab-theme')`)) === 'dark');
  check('图表使用渐变填充', await cdp.eval(`(() => {
    const bar = document.querySelector('.chart-box svg .bar-principal');
    return !!bar && (bar.getAttribute('fill') || '').startsWith('url(');
  })()`));
  check('渐变颜色由主题变量驱动', await cdp.eval(`(() => {
    const stop = document.querySelector('.chart-box svg .stop-p-top');
    return !!stop && getComputedStyle(stop).stopColor.startsWith('rgb');
  })()`));

  await cdp.click('[data-theme-set="light"]');
  await settle(620);
  check('主题可切回浅色', (await cdp.eval('document.documentElement.dataset.theme')) === 'light');

  await cdp.click('[data-theme-set="dark"]');
  await settle(620);
  check('主题切换后数值仍正确',
    (await text('.kpi:nth-child(2) .kpi-value .num')).length > 0);

  /* ---------------------------------------------- 12. 最终健康检查 */
  check('全程无未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.join(' | ') || '无');
  check('全程无控制台错误', cdp.consoleErrors.length === 0, cdp.consoleErrors.join(' | ') || '无');
  check('关键资源均已加载',
    ['styles/tokens.css', 'styles/base.css', 'styles/layout.css', 'styles/components.css', 'src/app.js']
      .every((p) => cdp.requests.some((u) => u.endsWith(p))),
    `${cdp.requests.length} 个请求`);

  await cdp.setViewport(1440, 960);
  await settle(300);
  const overflow = await cdp.eval(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  check('桌面端无横向溢出', overflow <= 1, `溢出 ${overflow}px`);

  await cdp.setViewport(390, 844);
  await settle(400);
  const mobileOverflow = await cdp.eval(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  );
  check('移动端无横向溢出', mobileOverflow <= 1, `溢出 ${mobileOverflow}px`);
  check('移动端隐藏顶部利率条',
    await cdp.eval(`getComputedStyle(document.querySelector('.baseline')).display === 'none'`));
  check('移动端输入面板不再吸顶',
    await cdp.eval(`getComputedStyle(document.querySelector('.panel-input')).position !== 'sticky'`));
} catch (error) {
  check('测试执行未抛出异常', false, error.message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} / ${results.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  }

  try {
    await cdp.send('Browser.close');
  } catch {
    /* 已断开 */
  }
  proc.kill();
  await sleep(300);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(failed.length ? 1 : 0);
}
