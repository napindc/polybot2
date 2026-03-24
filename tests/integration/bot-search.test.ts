/**
 * Bot Search Pipeline Integration Tests
 *
 * These tests instantiate the REAL PolymarketApiReadProvider and
 * PolymarketReadService, call searchMarketsByText() with various
 * user queries, and verify the results are relevant.
 *
 * NO OpenAI is used — the OPENAI_API_KEY env var is blanked in vitest.config.ts
 * so the AI client falls through to Gemini only.
 *
 * Run:  npx vitest run tests/integration/bot-search.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { PolymarketReadService } from '../../src/read/PolymarketReadService';
import { isCasualChat } from '../../src/discord/DiscordMessageRouter';

// Force no OpenAI for tests (redundant with vitest.config.ts but explicit)
process.env.OPENAI_API_KEY = '';

let readService: PolymarketReadService;

beforeAll(() => {
	const provider = new PolymarketApiReadProvider();
	readService = new PolymarketReadService(provider);
});

// ── Helper ──

function relevanceCheck(markets: readonly { question: string }[], keywords: string[]): {
	matched: number;
	total: number;
	topQuestion: string;
	isRelevant: boolean;
} {
	const total = markets.length;
	const topQuestion = markets[0]?.question ?? '(none)';
	const matched = markets.filter(m => {
		const q = m.question.toLowerCase();
		return keywords.some(kw => q.includes(kw.toLowerCase()));
	}).length;
	return {
		matched,
		total,
		topQuestion,
		isRelevant: total === 0 || matched > 0, // empty is OK (market may not exist)
	};
}

// ═══════════════════════════════════════════════════════════════════
// CATEGORY QUERIES — "show me X" style
// ═══════════════════════════════════════════════════════════════════

describe('Category queries through bot pipeline', () => {
	const CATEGORY_TESTS = [
		{ query: 'show me crypto markets', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'price'] },
		{ query: 'politics', keywords: ['president', 'election', 'democrat', 'republican', 'congress', 'trump', 'biden', 'nominee', 'political', 'vote'] },
		{ query: "what's happening in sports?", keywords: ['nba', 'nfl', 'mlb', 'champion', 'winner', 'game', 'match', 'vs', 'cup', 'league'] },
		{ query: 'show me finance', keywords: ['stock', 's&p', 'nasdaq', 'market', 'price', 'rate', 'fed', 'treasury', 'opens'] },
		{ query: 'geopolitics', keywords: ['war', 'iran', 'china', 'russia', 'ukraine', 'peace', 'leader', 'nato', 'conflict', 'deal'] },
		{ query: 'tech markets', keywords: ['ai', 'apple', 'google', 'meta', 'openai', 'tesla', 'company', 'tech', 'largest'] },
		{ query: 'economy', keywords: ['gdp', 'inflation', 'recession', 'fed', 'rate', 'employment', 'economy', 'interest'] },
	];

	for (const { query, keywords } of CATEGORY_TESTS) {
		it(`"${query}" returns relevant results`, async () => {
			const results = await readService.searchMarketsByText(query);
			const check = relevanceCheck(results, keywords);

			console.log(`  "${query}": ${check.total} results, ${check.matched} relevant`);
			console.log(`    top: "${check.topQuestion}"`);

			expect(check.total).toBeGreaterThan(0);
			expect(check.isRelevant).toBe(true);
		}, 30_000);
	}
});

// ═══════════════════════════════════════════════════════════════════
// SPECIFIC MARKET QUERIES — user asks about a specific topic
// ═══════════════════════════════════════════════════════════════════

describe('Specific topic queries', () => {
	const SPECIFIC_TESTS = [
		{ query: 'bitcoin price', keywords: ['bitcoin', 'btc'] },
		{ query: 'ethereum up or down', keywords: ['ethereum', 'eth'] },
		{ query: 'presidential election 2028', keywords: ['president', 'nominee', '2028', 'election'] },
		{ query: 'NBA champion', keywords: ['nba', 'champion'] },
		{ query: 'S&P 500', keywords: ['s&p', 'spx', '500', 'opens', 'market', 'stock'] },
	];

	for (const { query, keywords } of SPECIFIC_TESTS) {
		it(`"${query}" returns relevant results`, async () => {
			const results = await readService.searchMarketsByText(query);
			const check = relevanceCheck(results, keywords);

			console.log(`  "${query}": ${check.total} results, ${check.matched} relevant`);
			if (check.total > 0) {
				console.log(`    top: "${check.topQuestion}"`);
			}

			// Specific queries MUST return relevant results if they return anything
			if (check.total > 0) {
				expect(check.isRelevant).toBe(true);
			}
		}, 30_000);
	}
});

// ═══════════════════════════════════════════════════════════════════
// CONVERSATIONAL QUERIES — natural language from Discord users
// ═══════════════════════════════════════════════════════════════════

describe('Conversational user queries', () => {
	const CONVERSATIONAL_TESTS = [
		{ query: 'hey whats trending right now?', expectNonEmpty: true, keywords: [] },
		{ query: "what's new today?", expectNonEmpty: true, keywords: [] },
		{ query: 'Can you bring me up the odds of bitcoin price today?', keywords: ['bitcoin', 'btc', 'price'] },
		{ query: 'tell me about the presidential election', keywords: ['president', 'election', 'nominee'] },
		{ query: 'any crypto markets I should look at?', keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', 'price'] },
	];

	for (const { query, keywords, expectNonEmpty } of CONVERSATIONAL_TESTS) {
		it(`"${query}" returns results`, async () => {
			const results = await readService.searchMarketsByText(query);
			console.log(`  "${query}": ${results.length} results`);

			if (expectNonEmpty) {
				expect(results.length).toBeGreaterThan(0);
			}

			if (keywords.length > 0 && results.length > 0) {
				const check = relevanceCheck(results, keywords);
				console.log(`    top: "${check.topQuestion}", relevant=${check.matched}/${check.total}`);
				expect(check.isRelevant).toBe(true);
			}
		}, 30_000);
	}
});

// ═══════════════════════════════════════════════════════════════════
// SPORTS MATCHUP QUERIES — "Team A vs Team B" style (regression tests)
// ═══════════════════════════════════════════════════════════════════

describe('Sports matchup queries (vs-queries)', () => {
	it('"Clippers vs Warriors" finds the actual NBA game, NOT esports', async () => {
		const results = await readService.searchMarketsByText('Can you bring me up the odds of Clippers vs Warrior game today?');
		console.log(`  Clippers vs Warriors: ${results.length} results`);

		expect(results.length).toBeGreaterThan(0);

		// The top result must be actually about Clippers/Warriors, not StarCraft/CoD/etc.
		const top = results[0].question.toLowerCase();
		console.log(`    top: "${results[0].question}"`);
		const isCorrect = top.includes('clipper') || top.includes('warrior') || top.includes('lac') || top.includes('gsw');
		expect(isCorrect).toBe(true);

		// Must NOT contain esports content
		const hasEsports = results.some(m => {
			const q = m.question.toLowerCase();
			return q.includes('starcraft') || q.includes('call of duty') || q.includes('league of legends') || q.includes('counter-strike');
		});
		expect(hasEsports).toBe(false);
	}, 30_000);

	it('"Celtics vs Bucks" finds the NBA game', async () => {
		const results = await readService.searchMarketsByText('Celtics vs Bucks');
		console.log(`  Celtics vs Bucks: ${results.length} results`);
		if (results.length > 0) {
			console.log(`    top: "${results[0].question}"`);
			const top = results[0].question.toLowerCase();
			const isCorrect = top.includes('celtic') || top.includes('buck') || top.includes('bos') || top.includes('mil');
			expect(isCorrect).toBe(true);
		}
	}, 30_000);

	it('"Lakers vs Nuggets" finds the NBA game', async () => {
		const results = await readService.searchMarketsByText('What are the odds for Lakers vs Nuggets tonight?');
		console.log(`  Lakers vs Nuggets: ${results.length} results`);
		if (results.length > 0) {
			console.log(`    top: "${results[0].question}"`);
			const top = results[0].question.toLowerCase();
			const isCorrect = top.includes('laker') || top.includes('nugget') || top.includes('lal') || top.includes('den');
			expect(isCorrect).toBe(true);
		}
	}, 30_000);

	it('"Maple Leafs vs Bruins" finds the NHL game, NOT AHL or Stanley Cup futures', async () => {
		const results = await readService.searchMarketsByText('Toronto Maple Leafs vs Boston Bruins');
		console.log(`  Maple Leafs vs Bruins: ${results.length} results`);
		if (results.length > 0) {
			console.log(`    top: "${results[0].question}"`);
			const top = results[0].question.toLowerCase();
			// Should contain actual team names, not a generic "Stanley Cup" futures market
			const isCorrect = top.includes('maple leafs') || top.includes('bruins') || top.includes('tor') || top.includes('bos');
			expect(isCorrect).toBe(true);
		}
	}, 30_000);

	it('"Providence Bruins vs Bridgeport Islanders" finds the AHL game, NOT NHL Stanley Cup', async () => {
		const results = await readService.searchMarketsByText('tell me Providence Bruins vs Bridgeport Islanders');
		console.log(`  Providence Bruins vs Bridgeport Islanders: ${results.length} results`);
		if (results.length > 0) {
			console.log(`    top: "${results[0].question}"`);
			const top = results[0].question.toLowerCase();
			const isCorrect = top.includes('providence') || top.includes('bridgeport');
			expect(isCorrect).toBe(true);
			// Must NOT return NHL Stanley Cup as top result
			const isStanleyCup = top.includes('stanley cup');
			expect(isStanleyCup).toBe(false);
		}
	}, 30_000);

	it('"Arsenal vs Chelsea" finds the EPL game', async () => {
		const results = await readService.searchMarketsByText('Arsenal vs Chelsea');
		console.log(`  Arsenal vs Chelsea: ${results.length} results`);
		if (results.length > 0) {
			console.log(`    top: "${results[0].question}"`);
			const top = results[0].question.toLowerCase();
			const isCorrect = top.includes('arsenal') || top.includes('chelsea') || top.includes('ars') || top.includes('che');
			expect(isCorrect).toBe(true);
		}
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// RECURRING SERIES — should find successor events, not old closed ones
// ═══════════════════════════════════════════════════════════════════

describe('Recurring series successor lookup', () => {
	it('"Largest Company end of March" finds NVIDIA/Apple, NOT Company A/B placeholders', async () => {
		const results = await readService.searchMarketsByText('tell me about Largest Company end of March?');
		console.log(`  Largest Company: ${results.length} results`);
		expect(results.length).toBeGreaterThan(0);

		const top5 = results.slice(0, 7);

		// If only placeholder (Company A/B/C) markets are active, this is the gap between
		// recurring series iterations — the next event hasn't been published yet.
		// Skip the real-company and placeholder assertions in that case.
		const activeResults = top5.filter(m => m.status === 'active');
		const allPlaceholders = top5.every(m => /\bcompany [a-t]\b/.test(m.question.toLowerCase()));
		if (activeResults.length === 0 || allPlaceholders) {
			console.log(`    (recurring series gap — no active event found, skipping placeholder assertions)`);
			return;
		}

		// Top results should be real companies (NVIDIA, Apple, etc.), not placeholders
		const hasRealCompany = top5.some(m => {
			const q = m.question.toLowerCase();
			return q.includes('nvidia') || q.includes('apple') || q.includes('microsoft') ||
				q.includes('tesla') || q.includes('amazon') || q.includes('alphabet') ||
				q.includes('saudi aramco');
		});
		expect(hasRealCompany).toBe(true);

		// Must NOT have Company A/B/C placeholders in the top results
		const hasPlaceholder = top5.some(m => {
			const q = m.question.toLowerCase();
			return /\bcompany [a-t]\b/.test(q);
		});
		expect(hasPlaceholder).toBe(false);

		// Top results should be active, not closed
		expect(activeResults.length).toBeGreaterThan(0);
		console.log(`    top active: ${activeResults.length}, top: "${results[0].question}"`);
	}, 45_000);
});

// ═══════════════════════════════════════════════════════════════════
// NEGATIVE / EDGE CASES — should not return garbage
// ═══════════════════════════════════════════════════════════════════

describe('Edge cases and negative tests', () => {
	it('empty query returns markets (fallback to all)', async () => {
		const results = await readService.searchMarketsByText('');
		expect(results.length).toBeGreaterThan(0);
	}, 30_000);

	it('gibberish query returns empty or generic results (not crashes)', async () => {
		const results = await readService.searchMarketsByText('asdfghjkl qwerty zxcvbn');
		// Should not crash, may return empty or generic fallback
		console.log(`  gibberish: ${results.length} results`);
		expect(Array.isArray(results)).toBe(true);
	}, 30_000);

	it('very long query does not crash', async () => {
		const long = 'tell me about the current status of '.repeat(20) + 'bitcoin';
		const results = await readService.searchMarketsByText(long);
		console.log(`  long query: ${results.length} results`);
		expect(Array.isArray(results)).toBe(true);
	}, 30_000);

	it('"Maximus Jones vs Tom Gentzsch" (unknown MMA fighters) returns 0 results — no esports false positives', async () => {
		// Regression test: "tom" is a substring of "Rare Atom" (Valorant team).
		// Before fix, this returned 3 Valorant markets via substring matching in series search.
		// After fix: word-boundary matching + relevance filter should produce 0 results.
		const results = await readService.searchMarketsByText('tell me about Maximus Jones vs Tom Gentzsch');
		console.log(`  unknown MMA fighters: ${results.length} results`);
		// No Polymarket market exists for this matchup
		expect(results.length).toBe(0);
		// Must not return esports content (the false positive we're guarding against)
		const hasEsports = results.some(m => {
			const q = m.question.toLowerCase();
			return q.includes('valorant') || q.includes('rare atom') || q.includes('esports') ||
				q.includes('counter-strike') || q.includes('league of legends');
		});
		expect(hasEsports).toBe(false);
	}, 60_000);
});

// ═══════════════════════════════════════════════════════════════════
// GREETING / CASUAL CHAT DETECTION — no market search should fire
// ═══════════════════════════════════════════════════════════════════

describe('Greeting / casual chat detection (isCasualChat)', () => {
	// These should be detected as casual chat (no market search)
	const CASUAL_MESSAGES = [
		'hi', 'Hi', 'HI', 'hi!', 'hi there', 'Hi there!',
		'hey', 'hey!', 'hello', 'Hello!', 'yo', 'sup',
		'howdy', 'hola', 'hiya', 'heya',
		'good morning', 'Good Morning!', 'good afternoon',
		'good evening', 'good night', 'good day',
		'gm', 'gn', 'gg', 'ty', 'thx', 'thanks', 'thank you', 'cheers',
		'how are you', 'how are you?', "how's it going",
		'bye', 'goodbye', 'see ya', 'later', 'cya', 'peace out',
		'lol', 'lmao', 'haha', 'hehe', 'xd',
		'👋', '😊',
	];

	for (const msg of CASUAL_MESSAGES) {
		it(`"${msg}" is detected as casual chat`, () => {
			expect(isCasualChat(msg)).toBe(true);
		});
	}

	// These should NOT be detected as casual chat (real queries)
	const REAL_QUERIES = [
		'show me crypto markets',
		'bitcoin price',
		'what is the election odds?',
		"what's trending?",
		'anything new today?',
		'Avalanche vs Kings',
		'Lakers vs Warriors',
		'tell me about bitcoin',
		'hi what are the bitcoin markets',
		'hello can you show me crypto',
		'hey show me trending markets',
		'how is the Lakers game going?',
	];

	for (const msg of REAL_QUERIES) {
		it(`"${msg}" is NOT casual chat`, () => {
			expect(isCasualChat(msg)).toBe(false);
		});
	}
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-VALIDATION — bot results vs direct API
// ═══════════════════════════════════════════════════════════════════

describe('Bot vs direct Gamma API cross-validation', () => {
	it('bot crypto results overlap with direct API crypto events', async () => {
		// Bot search
		const botResults = await readService.searchMarketsByText('crypto');

		// Direct API
		const directResp = await fetch(
			'https://gamma-api.polymarket.com/events?closed=false&tag_slug=crypto&order=volume24hr&ascending=false&limit=10'
		);
		const directEvents = await directResp.json() as Array<{ title: string; markets?: Array<{ question?: string; id?: string }> }>;

		// Collect direct API market IDs
		const directIds = new Set<string>();
		for (const ev of directEvents) {
			for (const m of ev.markets ?? []) {
				if (m.id) directIds.add(m.id);
			}
		}

		// Check overlap
		const botIds = new Set(botResults.map(m => m.id));
		const overlap = [...botIds].filter(id => directIds.has(id));

		console.log(`  Bot: ${botResults.length} markets, Direct: ${directIds.size} markets, Overlap: ${overlap.length}`);

		// At least some overlap expected (bot may rank differently)
		if (directIds.size > 0 && botResults.length > 0) {
			expect(overlap.length).toBeGreaterThan(0);
		}
	}, 30_000);
});
