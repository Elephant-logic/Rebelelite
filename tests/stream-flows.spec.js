const { test, expect } = require('@playwright/test');

function uniqueRoom(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function setupHost(page, room, { password } = {}) {
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getDisplayMedia = () =>
        navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
  });

  if (password) {
    await page.goto('/');
    await page.fill('#claimRoomName', room);
    await page.fill('#claimRoomPassword', password);
    await page.click('#claimRoomForm button[type="submit"]');
    await page.waitForURL(/index\.html/);
  } else {
    await page.goto(`/index.html?room=${encodeURIComponent(room)}&role=host`);
  }

  await expect(page.locator('#joinBtn')).toBeDisabled();
  await expect(page.locator('#signalStatus')).toHaveText('Connected');
}

async function joinViewer(page, room, { name = 'Viewer', vipCode } = {}) {
  await page.addInitScript(() => {
    window.confirm = () => true;
  });

  await page.goto(`/view.html?room=${encodeURIComponent(room)}`);
  await page.fill('#viewerNameInput', name);
  if (vipCode) {
    await page.fill('#viewerVipCodeInput', vipCode);
  }
  await page.click('#joinRoomBtn');
}

test('host can claim and re-enter rooms with password', async ({ browser }) => {
  const room = uniqueRoom('claim');
  const password = 'super-secret';

  const page = await browser.newPage();
  await setupHost(page, room, { password });

  await page.close();

  const reenter = await browser.newPage();
  await reenter.goto('/');
  await reenter.fill('#hostRoomName', room);
  await reenter.fill('#hostRoomPassword', password);
  await reenter.click('#hostRoomForm button[type="submit"]');
  await reenter.waitForURL(/index\.html/);
  await expect(reenter.locator('#joinBtn')).toBeDisabled();
  await expect(reenter.locator('#signalStatus')).toHaveText('Connected');
});

test('public viewers can join and receive broadcast', async ({ browser }) => {
  const room = uniqueRoom('public');
  const host = await browser.newPage();

  await setupHost(host, room);

  await host.click('#startStreamBtn');
  await expect(host.locator('#startStreamBtn')).toHaveText('Stop Stream');

  const viewer = await browser.newPage();
  await joinViewer(viewer, room, { name: 'PublicViewer' });

  await expect(viewer.locator('#viewerJoinPanel')).toHaveClass(/hidden/);
  await expect(viewer.locator('#viewerStatus')).toHaveText('LIVE', { timeout: 20000 });
});

test('private viewers require VIP access and VIP usage decrements', async ({ browser }) => {
  const room = uniqueRoom('private');
  const host = await browser.newPage();

  await setupHost(host, room);

  await host.click('#togglePrivateBtn');
  await expect(host.locator('#togglePrivateBtn')).toHaveText('ON');
  await host.click('#vipRequiredToggle');
  await expect(host.locator('#vipRequiredToggle')).toHaveText('ON');

  const blockedViewer = await browser.newPage();
  await joinViewer(blockedViewer, room, { name: 'NoVip' });
  await expect(blockedViewer.locator('#joinStatus')).toContainText('VIP');
  await blockedViewer.close();

  await host.fill('#vipUserInput', 'VIPListed');
  await host.click('#addVipUserBtn');
  const vipListedViewer = await browser.newPage();
  await joinViewer(vipListedViewer, room, { name: 'VIPListed' });
  await expect(vipListedViewer.locator('#joinStatus')).toContainText(/vip code/i);

  await host.selectOption('#vipCodeUses', '1');
  await host.click('#generateVipCodeBtn');

  const codeText = await host.locator('#vipCodeList span').first().innerText();
  const match = codeText.match(/[A-Z0-9]{4,}/);
  const vipCode = match ? match[0] : '';

  const vipViewer = await browser.newPage();
  await joinViewer(vipViewer, room, { name: 'VIPListed', vipCode });
  await expect(vipViewer.locator('#viewerJoinPanel')).toHaveClass(/hidden/);

  await expect(host.locator('#vipCodeList')).toContainText('(0/1)');
});

test('host controls respond and stage call completes signaling', async ({ browser }) => {
  const room = uniqueRoom('controls');
  const host = await browser.newPage();

  await setupHost(host, room);

  await host.click('#startStreamBtn');
  await expect(host.locator('#startStreamBtn')).toHaveText('Stop Stream');

  await host.click('#toggleMicBtn');
  await expect(host.locator('#toggleMicBtn')).toHaveText('Unmute');

  await host.click('#shareScreenBtn');
  await expect(host.locator('#shareScreenBtn')).toHaveText('Stop Screen');
  await host.click('#shareScreenBtn');
  await expect(host.locator('#shareScreenBtn')).toHaveText('Share Screen');

  await host.click('#togglePrivateBtn');
  await host.click('#vipRequiredToggle');
  await host.fill('#vipUserInput', 'StageVIP');
  await host.click('#addVipUserBtn');

  await host.selectOption('#vipCodeUses', '1');
  await host.click('#generateVipCodeBtn');

  const codeText = await host.locator('#vipCodeList span').first().innerText();
  const match = codeText.match(/[A-Z0-9]{4,}/);
  const vipCode = match ? match[0] : '';

  const vipViewer = await browser.newPage();
  await joinViewer(vipViewer, room, { name: 'StageVIP', vipCode });
  await expect(vipViewer.locator('#viewerJoinPanel')).toHaveClass(/hidden/);

  await host.locator('#tabUsers').click();
  const callButton = host.locator('#userList .action-btn', { hasText: 'Call VIP' }).first();
  await expect(callButton).toBeVisible();
  await callButton.click();

  await expect(host.locator('#videoGrid .video-container')).toHaveCount(2, { timeout: 20000 });

  await host.click('#hangupBtn');
  await expect(host.locator('#videoGrid .video-container')).toHaveCount(1);

  await host.click('#startStreamBtn');
  await expect(host.locator('#startStreamBtn')).toHaveText('Start Stream');
});
