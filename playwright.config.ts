import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 45000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.kff/checks/' + (process.env.KFF_CHECK_NAME ?? 'browser') + '-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:3000', headless: true, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'off', video: 'off' },
  projects: [
    { name: 'fixtures', testDir: './tests/browser/fixtures' },
    { name: 'web', testDir: './tests/browser/web' },
  ],
});
