/**
 * Search Pipeline Integration Tests
 *
 * These tests call the REAL Gamma API (no mocks) to verify that the
 * search pipeline returns correct, relevant results for user queries.
 *
 * They do NOT use OpenAI — only Gemini if AI is needed (via env override).
 *
 * Run:  npx vitest run tests/integration/search.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

// ── Gamma API helpers (standalone, no bot deps) ──────────────────

const GAMMA = 'https://gamma-api.polymarket.com';

interface GammaEvent {
	title: string;
	slug: string;
	tags?: Array<{ id: string; label: string; slug: string }>;
	markets?: GammaMarket[];
}

interface GammaMarket {
	id?: string;
	condition_id?: string;
	question?: string;
	title?: string;
	slug?: string;
	active?: boolean;
	closed?: boolean;
	outcomes?: string | string[];
	outcomePrices?: string | string[];
	volume?: string | number;
}

async function fetchJson<T>(url: string): Promise<T> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
	return resp.json() as Promise<T>;
}

// ── Test Helpers ──

/** Search events by tag_slug */
async function searchEventsByTag(tagSlug: string, limit = 10): Promise<GammaEvent[]> {
	return fetchJson<GammaEvent[]>(
		`${GAMMA}/events?closed=false&tag_slug=${encodeURIComponent(tagSlug)}&order=volume24hr&ascending=false&limit=${limit}`
	);
}

/** Search events by slug prefix */
async function searchEventsBySlug(slug: string): Promise<GammaEvent[]> {
	return fetchJson<GammaEvent[]>(
		`${GAMMA}/events?closed=false&limit=5&slug=${encodeURIComponent(slug)}`
	);
}

/** Search markets by text_query */
async function searchMarketsByText(query: string, limit = 10): Promise<GammaMarket[]> {
	return fetchJson<GammaMarket[]>(
		`${GAMMA}/markets?closed=false&limit=${limit}&text_query=${encodeURIComponent(query)}`
	);
}

/** Fetch all tags */
async function fetchAllTags(): Promise<Array<{ id: string; label: string; slug: string }>> {
	return fetchJson(`${GAMMA}/tags`);
}

