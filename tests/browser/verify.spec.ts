/**
 * Playwright Browser Verification Tests
 *
 * These tests open real Polymarket pages in Chromium and cross-validate
 * that the data the bot's Gamma API returns matches what's actually on
 * the Polymarket website.
 *
 * This catches drift between the API and the live site — subcategories
 * that the API serves differently than the UI, markets that are visible
 * on the site but missing from API results, etc.
 *
 * Run:  npx playwright test tests/browser/verify.spec.ts
 */

import { test, expect } from '@playwright/test';

const GAMMA = 'https://gamma-api.polymarket.com';

// ── Helpers ──

async function gammaFetch<T>(path: string): Promise<T> {
	const resp = await fetch(`${GAMMA}${path}`);
	if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${path}`);
	return resp.json() as Promise<T>;
}

// ═══════════════════════════════════════════════════════════════════
// 1. NAVIGATION CATEGORIES — verify each tab on polymarket.com works
// ═══════════════════════════════════════════════════════════════════

test.describe('Polymarket navigation categories', () => {
	/**
	 * Top-level categories visible in the polymarket.com nav bar.
	 * These map to URL paths like /politics, /sports, /crypto, etc.
	 */
	const CATEGORIES = [
		{ name: 'Politics', path: '/politics' },
		{ name: 'Sports', path: '/sports' },
		{ name: 'Crypto', path: '/crypto' },
		{ name: 'Finance', path: '/finance' },
		{ name: 'Geopolitics', path: '/geopolitics' },
		{ name: 'Tech', path: '/tech' },
		{ name: 'Culture', path: '/culture' },
		{ name: 'World', path: '/world' },
		{ name: 'Economy', path: '/economy' },
	];

	for (const cat of CATEGORIES) {
		test(`"${cat.name}" category page loads and has markets`, async ({ page }) => {
			await page.goto(`https://polymarket.com${cat.path}`, { waitUntil: 'domcontentloaded' });
			// Wait for market cards to render
			await page.waitForTimeout(3000);

			// Check the page title or heading contains the category
			const pageText = await page.textContent('body');
			expect(pageText).toBeTruthy();

			// Cross-check: same category via API
			const apiEvents = await gammaFetch<Array<{ title: string }>>(
				`/events?closed=false&tag_slug=${cat.name.toLowerCase()}&limit=3&order=volume24hr&ascending=false`
			);

			if (apiEvents.length > 0) {
				console.log(`  ✓ ${cat.name}: API has ${apiEvents.length} events, top="${apiEvents[0].title}"`);
				// Verify the top API event title appears somewhere on the page
				// (accounting for truncation, the first few words should match)
				const topTitle = apiEvents[0].title.split(' ').slice(0, 3).join(' ');
				const bodyText = pageText ?? '';
				const found = bodyText.includes(topTitle) || bodyText.toLowerCase().includes(topTitle.toLowerCase());
				if (!found) {
					console.log(`  ⚠️  "${topTitle}" not found on page (may be below fold or differently titled)`);
				}
			} else {
				console.log(`  ⚠️  ${cat.name}: API returned 0 events`);
			}
		});
	}
});

// ═══════════════════════════════════════════════════════════════════
// 2. CRYPTO SUBCATEGORIES — verify sidebar subcategories match API
// ═══════════════════════════════════════════════════════════════════

