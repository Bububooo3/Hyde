import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: '**/*.gui.ts', timeout: 60_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:4179', viewport: { width: 1480, height: 1050 }, headless: true, channel: 'chrome', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } },
  webServer: { command: 'npx vite preview --config vite.decomposer.config.ts --host 127.0.0.1 --port 4179 --strictPort', url: 'http://127.0.0.1:4179/decomposer.html', reuseExistingServer: true, timeout: 30_000 },
});
