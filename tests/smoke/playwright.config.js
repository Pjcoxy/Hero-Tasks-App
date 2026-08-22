const { defineConfig, devices } = require('@playwright/test');

// The browser is preinstalled in CI (PLAYWRIGHT_BROWSERS_PATH), so nothing here
// downloads one. Retries are deliberately 0: this test is meant to be a
// truthful signal, and a retry would hide exactly the intermittency that makes
// a smoke test worthless in an unattended pipeline.
module.exports = defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${process.env.SMOKE_PORT || 4173}`,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    // Use the Chromium already on the image. Playwright pins an exact browser
    // build per release, so without this it tries to download a matching one on
    // every run - slow, and it fails outright where the network is restricted.
    // SMOKE_CHROMIUM lets CI point at whatever build the runner actually has,
    // rather than this file guessing a path that rots on the next image bump.
    launchOptions: process.env.SMOKE_CHROMIUM
      ? { executablePath: process.env.SMOKE_CHROMIUM }
      : {},
  },
  webServer: {
    command: 'node tests/smoke/server.js',
    cwd: require('path').join(__dirname, '..', '..'),
    url: `http://127.0.0.1:${process.env.SMOKE_PORT || 4173}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
