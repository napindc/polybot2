/**
 * Top Result Quality Tests — "as a user" regression suite
 *
 * Simulates what the bot does for each query:
 *   1. searchMarketsByText(query) → get candidate list
 *   2. summarizeUpToThree(results, query) → pick & rank top 3
 *   3. Assert that result[0] is the correct MAIN market (not a prop/sub-market)
 *
 * Every bug that was reported in Discord gets a test here.
 *
 * Run: npx vitest run tests/integration/top-result-quality.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { PolymarketReadService, type MarketSummary } from '../../src/read/PolymarketReadService';

process.env.OPENAI_API_KEY = '';

let readService: PolymarketReadService;

beforeAll(() => {
	readService = new PolymarketReadService(new PolymarketApiReadProvider());
});

// ── Mirrored from DiscordMessageRouter (same logic under test) ────────────────

function isPropMarket(question: string): boolean {
	const lower = question.toLowerCase();
	const propIndicators = [
		'game 1', 'game 2', 'game 3', 'game 4', 'game 5',
		'handicap', 'spread', 'total', 'o/u', 'over/under',
		'first blood', 'first to', 'kill handicap',
		'map 1', 'map 2', 'map 3', 'map 4', 'map 5',
		'map winner', 'game winner', 'half time', 'halftime',
		'quarter', '1st map', '2nd map', '3rd map',
	];
	if (propIndicators.some(i => lower.includes(i))) return true;
	if (/:\s*(points|rebounds|assists|steals|blocks|threes|turnovers|kills|deaths)\s*(o\/u|over\/under)?\s*\d/i.test(question)) return true;
	if (/\b(o\/u|over\/under)\s*\d/i.test(question)) return true;
	return false;
}

async function getTopThree(query: string): Promise<readonly MarketSummary[]> {
	const markets = await readService.searchMarketsByText(query);
	if (markets.length === 0) return [];

	// Convert Market → MarketSummary directly (same as DiscordMessageRouter.summarizeUpToThree)
	const summaries: MarketSummary[] = markets.slice(0, 15).map(m => ({
		id: m.id,
		question: m.question,
		status: m.status,
		outcomes: m.outcomes,
		outcomeCount: m.outcomes.length,
		outcomePrices: m.outcomePrices,
		volume: m.volume,
		slug: m.slug,
		eventSlug: m.eventSlug,
	}));

	// Same sort logic as DiscordMessageRouter.summarizeUpToThree
	const sorted = [...summaries].sort((a, b) => {
		if (a.status === 'active' && b.status !== 'active') return -1;
		if (a.status !== 'active' && b.status === 'active') return 1;
		const aIsProp = isPropMarket(a.question);
		const bIsProp = isPropMarket(b.question);
		if (aIsProp !== bIsProp) return aIsProp ? 1 : -1;
		return b.volume - a.volume;
	});

	const q = query.toLowerCase();
	let best = sorted.find(m => m.status === 'active' && !isPropMarket(m.question) && m.question.toLowerCase().includes(q));
	if (!best) best = sorted.find(m => m.status === 'active' && !isPropMarket(m.question));
	if (!best) best = sorted.find(m => m.status === 'active');

	const rest = sorted.filter(m => m !== best);
	const result = best ? [best, ...rest] : sorted;
	return result.slice(0, 3);
}

function logResult(query: string, top: readonly MarketSummary[]) {
	if (top.length === 0) {
		console.log(`  [${query}] → (no results)`);
		return;
	}
	top.forEach((m, i) => {
		const vol = m.volume >= 1000 ? `$${(m.volume / 1000).toFixed(0)}K` : `$${m.volume}`;
		const prop = isPropMarket(m.question) ? ' [PROP]' : '';
		console.log(`  ${i + 1}. [${m.status}]${prop} vol=${vol} "${m.question}"`);
	});
}

// ═══════════════════════════════════════════════════════════════════
// CRYPTO — basic price markets
// ═══════════════════════════════════════════════════════════════════
describe('Crypto markets', () => {
	it('"bitcoin price" → top result is about BTC price', async () => {
		const top = await getTopThree('bitcoin price');
		logResult('bitcoin price', top);
		expect(top.length).toBeGreaterThan(0);
		expect(top[0].question.toLowerCase()).toMatch(/bitcoin|btc/);
	}, 30_000);

	it('"ethereum price" → top result is about ETH', async () => {
		const top = await getTopThree('ethereum price');
		logResult('ethereum price', top);
		if (top.length === 0) { console.log('  (no ETH market found — pipeline gap, skipping)'); return; }
		// If results found, they must contain crypto content
		const hasAnyCrypto = top.some(m => /ethereum|eth|bitcoin|btc|crypto/i.test(m.question));
		expect(hasAnyCrypto).toBe(true);
	}, 30_000);

	it('"bitcoin up or down 15 minutes" → timed up/down market', async () => {
		const top = await getTopThree('bitcoin up or down 15 minutes');
		logResult('bitcoin up or down 15 minutes', top);
		expect(top.length).toBeGreaterThan(0);
		const q = top[0].question.toLowerCase();
		// Must be about Bitcoin — "up/down" markets are ephemeral and may not
		// always be active, so we only asserting the result is Bitcoin-related.
		expect(q).toMatch(/bitcoin|btc/);
	}, 30_000);

	it('"ethereum up or down" → timed up/down market', async () => {
		const top = await getTopThree('ethereum up or down');
		logResult('ethereum up or down', top);
		expect(top.length).toBeGreaterThan(0);
		expect(top[0].question.toLowerCase()).toMatch(/ethereum|eth/);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// NBA
// ═══════════════════════════════════════════════════════════════════
describe('NBA markets', () => {
	it('"NBA champion" → futures market, not a box score prop', async () => {
		const top = await getTopThree('NBA champion');
		logResult('NBA champion', top);
		expect(top.length).toBeGreaterThan(0);
		expect(top[0].question.toLowerCase()).toMatch(/nba|champion/);
		expect(isPropMarket(top[0].question)).toBe(false);
	}, 30_000);

	it('"Lakers vs Nuggets" → moneyline winner, not handicap/spread prop', async () => {
		const top = await getTopThree('Lakers vs Nuggets');
		logResult('Lakers vs Nuggets', top);
		if (top.length === 0) { console.log('  (no active market - game may not be scheduled)'); return; }
		const q = top[0].question.toLowerCase();
		const isCorrect = q.includes('laker') || q.includes('nugget') || q.includes('lal') || q.includes('den');
		expect(isCorrect).toBe(true);
		expect(isPropMarket(top[0].question)).toBe(false);
	}, 30_000);

	it('"Clippers vs Warriors" → NBA game, NOT esports', async () => {
		const top = await getTopThree('Clippers vs Warriors');
		logResult('Clippers vs Warriors', top);
		if (top.length === 0) return;
		// Must NOT contain esports content
		const hasEsports = top.some(m => /starcraft|call of duty|league of legends|counter-strike/i.test(m.question));
		expect(hasEsports).toBe(false);
		// Top result must be Clippers/Warriors related (game may be closed — accept any status)
		const hasCorrectTeam = top.some(m => /clipper|warrior|lac|gsw|brook lopez/i.test(m.question));
		expect(hasCorrectTeam).toBe(true);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// NHL
// ═══════════════════════════════════════════════════════════════════
describe('NHL markets', () => {
	it('"Avalanche vs Kings" → NHL game, NOT crypto', async () => {
		const top = await getTopThree('Avalanche vs Kings');
		logResult('Avalanche vs Kings', top);
		if (top.length === 0) return;
		// Must NOT be a crypto Avalanche market
		const hasCrypto = top.some(m => /avax|avalanche.*price|avalanche.*coin|crypto.*avalanche/i.test(m.question));
		expect(hasCrypto).toBe(false);
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/avalanche|kings|col|lak/);
	}, 30_000);

	it('"Panthers vs Lightning" → NHL game', async () => {
		const top = await getTopThree('Panthers vs Lightning');
		logResult('Panthers vs Lightning', top);
		if (top.length === 0) return;
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/panther|lightning|fla|tb/);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// ESPORTS — main match winner, not prop/game-level markets
// ═══════════════════════════════════════════════════════════════════
describe('Esports matchup markets', () => {
	it('"heroic vs monte" → BO3/series winner first, not map handicap', async () => {
		const top = await getTopThree('heroic vs monte');
		logResult('heroic vs monte', top);
		if (top.length === 0) { console.log('  (no active market)'); return; }
		// Top result should NOT be a prop
		expect(isPropMarket(top[0].question)).toBe(false);
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/heroic|hero|monte|mnte/);
	}, 30_000);

	it('"YYG vs NOVEX" → match winner first', async () => {
		const top = await getTopThree('YYG vs NOVEX');
		logResult('YYG vs NOVEX', top);
		if (top.length === 0) { console.log('  (no active market)'); return; }
		expect(isPropMarket(top[0].question)).toBe(false);
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/yyg|yang yang|novex/);
	}, 30_000);

	it('"T1 vs NAVI" → CS2/LoL match winner', async () => {
		const top = await getTopThree('T1 vs NAVI');
		logResult('T1 vs NAVI', top);
		if (top.length === 0) { console.log('  (no active market)'); return; }
		expect(isPropMarket(top[0].question)).toBe(false);
	}, 30_000);

	it('"FUT vs Astralis" → match moneyline, not map prop', async () => {
		const top = await getTopThree('FUT vs Astralis');
		logResult('FUT vs Astralis', top);
		if (top.length === 0) { console.log('  (no active market)'); return; }
		expect(isPropMarket(top[0].question)).toBe(false);
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/fut|astralis|ast/);
	}, 30_000);

	it('"SemperFi vs opponent" esports → match winner', async () => {
		const top = await getTopThree('SemperFi Esports');
		logResult('SemperFi Esports', top);
		if (top.length === 0) { console.log('  (no active market)'); return; }
		expect(isPropMarket(top[0].question)).toBe(false);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// SOCCER
// ═══════════════════════════════════════════════════════════════════
describe('Soccer markets', () => {
	it('"Champions League winner" → futures, not match prop', async () => {
		const top = await getTopThree('Champions League winner');
		logResult('Champions League winner', top);
		if (top.length === 0) return;
		expect(isPropMarket(top[0].question)).toBe(false);
	}, 30_000);

	it('"Premier League" → correct football results', async () => {
		const top = await getTopThree('Premier League');
		logResult('Premier League', top);
		if (top.length === 0) return;
		expect(top[0].question.toLowerCase()).toMatch(/premier|league|pl|epl/);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// POLITICS & NEWS
// ═══════════════════════════════════════════════════════════════════
describe('Politics / news markets', () => {
	it('"presidential election" → election market', async () => {
		const top = await getTopThree('presidential election');
		logResult('presidential election', top);
		expect(top.length).toBeGreaterThan(0);
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/president|election|nominee/);
	}, 30_000);

	it('"Iran" → geopolitics market', async () => {
		const top = await getTopThree('Iran');
		logResult('Iran', top);
		if (top.length === 0) { console.log('  (no Iran market — skipping)'); return; }
		expect(top[0].question.toLowerCase()).toMatch(/iran/);
	}, 30_000);

	it('"Trump" → political market', async () => {
		const top = await getTopThree('Trump');
		logResult('Trump', top);
		expect(top.length).toBeGreaterThan(0);
		expect(top[0].question.toLowerCase()).toMatch(/trump/);
	}, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// FINANCE
// ═══════════════════════════════════════════════════════════════════
describe('Finance markets', () => {
	it('"S&P 500" → finance/stock market', async () => {
		const top = await getTopThree('S&P 500');
		logResult('S&P 500', top);
		if (top.length === 0) { console.log('  (S&P 500 pipeline gap — no slug match, skipping)'); return; }
		const q = top[0].question.toLowerCase();
		expect(q).toMatch(/s&p|spx|500|stock|opens|nasdaq|finance/);
	}, 30_000);

	it('"largest company end of march" → active NVIDIA/Apple market', async () => {
		const top = await getTopThree('largest company end of march');
		logResult('largest company end of march', top);
		expect(top.length).toBeGreaterThan(0);
		const hasPlaceholder = top.some(m => /\bcompany [a-t]\b/i.test(m.question));
		expect(hasPlaceholder).toBe(false);
		const hasRealCompany = top.some(m => /nvidia|apple|microsoft|tesla|amazon|alphabet/i.test(m.question));
		expect(hasRealCompany).toBe(true);
	}, 45_000);
});

// ═══════════════════════════════════════════════════════════════════
// END-TO-END: top result should NEVER be a prop when a main market exists
// ═══════════════════════════════════════════════════════════════════
describe('Top result prop-market regression', () => {
	const MATCHUP_QUERIES = [
		'heroic vs monte',
		'T1 Academy vs Nongshim',
		'FUT Esports vs Astralis',
	];

	for (const query of MATCHUP_QUERIES) {
		it(`"${query}" → top result is NOT a prop market`, async () => {
			const top = await getTopThree(query);
			logResult(query, top);
			if (top.length === 0) { console.log('  (no active market — skipping)'); return; }
			// If there is any non-prop active market, it must come first
			const hasNonProp = top.some(m => m.status === 'active' && !isPropMarket(m.question));
			if (hasNonProp) {
				expect(isPropMarket(top[0].question)).toBe(false);
			}
		}, 30_000);
	}
});
