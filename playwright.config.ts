import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './tests/browser',
	timeout: 120_000,
	retries: 1,
	workers: 1,
	use: {
		baseURL: 'https://polymarket.com',
		...devices['Desktop Chrome'],
		headless: true,
		// Screenshots on failure for debugging
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
	},
	reporter: [['list'], ['html', { open: 'never' }]],
	outputDir: './tests/browser/results',
});
