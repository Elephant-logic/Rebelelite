const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');

const DEFAULT_SELFTEST_URL = 'https://rebelelite.onrender.com/selftest';
const LOCAL_SELFTEST_URL = 'http://127.0.0.1:9100/selftest';
const SELFTEST_URL = process.env.SELFTEST_URL || DEFAULT_SELFTEST_URL;

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canReach(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    return res.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer(url, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    if (await canReach(url, 2000)) return true;
    await wait(1000);
  }
  return false;
}

async function runSelftest(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  const context = await browser.newContext({
    permissions: ['camera', 'microphone']
  });
  const page = await context.newPage();
  const consoleLines = [];

  page.on('console', (msg) => {
    const line = `[browser:${msg.type()}] ${msg.text()}`;
    console.log(line);
    consoleLines.push(line);
  });

  page.on('pageerror', (error) => {
    const line = `[browser:error] ${error.message}`;
    console.error(line);
    consoleLines.push(line);
  });

  await page.goto(url, { waitUntil: 'networkidle' });

  await page.waitForFunction(() => {
    const finished = document.getElementById('selftestFinished');
    return finished && finished.textContent && finished.textContent.trim() !== '--';
  }, { timeout: 180000 });

  const report = await page.evaluate(() => {
    const status = document.getElementById('selftestStatus')?.textContent || '';
    const log = document.getElementById('selftestLog')?.textContent || '';
    const results = Array.from(document.querySelectorAll('#selftestResults .selftest-result')).map(
      (row) => {
        const name = row.querySelector('strong')?.textContent || '';
        const details = row.querySelector('small')?.textContent || '';
        const badge = row.querySelector('span')?.textContent || '';
        return { name, details, badge };
      }
    );
    return { status, log, results };
  });

  await browser.close();

  console.log('\n=== Selftest Results ===');
  for (const item of report.results) {
    console.log(`${item.badge} ${item.name}${item.details ? ` — ${item.details}` : ''}`);
  }
  if (report.log) {
    console.log('\n=== Selftest Log ===');
    console.log(report.log.trim());
  }

  const failed = report.results.filter((item) => item.badge !== 'PASS');
  if (failed.length || /failure|failed/i.test(report.status)) {
    const names = failed.map((item) => item.name).join(', ') || report.status;
    throw new Error(`Selftest failed: ${names}`);
  }
}

async function main() {
  let serverProcess = null;
  let targetUrl = SELFTEST_URL;

  if (!(await canReach(targetUrl))) {
    console.warn(`Unable to reach ${targetUrl}. Falling back to local server.`);
    targetUrl = LOCAL_SELFTEST_URL;
    serverProcess = spawn('node', ['server.js'], {
      stdio: 'inherit',
      env: { ...process.env, PORT: '9100' }
    });

    const ready = await waitForServer(targetUrl);
    if (!ready) {
      if (serverProcess) serverProcess.kill('SIGTERM');
      throw new Error(`Local server did not start for ${targetUrl}`);
    }
  }

  try {
    await runSelftest(targetUrl);
  } finally {
    if (serverProcess) serverProcess.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
