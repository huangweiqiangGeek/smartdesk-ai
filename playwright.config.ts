import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/e2e',
  use: { baseURL: process.env.WEB_URL ?? 'http://127.0.0.1:3100' },
});
