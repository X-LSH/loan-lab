/**
 * 自动化可访问性扫描：用 axe-core 按 WCAG 2.0 / 2.1 A+AA 规则检查页面。
 *
 * 人工对照 guide 能发现「规范没覆盖到的模式」，但人的检查容易漏。
 * axe 反过来：覆盖广、可重复、每次改动都能跑，适合做回归防线。
 *
 * 三套主题 × 三个 tab 全跑：隐藏的 tab panel 不会被扫描，
 * 只扫当前视图会漏掉三分之二的内容。
 *
 * 用法: node tools/a11y.mjs
 * 前置: 另开一个终端跑 node tools/serve.mjs
 * 退出码: 有违规时为 1，便于接入 CI
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDP, sleep } from './cdp-lib.mjs';

const URL_UNDER_TEST = process.env.APP_URL ?? 'http://127.0.0.1:8080/index.html';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9346);
const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/LSH/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe';

const THEMES = ['dark', 'light', 'xiaomi'];
const TABS = ['schedule', 'payoff', 'compare'];

async function launchBrowser() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'loanlab-a11y-'));
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

/** 扫描当前视图 */
function scan(cdp) {
  // 只跑 WCAG 正式标准；best-practice 规则噪声大，单独按需开启
  return cdp.eval(`axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    resultTypes: ['violations'],
  }).then((r) => r.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    count: v.nodes.length,
    targets: v.nodes.slice(0, 6).map((n) => {
      const d = n.any?.[0]?.data ?? {};
      // 用拼接而不是模板字符串：这段代码在浏览器里跑，
      // 模板里的 \${} 会被外层 eval 的字符串提前插值
      const ratio = d.contrastRatio != null ? d.contrastRatio + ':1' : '';
      const need = d.expectedContrastRatio ? '需 ' + d.expectedContrastRatio : '';
      return n.target.join(' ') + (ratio ? '  ' + ratio + ' ' + need : '');
    }),
  })))`);
}

const { proc, userDataDir } = await launchBrowser();
const cdp = await CDP.connectPage(DEBUG_PORT);

let totalViolations = 0;

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.setViewport(1440, 960);

  await cdp.navigate(URL_UNDER_TEST);
  await sleep(1100);

  const axeSource = await readFile('node_modules/axe-core/axe.min.js', 'utf8');
  await cdp.eval(axeSource);
  const injected = await cdp.eval(`typeof axe !== 'undefined' && !!axe.run`);
  if (!injected) throw new Error('axe-core 注入失败');
  console.log('axe-core 已注入\n');

  for (const theme of THEMES) {
    await cdp.eval(`document.querySelector('[data-theme-set="${theme}"]').click()`);
    await sleep(700);

    for (const tab of TABS) {
      await cdp.eval(`document.querySelector('[data-tab="${tab}"]').click()`);
      await sleep(700);

      const violations = await scan(cdp);
      const label = `${theme} / ${tab}`;

      if (violations.length === 0) {
        console.log(`PASS  ${label}  无违规`);
        continue;
      }

      totalViolations += violations.length;
      console.log(`FAIL  ${label}  ${violations.length} 类违规`);
      for (const v of violations) {
        console.log(`      [${v.impact}] ${v.id} — ${v.help} (${v.count} 处)`);
        for (const t of v.targets) console.log(`        · ${t}`);
      }
    }
  }
} finally {
  try {
    await cdp.send('Browser.close');
  } catch {
    proc.kill();
  }
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

console.log('');
if (totalViolations === 0) {
  console.log('全部通过：三套主题 × 三个视图，未发现 WCAG A/AA 违规');
  process.exit(0);
} else {
  console.log(`共 ${totalViolations} 类违规，需要修复`);
  process.exit(1);
}
