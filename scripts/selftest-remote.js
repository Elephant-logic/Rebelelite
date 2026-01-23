const { chromium } = require('playwright');

const target = process.argv[2] || 'https://rebelelite.onrender.com/selftest';

async function run() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  console.log(`[selftest] Target: ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => {
    const status = document.getElementById('selftestStatus')?.textContent || '';
    return (
      status.includes('All tests passed') ||
      status.includes('Complete') ||
      status.includes('Failed')
    );
  }, { timeout: 180000 });

  const status = await page.evaluate(
    () => document.getElementById('selftestStatus')?.textContent || ''
  );
  const results = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.selftest-result')).map((row) => ({
      name: row.querySelector('strong')?.textContent || '',
      status: row.querySelector('span')?.textContent || '',
      detail: row.querySelector('small')?.textContent || ''
    }))
  );

  console.log(`\nSelftest status: ${status}`);
  console.log('Results:');
  results.forEach((result) => {
    const line = `- ${result.status.padEnd(4)} ${result.name}` +
      (result.detail ? ` — ${result.detail}` : '');
    console.log(line);
  });

  const failures = results.filter((result) => result.status !== 'PASS');
  await browser.close();

  if (failures.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('[selftest] Failed to run remote selftest', err);
  process.exit(1);
});
