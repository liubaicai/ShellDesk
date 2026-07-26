import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/unit',
  timeout: 10_000,
  fullyParallel: true,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
