const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  use: {
    baseURL: 'http://localhost:9100',
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    }
  },
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:9100/landing.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000
  }
});
