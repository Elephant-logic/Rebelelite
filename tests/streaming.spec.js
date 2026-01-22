const { test, expect } = require('@playwright/test');

function uniqueRoom(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

test('claim + host join', async ({ page }) => {
  const roomName = uniqueRoom('claim-room');

  await page.goto('/landing.html');
  await page.fill('#claimRoomName', roomName);
  await page.fill('#claimRoomPassword', 'super-secret');
  await page.selectOption('#claimRoomPrivacy', 'public');
  await page.click('button:has-text("Claim Room")');

  await page.waitForURL(new RegExp(`/index.html\\?room=${roomName}.*role=host`));
  await page.waitForFunction(() => {
    const video = document.getElementById('localVideo');
    return video && video.srcObject;
  });
  await expect(page.locator('#signalStatus')).toHaveText('Connected');
});

test('host login to existing room', async ({ page, context }) => {
  const roomName = uniqueRoom('host-login');

  await page.goto('/landing.html');
  await page.fill('#claimRoomName', roomName);
  await page.fill('#claimRoomPassword', 'correct-pass');
  await page.click('button:has-text("Claim Room")');
  await page.waitForURL(new RegExp(`/index.html\\?room=${roomName}.*role=host`));

  const loginPage = await context.newPage();
  await loginPage.goto('/landing.html');
  await loginPage.fill('#hostRoomName', roomName);
  await loginPage.fill('#hostRoomPassword', 'wrong-pass');
  await loginPage.click('button:has-text("Enter Host Studio")');
  await expect(loginPage.locator('#hostRoomStatus')).toHaveText(/invalid room password/i);
  await expect(loginPage).toHaveURL(/landing\.html/);

  await loginPage.fill('#hostRoomPassword', 'correct-pass');
  await loginPage.click('button:has-text("Enter Host Studio")');
  await loginPage.waitForURL(new RegExp(`/index.html\\?room=${roomName}.*role=host`));
});

test('viewer public room joins and receives stream', async ({ context }) => {
  const roomName = uniqueRoom('public-room');
  const hostPage = await context.newPage();
  await hostPage.goto(`/index.html?room=${roomName}&role=host`);
  await hostPage.waitForFunction(() => {
    const video = document.getElementById('localVideo');
    return video && video.srcObject;
  });

  const viewerPage = await context.newPage();
  await viewerPage.goto(`/view.html?room=${roomName}`);
  await viewerPage.fill('#viewerNameInput', 'Viewer');
  await viewerPage.click('#joinRoomBtn');

  await hostPage.click('#startStreamBtn');
  await expect(viewerPage.locator('#viewerStatus')).toHaveText('LIVE');
});

test('viewer private room requires VIP code', async ({ context }) => {
  const roomName = uniqueRoom('private-room');
  const hostPage = await context.newPage();
  await hostPage.goto(`/index.html?room=${roomName}&role=host`);
  await hostPage.waitForFunction(() => {
    const video = document.getElementById('localVideo');
    return video && video.srcObject;
  });

  await hostPage.click('#togglePrivateBtn');
  await expect(hostPage.locator('#togglePrivateBtn')).toHaveText('ON');
  await hostPage.fill('#vipCodeUses', '1');
  await hostPage.click('#generateVipCodeBtn');
  const vipCodeEntry = hostPage.locator('#vipCodeList span').first();
  await expect(vipCodeEntry).toHaveText(/\(/);
  const vipCodeText = await vipCodeEntry.innerText();
  const vipCode = vipCodeText.split(' ')[0];

  const viewerPage = await context.newPage();
  await viewerPage.goto(`/view.html?room=${roomName}`);
  await viewerPage.fill('#viewerNameInput', 'VIP Viewer');
  await viewerPage.click('#joinRoomBtn');
  await expect(viewerPage.locator('#joinStatus')).toHaveText(/vip code required/i);

  await viewerPage.fill('#viewerVipCodeInput', vipCode);
  await viewerPage.click('#joinRoomBtn');
  await expect(viewerPage.locator('#viewerJoinPanel')).toHaveClass(/hidden/);

  await expect(vipCodeEntry).toHaveText(new RegExp(`${vipCode} \(0/`));
});

test('host buttons wire correctly and join button still works', async ({ context }) => {
  const roomName = uniqueRoom('button-room');
  const hostPage = await context.newPage();
  await hostPage.goto(`/index.html?room=${roomName}&role=host`);
  await hostPage.waitForFunction(() => {
    const video = document.getElementById('localVideo');
    return video && video.srcObject;
  });

  const startStreamBtn = hostPage.locator('#startStreamBtn');
  await expect(startStreamBtn).toHaveText('Start Stream');
  await startStreamBtn.click();
  await expect(startStreamBtn).toHaveText('Stop Stream');
  await startStreamBtn.click();
  await expect(startStreamBtn).toHaveText('Start Stream');

  const nextRoom = uniqueRoom('manual-room');
  await hostPage.fill('#roomInput', nextRoom);
  await hostPage.click('#joinBtn');
  await hostPage.waitForURL(new RegExp(`/index.html\\?room=${nextRoom}.*role=host`));
});
