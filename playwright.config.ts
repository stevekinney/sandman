import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'bun run preview',
		env: { SANDMAN_SESSION_SECRET: 'playwright-session-secret' },
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
