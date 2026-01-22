const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: {
    timeout: 10000
  },
  use: {
    baseURL: 'http://localhost:9100',
    permissions: ['camera', 'microphone'],
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node server.js',
    port: 9100,
    reuseExistingServer: true,
    timeout: 120000,
    env: {
      PORT: '9100'
    }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--allow-http-screen-capture',
            '--auto-select-desktop-capture-source=Entire screen',
            '--enable-usermedia-screen-capturing'
          ]
        }
      }
    }
  ]
});
