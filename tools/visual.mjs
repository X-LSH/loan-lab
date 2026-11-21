/**
 * 视觉回归基线：采集关键元素的几何尺寸与关键样式，与基线比对。
 *
 * 为什么不用像素比对：
 *   字体渲染、抗锯齿、子像素定位在不同机器/不同次运行间都有微小差异，
 *   像素 diff 会持续误报，最后没人看。结构化快照只比对「真正会被改坏的东西」：
 *   宽高是否变了、颜色是否变了、字号是否变了。
 *
 * 用法:
 *   node tools/visual.mjs            # 与基线比对
 *   node tools/visual.mjs --update   # 重建基线（改动是预期内的时候）
 * 前置: 另开一个终端跑 node tools/serve.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDP, sleep } from './cdp-lib.mjs';

const URL_UNDER_TEST = process.env.APP_URL ?? 'http://127.0.0.1:8080/index.html';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9347);
const BASELINE_PATH = 'tools/visual-baseline.json';
const UPDATE = process.argv.includes('--update');
const THEMES = ['dark', 'light', 'xiaomi', 'voucher'];
const TOLERANCE_PX = 2;

const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/LSH/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe';

/** 采集：只取有稳定语义的量，取整避免亚像素抖动 */
const SNAPSHOT = `(() => {
  const sels = [
    '.topbar', '.brand', '.panel-input', '.results',
    '.kpi', '.card', '.tab', '.chart-box', '.seg-btn', '.input', '.data-table',
  ];
  const out = {};
  for (const sel of sels) {
    const nodes = document.querySelectorAll(sel);
    nodes.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // 隐藏视图跳过
      const cs = getComputedStyle(el);
      out[sel + '[' + i + ']'] = {
        w: Math.round(r.width),
        h: Math.round(r.height),
        fs: cs.fontSize,
        color: cs.color,
        bg: cs.backgroundColor,
      };
    });
  }
  const root = getComputedStyle(document.documentElement);
  out['::root'] = {
    scheme: root.colorScheme,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  };
  return out;
})()`;

async function launchBrowser() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'loanlab-visual-'));
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
const current = {};

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.setViewport(1440, 960);

  await cdp.navigate(URL_UNDER_TEST);
  await sleep(1100);

  for (const theme of THEMES) {
    await cdp.eval(`document.querySelector('[data-theme-set="${theme}"]').click()`);
    await sleep(700);
    current[theme] = await cdp.eval(SNAPSHOT);
  }
} finally {
  try {
    await cdp.send('Browser.close');
  } catch {
    proc.kill();
  }
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}

/* ---------------- 更新基线 ---------------- */
if (UPDATE) {
  await writeFile(BASELINE_PATH, JSON.stringify(current, null, 2));
  const total = Object.values(current).reduce((s, t) => s + Object.keys(t).length, 0);
  console.log(`基线已更新：${BASELINE_PATH}（${THEMES.length} 套主题，共 ${total} 个元素快照）`);
  process.exit(0);
}

/* ---------------- 比对 ---------------- */
let baseline;
try {
  baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
} catch {
  console.log(`未找到基线 ${BASELINE_PATH}，先运行 node tools/visual.mjs --update`);
  process.exit(1);
}

const diffs = [];

for (const theme of THEMES) {
  const base = baseline[theme] ?? {};
  const cur = current[theme] ?? {};
  let themeDiffs = 0;

  for (const [key, b] of Object.entries(base)) {
    const c = cur[key];
    if (!c) {
      diffs.push(`${theme} ${key}  元素消失`);
      themeDiffs += 1;
      continue;
    }
    if (Math.abs(b.w - c.w) > TOLERANCE_PX) {
      diffs.push(`${theme} ${key}  宽度 ${b.w} → ${c.w}px`);
      themeDiffs += 1;
    }
    if (Math.abs(b.h - c.h) > TOLERANCE_PX) {
      diffs.push(`${theme} ${key}  高度 ${b.h} → ${c.h}px`);
      themeDiffs += 1;
    }
    if (b.fs !== c.fs) {
      diffs.push(`${theme} ${key}  字号 ${b.fs} → ${c.fs}`);
      themeDiffs += 1;
    }
    if (b.color !== c.color) {
      diffs.push(`${theme} ${key}  文字色 ${b.color} → ${c.color}`);
      themeDiffs += 1;
    }
    if (b.bg !== c.bg) {
      diffs.push(`${theme} ${key}  背景色 ${b.bg} → ${c.bg}`);
      themeDiffs += 1;
    }
  }

  // 新增元素也值得关注（可能是布局溢出或意外插入）
  for (const key of Object.keys(cur)) {
    if (!base[key]) {
      diffs.push(`${theme} ${key}  新增元素（基线中不存在）`);
      themeDiffs += 1;
    }
  }

  const scheme = cur['::root']?.scheme ?? '?';
  console.log(`${themeDiffs === 0 ? 'PASS' : 'FAIL'}  ${theme}  (color-scheme: ${scheme})`);
}

console.log('');
if (diffs.length === 0) {
  console.log(`视觉基线一致：${THEMES.length} 套主题的尺寸、字号、颜色均未漂移`);
  process.exit(0);
}

console.log(`发现 ${diffs.length} 处差异：`);
diffs.slice(0, 30).forEach((d) => console.log(`  · ${d}`));
if (diffs.length > 30) console.log(`  ... 另有 ${diffs.length - 30} 处`);
console.log('\n如果这些变化是预期的，运行 node tools/visual.mjs --update 更新基线');
process.exit(1);