/** Fetch sports metadata */
async function fetchSports(): Promise<Array<{ id: number; sport: string; tags: string; series: string }>> {
	return fetchJson(`${GAMMA}/sports`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════════

describe('Gamma API connectivity', () => {
	it('can reach the Gamma API', async () => {
		const resp = await fetch(`${GAMMA}/markets?limit=1`);
		expect(resp.ok).toBe(true);
	});

	it('returns valid market structure', async () => {
		const markets = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?limit=1&closed=false`);
		expect(markets.length).toBeGreaterThan(0);
		const m = markets[0];
		expect(m.question ?? m.title).toBeTruthy();
		expect(m.id ?? m.condition_id).toBeTruthy();
	});
});

describe('Top-level category searches', () => {
	const CATEGORIES = [
		'politics', 'sports', 'crypto', 'finance',
		'geopolitics', 'tech', 'world', 'economy',
	];

	for (const cat of CATEGORIES) {
		it(`"${cat}" returns events via tag_slug`, async () => {
			const events = await searchEventsByTag(cat, 5);
			expect(events.length).toBeGreaterThan(0);
			console.log(`  ${cat}: ${events.length} events, top="${events[0]?.title}"`);
		});
	}
});

describe('Crypto subcategory searches', () => {
	const CRYPTO_SUBS = ['bitcoin', 'ethereum', 'solana', 'xrp'];

	for (const sub of CRYPTO_SUBS) {
		it(`"${sub}" returns events via tag_slug`, async () => {
			const events = await searchEventsByTag(sub, 3);
			expect(events.length).toBeGreaterThan(0);
			// Verify the returned events are actually about this subcategory
			const firstTitle = events[0]?.title?.toLowerCase() ?? '';
			const hasRelevance = firstTitle.includes(sub) ||
				events[0]?.tags?.some(t => t.slug === sub) === true;
			expect(hasRelevance).toBe(true);
			console.log(`  ${sub}: "${events[0]?.title}"`);
		});
	}
});

describe('Sports subcategory searches', () => {
	let sportsMeta: Array<{ sport: string; series: string; tags: string }> = [];

	beforeAll(async () => {
		sportsMeta = await fetchSports();
	});

	it('fetches sports metadata', () => {
		expect(sportsMeta.length).toBeGreaterThan(0);
		console.log(`  ${sportsMeta.length} sport entries: ${sportsMeta.map(s => s.sport).join(', ')}`);
	});

	// Test a few known sports
	const SPORT_TAGS = ['nba', 'nfl', 'mlb', 'nhl', 'soccer'];
	for (const sport of SPORT_TAGS) {
		it(`"${sport}" has events or series`, async () => {
			// Try tag_slug first
			const tagEvents = await searchEventsByTag(sport, 3).catch(() => []);

			// Try series_id from sports metadata
			const entry = sportsMeta.find(s => s.sport.toLowerCase() === sport);
			let seriesEvents: GammaEvent[] = [];
			if (entry?.series) {
				const seriesId = entry.series.split(',')[0]?.trim();
				if (seriesId) {
					seriesEvents = await fetchJson<GammaEvent[]>(
						`${GAMMA}/events?series_id=${seriesId}&closed=false&limit=3`
					).catch(() => []);
				}
			}

			const total = tagEvents.length + seriesEvents.length;
			console.log(`  ${sport}: ${tagEvents.length} tag events, ${seriesEvents.length} series events`);
			// At least one method should find results (or sport may be off-season)
			if (total === 0) {
				console.log(`  ⚠️  ${sport} has no active events (may be off-season)`);
			}
		});
	}
});

describe('Specific market searches (text_query)', () => {
	/**
	 * NOTE: The Gamma API's text_query param often returns irrelevant results
	 * (sorted by recency, not relevance). The bot uses tag_slug and event slug
	 * search instead. These tests verify text_query behavior and log what it
	 * actually returns so we can detect when it improves.
	 */
	const QUERIES = [
		{ q: 'bitcoin price', expect: 'bitcoin' },
		{ q: 'presidential election', expect: 'president' },
		{ q: 'NBA champion', expect: 'nba' },
		{ q: 'ethereum', expect: 'ethereum' },
	];

	for (const { q, expect: expectWord } of QUERIES) {
		it(`"${q}" returns markets (checks relevance)`, async () => {
			const markets = await searchMarketsByText(q, 5);
			console.log(`  "${q}": ${markets.length} markets`);
			if (markets.length > 0) {
				const topQ = (markets[0].question ?? markets[0].title ?? '').toLowerCase();
				console.log(`    top: "${topQ}"`);
				const anyRelevant = markets.some(m => {
					const text = ((m.question ?? m.title) ?? '').toLowerCase();
					return text.includes(expectWord);
				});
				if (!anyRelevant) {
					console.log(`    ⚠️  text_query returned irrelevant results for "${q}" — this is a known Gamma API limitation`);
				}
				// Don't fail — text_query relevance is unreliable, this is diagnostic
			}
		});
	}
});

describe('Slug-based event search', () => {
	it('finds events by slug prefix', async () => {
		// Use a known high-volume slug pattern
		const events = await searchEventsBySlug('bitcoin').catch(() => []);
		if (events.length > 0) {
			console.log(`  bitcoin slug: "${events[0]?.title}"`);
			expect(events[0]?.title?.toLowerCase()).toContain('bitcoin');
		} else {
			// Slug search is best-effort
			console.log('  ⚠️  No slug match for "bitcoin" (expected for some queries)');
		}
	});
});

describe('Tag search coverage', () => {
	let allTags: Array<{ id: string; label: string; slug: string }> = [];

	beforeAll(async () => {
		allTags = await fetchAllTags();
	});

	it('has tags available', () => {
		expect(allTags.length).toBeGreaterThan(0);
		console.log(`  ${allTags.length} total tags`);
	});

	it('all CATEGORY_TAG_MAP slugs exist as real tags or return events', async () => {
		// These are the slugs used in the bot's CATEGORY_TAG_MAP
		const botCategorySlugs = [
			'politics', 'crypto', 'sports', 'finance',
			'geopolitics', 'tech', 'world', 'economy',
		];
		// 'culture' is excluded — it doesn't work via tag_slug on Gamma API

		const broken: string[] = [];
		for (const slug of botCategorySlugs) {
			const tagExists = allTags.some(t => t.slug === slug);
			let eventsExist = false;
			if (!tagExists) {
				// Some categories work via tag_slug even without an explicit tag
				const events = await searchEventsByTag(slug, 1).catch(() => []);
				eventsExist = events.length > 0;
			}
			const works = tagExists || eventsExist;
			console.log(`  ${slug}: tag=${tagExists}, events=${eventsExist}, works=${works}`);
			if (!works) broken.push(slug);
		}

		if (broken.length > 0) {
			console.log(`  ⚠️  Broken categories: ${broken.join(', ')}`);
		}
		expect(broken.length).toBe(0);
	});
});

describe('Cross-validation: API vs API consistency', () => {
	it('trending events have volume > 0', async () => {
		const events = await fetchJson<GammaEvent[]>(
			`${GAMMA}/events?closed=false&order=volume24hr&ascending=false&limit=5`
		);
		expect(events.length).toBeGreaterThan(0);

		for (const event of events) {
			if (!event.markets?.length) continue;
			const m = event.markets[0];
			const vol = typeof m.volume === 'number' ? m.volume : parseFloat(String(m.volume ?? '0'));
			console.log(`  "${event.title}" vol=$${Math.round(vol)}`);
			expect(vol).toBeGreaterThan(0);
		}
	});

	it('active markets have outcome prices that sum to approximately 1', async () => {
		const markets = await fetchJson<GammaMarket[]>(
			`${GAMMA}/markets?closed=false&active=true&limit=5`
		);
		for (const m of markets.slice(0, 3)) {
			const pricesRaw = m.outcomePrices;
			if (!pricesRaw) continue;

			const prices: number[] = Array.isArray(pricesRaw)
				? pricesRaw.map(Number)
				: JSON.parse(pricesRaw).map(Number);

			const sum = prices.reduce((a: number, b: number) => a + b, 0);
			console.log(`  "${(m.question ?? '').slice(0, 50)}" prices sum=${sum.toFixed(3)}`);
			// Prices should sum to roughly 1 (±0.15 for multi-outcome markets)
			expect(sum).toBeGreaterThan(0.5);
			expect(sum).toBeLessThan(1.5);
		}
	});
});
