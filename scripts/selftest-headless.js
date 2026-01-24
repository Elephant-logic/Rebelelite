const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const SERVER_URL = 'http://127.0.0.1:9100/selftest';

function waitForServerOutput(proc, matcher, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onData = (data) => {
      const text = data.toString();
      if (matcher.test(text)) {
        cleanup();
        resolve();
      }
    };
    const onExit = () => {
      cleanup();
      reject(new Error('Server exited before ready.'));
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      proc.off('exit', onExit);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for server readiness.'));
    }, timeoutMs);
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', onExit);
  });
}

async function run() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServerOutput(server, /Rebel Secure Server running/);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(SERVER_URL, { waitUntil: 'networkidle' });

    await page.waitForFunction(() => {
      const status = document.getElementById('selftestStatus');
      return status && /All tests passed|Complete with/.test(status.textContent || '');
    }, { timeout: 60000 });

    const statusText = await page.textContent('#selftestStatus');
    await browser.close();

    if (statusText && statusText.includes('failure')) {
      throw new Error(`Selftest failed: ${statusText}`);
    }
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
