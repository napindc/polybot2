import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Integration tests hit real APIs — give them time
		testTimeout: 60_000,
		hookTimeout: 30_000,
		// Load .env for GEMINI keys (no OpenAI needed)
		env: {
			// Force tests to never use OpenAI
			OPENAI_API_KEY: '',
		},
		// Run tests sequentially to avoid API rate limits
		sequence: { concurrent: false },
	},
});