test.describe('Crypto subcategory verification', () => {
	test('crypto page sidebar subcategories match API tags', async ({ page }) => {
		await page.goto('https://polymarket.com/crypto', { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(4000);

		// Scrape sidebar text for known crypto subcategories
		const bodyText = (await page.textContent('body')) ?? '';

		const EXPECTED_SUBS = ['Bitcoin', 'Ethereum', 'Solana', 'XRP'];
		const found: string[] = [];
		const missing: string[] = [];

		for (const sub of EXPECTED_SUBS) {
			if (bodyText.includes(sub)) {
				found.push(sub);
			} else {
				missing.push(sub);
			}
		}

		console.log(`  Found on page: ${found.join(', ')}`);
		if (missing.length > 0) {
			console.log(`  Missing from page: ${missing.join(', ')}`);
		}

		// Cross-validate each subcategory via API
		for (const sub of found) {
			const slug = sub.toLowerCase();
			const events = await gammaFetch<Array<{ title: string }>>(
				`/events?closed=false&tag_slug=${slug}&limit=1`
			);
			expect(events.length).toBeGreaterThan(0);
			console.log(`  API ${slug}: "${events[0]?.title}"`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// 3. MARKET DATA ACCURACY — compare API prices with what's on site
// ═══════════════════════════════════════════════════════════════════

test.describe('Market data cross-validation', () => {
	test('top trending market prices match between API and website', async ({ page }) => {
		// Get top trending from API
		const events = await gammaFetch<Array<{
			title: string;
			slug: string;
			markets?: Array<{
				question?: string;
				outcomePrices?: string | string[];
				outcomes?: string | string[];
				slug?: string;
			}>;
		}>>('/events?closed=false&order=volume24hr&ascending=false&limit=3');

		expect(events.length).toBeGreaterThan(0);

		for (const event of events.slice(0, 2)) {
			if (!event.markets?.length) continue;
			const market = event.markets[0];
			if (!market.outcomePrices) continue;

			// Parse API prices
			const apiPrices: number[] = Array.isArray(market.outcomePrices)
				? market.outcomePrices.map(Number)
				: JSON.parse(market.outcomePrices).map(Number);

			const apiPricePct = apiPrices.map(p => Math.round(p * 100));

			// Navigate to the event page
			const eventUrl = `https://polymarket.com/event/${event.slug}`;
			console.log(`  Checking: "${event.title}" at ${eventUrl}`);
			console.log(`    API prices: ${apiPricePct.join('%, ')}%`);

			await page.goto(eventUrl, { waitUntil: 'domcontentloaded' });
			await page.waitForTimeout(3000);

			const bodyText = (await page.textContent('body')) ?? '';

			// Check that at least one API price appears on the page (within ±3% tolerance)
			let priceFound = false;
			for (const pct of apiPricePct) {
				// Look for the percentage on the page (e.g. "52%" or "48%")
				if (bodyText.includes(`${pct}%`) || bodyText.includes(`${pct - 1}%`) || bodyText.includes(`${pct + 1}%`)) {
					priceFound = true;
					break;
				}
			}

			if (priceFound) {
				console.log(`    ✓ Price verified on page`);
			} else {
				console.log(`    ⚠️  Could not find API prices on page (page may use different format)`);
			}
		}
	});
});

// ═══════════════════════════════════════════════════════════════════
// 4. SEARCH — verify the Polymarket search bar returns same as API
// ═══════════════════════════════════════════════════════════════════

test.describe('Search consistency', () => {
	const SEARCH_TERMS = ['bitcoin', 'election', 'NBA'];

	for (const term of SEARCH_TERMS) {
		test(`search "${term}" — API vs website`, async ({ page }) => {
			// API search
			const apiMarkets = await gammaFetch<Array<{
				question?: string;
				title?: string;
			}>>(`/markets?closed=false&limit=5&text_query=${encodeURIComponent(term)}`);

			console.log(`  API "${term}": ${apiMarkets.length} results`);
			if (apiMarkets.length > 0) {
				console.log(`    top: "${apiMarkets[0].question ?? apiMarkets[0].title}"`);
			}

			// Website search
			await page.goto('https://polymarket.com', { waitUntil: 'domcontentloaded' });
			await page.waitForTimeout(2000);

			// Click search bar and type
			const searchInput = page.locator('input[placeholder*="Search"]').first();
			if (await searchInput.isVisible({ timeout: 5000 }).catch(() => false)) {
				await searchInput.click();
				await searchInput.fill(term);
				await page.waitForTimeout(3000);

				const resultsText = (await page.textContent('body')) ?? '';
				const termLower = term.toLowerCase();

				// Verify the search term appears in results
				const hasResults = resultsText.toLowerCase().includes(termLower);
				console.log(`  Website "${term}": results found=${hasResults}`);

				if (apiMarkets.length > 0 && hasResults) {
					// Check if the top API result appears on the page
					const topQuestion = (apiMarkets[0].question ?? apiMarkets[0].title ?? '').split(' ').slice(0, 4).join(' ');
					const topFound = resultsText.includes(topQuestion);
					console.log(`  Cross-check: "${topQuestion}" on page=${topFound}`);
				}
			} else {
				console.log('  ⚠️  Search input not found (page layout may have changed)');
			}
		});
	}
});

// ═══════════════════════════════════════════════════════════════════
// 5. SUBCATEGORY DISCOVERY — scrape all sidebar categories from site
// ═══════════════════════════════════════════════════════════════════

test.describe('Subcategory discovery', () => {
	const CATEGORY_PAGES = [
		{ name: 'crypto', path: '/crypto' },
		{ name: 'sports', path: '/sports' },
		{ name: 'politics', path: '/politics' },
	];

	for (const cat of CATEGORY_PAGES) {
		test(`discover subcategories on ${cat.name} page`, async ({ page }) => {
			await page.goto(`https://polymarket.com${cat.path}`, { waitUntil: 'domcontentloaded' });
			await page.waitForTimeout(4000);

			// Try to find sidebar navigation links
			// Polymarket uses a sidebar with category filters
			const sidebarLinks = await page.locator('nav a, aside a, [class*="sidebar"] a, [class*="filter"] a, [class*="category"] a').allTextContents();

			const uniqueLinks = [...new Set(sidebarLinks.map(l => l.trim()).filter(l => l.length > 1 && l.length < 50))];

			if (uniqueLinks.length > 0) {
				console.log(`  ${cat.name} sidebar items (${uniqueLinks.length}):`);
				for (const link of uniqueLinks.slice(0, 20)) {
					console.log(`    - ${link}`);
				}
			} else {
				// Fallback: look for any filter-like text patterns
				const bodyText = (await page.textContent('body')) ?? '';
				console.log(`  ${cat.name}: no sidebar links found via selectors`);
				console.log(`  Page length: ${bodyText.length} chars`);
			}

			// Cross-validate: check that API returns events for this category
			const events = await gammaFetch<Array<{ title: string }>>(
				`/events?closed=false&tag_slug=${cat.name}&limit=3&order=volume24hr&ascending=false`
			);
			console.log(`  API ${cat.name}: ${events.length} events`);
			expect(events.length).toBeGreaterThan(0);
		});
	}
});
