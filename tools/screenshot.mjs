/**
 * 截图工具：把关键状态渲染成 PNG，便于人工与评审核对。
 * 用法: node tools/screenshot.mjs   （需先启动 tools/serve.mjs）
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CDP, sleep } from './cdp-lib.mjs';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:8080/index.html';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 9346);
const OUT_DIR = resolve('docs/screenshots');
const CHROME =
  process.env.CHROME_PATH ??
  'C:/Users/LSH/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe';

const userDataDir = await mkdtemp(join(tmpdir(), 'loanlab-shot-'));
const proc = spawn(
  CHROME,
  [
    '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1440,1000', 'about:blank',
  ],
  { stdio: 'ignore' },
);

for (let i = 0; i < 120; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok) break;
  } catch {
    /* 等待 */
  }
  await sleep(100);
}

const cdp = await CDP.connectPage(DEBUG_PORT);
await mkdir(OUT_DIR, { recursive: true });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

async function shot(name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(OUT_DIR, name), Buffer.from(data, 'base64'));
  console.log(`已保存 ${name}`);
}

const setMethod = (kind, method) =>
  cdp.eval(`(() => {
    const el = document.querySelector('[data-method="${kind}"]');
    el.value = '${method}';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

try {
  await cdp.setViewport(1440, 1000);
  await cdp.navigate(APP_URL);
  await sleep(700);
  await shot('01-overview.png');

  await cdp.click('.tab[data-tab="payoff"]');
  await sleep(500);
  await shot('02-payoff.png');

  await cdp.click('.tab[data-tab="compare"]');
  await sleep(400);
  await shot('03-compare.png');

  await cdp.click('.tab[data-tab="schedule"]');
  await cdp.click('.seg-btn[data-mode="combo"]');
  await sleep(600);
  await cdp.setInput('[data-amount="commercial"]', '40');
  await sleep(500);
  await shot('04-combo.png');

  await cdp.click('.seg-btn[data-mode="commercial"]');
  await sleep(300);
  await cdp.setInput('[data-amount="commercial"]', '100');
  await setMethod('commercial', 'equal-principal');
  await sleep(600);
  await cdp.click('[data-schedule-view="month"]');
  await sleep(400);
  await shot('05-equal-principal-monthly.png');

  await cdp.setViewport(390, 844);
  await sleep(600);
  await cdp.navigate(APP_URL);
  await sleep(700);
  await shot('06-mobile.png');
} finally {
  try {
    await cdp.send('Browser.close');
  } catch {
    /* 忽略 */
  }
  proc.kill();
  await sleep(300);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
