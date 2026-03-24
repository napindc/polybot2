/**
 * Sports search audit — simulates real user queries and validates
 * that the top returned market is relevant.
 * Run with: npx tsx tests/manual/sports-search-audit.ts
 */
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

const provider = new PolymarketApiReadProvider();
const readService = new PolymarketReadService(provider);

interface TestCase {
	query: string;
	expectInTop: string[]; // at least one of these strings must appear in top result question (lowercase)
	expectAbsent?: string[]; // none of these must appear in top result
	allowZeroResults?: boolean; // pass when market is genuinely unavailable
}

const TESTS: TestCase[] = [
	// ── NBA current game matchups ───────────────────────────────────────
	{ query: 'Thunder vs Bulls NBA',              expectInTop: ['thunder', 'bulls'] },
	{ query: 'Pistons vs Cavaliers',              expectInTop: ['pistons', 'cavaliers'] },
	{ query: 'Clippers vs Warriors today',        expectInTop: ['clippers', 'warriors', 'clipper', 'warrior'] },
	{ query: 'Lakers vs Celtics',                 expectInTop: ['lakers', 'celtics'] },
	// ── NBA season markets ─────────────────────────────────────────────
	{ query: 'who will win the NBA championship', expectInTop: ['nba', 'champion'] },
	{ query: 'NBA MVP this season',               expectInTop: ['mvp'] },
	{ query: 'NBA Rookie of the Year',            expectInTop: ['rookie'] },
	{ query: 'NBA playoffs 2026',                 expectInTop: ['nba', 'playoff'] },
	// ── NHL ────────────────────────────────────────────────────────────
	{ query: 'who wins the Stanley Cup',          expectInTop: ['stanley cup', 'nhl'] },
	{ query: 'NHL playoffs',                      expectInTop: ['nhl', 'playoff'] },
	// ── Soccer ────────────────────────────────────────────────────────
	{ query: 'FIFA World Cup 2026 winner',        expectInTop: ['world cup', 'fifa'] },
	{ query: 'UEFA Champions League winner',      expectInTop: ['champions league', 'ucl', 'uefa'] },
	{ query: 'Premier League winner',             expectInTop: ['premier league'] },
	{ query: 'La Liga winner',                    expectInTop: ['la liga'] },
	{ query: 'Bundesliga winner',                 expectInTop: ['bundesliga'] },
	{ query: 'Serie A winner',                    expectInTop: ['serie a'] },
	// ── Golf ──────────────────────────────────────────────────────────
	{ query: 'The Masters winner 2026',           expectInTop: ['masters'], allowZeroResults: true },
	// ── NFL ───────────────────────────────────────────────────────────
	{ query: 'NFL Draft 2026 first pick',         expectInTop: ['nfl', 'draft'] },
	// ── Individual players ────────────────────────────────────────────
	{ query: 'Will Messi play in World Cup 2026', expectInTop: ['messi'] },
	// Note: season-specific player markets (Wembanyama quadruple double,
	// Tatum play this season) removed — those were 2024-25 season markets now resolved.
	// Re-add new season equivalents once fresh markets appear on Polymarket.
	// ── College basketball ────────────────────────────────────────────
	{ query: 'NCAA Tournament winner 2026',       expectInTop: ['ncaa', 'tournament'] },
	// ── Esports (vs-queries handled by esports team detection) ──────────
	// Note: individual match tests (e.g. 3DMAX vs Gaimin) are time-sensitive
	// — only add them while the match has an active market on Polymarket.
	// ── MMA (should return 0, not sports garbage) ─────────────────────
	{ query: 'Maximus Jones vs Tom Gentzsch MMA', expectInTop: ['__EXPECT_ZERO__'] },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function run() {
for (const tc of TESTS) {
	const results = await readService.searchMarketsByText(tc.query);
	const topQ = results[0]?.question?.toLowerCase() ?? '';
	const zeroExpected = tc.expectInTop.includes('__EXPECT_ZERO__');
	if (tc.allowZeroResults && results.length === 0) {
		console.log(`✅ [0 results, acceptable] "${tc.query}"`);
		passed++;
		continue;
	}

	if (zeroExpected) {
		if (results.length === 0) {
			console.log(`✅ [0 results, correct] "${tc.query}"`);
			passed++;
		} else {
			console.log(`❌ [expected 0, got ${results.length}] "${tc.query}" → top: "${results[0]?.question}"`);
			failed++;
			failures.push(tc.query);
		}
		continue;
	}

	const hit = tc.expectInTop.some(kw => topQ.includes(kw));
	const badHit = tc.expectAbsent?.some(kw => topQ.includes(kw)) ?? false;

	if (hit && !badHit) {
		console.log(`✅ "${tc.query}" → "${results[0]?.question}"`);
		passed++;
	} else {
		const reason = !hit ? `missing [${tc.expectInTop.join('|')}]` : `contains banned [${tc.expectAbsent?.join('|')}]`;
		console.log(`❌ "${tc.query}" → "${results[0]?.question ?? '(no results)'}"\n   Reason: ${reason}`);
		failed++;
		failures.push(tc.query);
	}
}

console.log(`\n── Results: ${passed} passed, ${failed} failed ──`);
if (failures.length > 0) {
	console.log('Failed queries:');
	failures.forEach(f => console.log('  •', f));
}
}

run().catch(console.error);
