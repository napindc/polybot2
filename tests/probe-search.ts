/**
 * Comprehensive search probe — tests 40+ real-world queries against the
 * live bot pipeline and reports which ones return WRONG or MISSING results.
 *
 * Run:  npx tsx tests/probe-search.ts
 */

import { PolymarketApiReadProvider } from '../src/read/PolymarketApiReadProvider';
import { PolymarketReadService } from '../src/read/PolymarketReadService';

process.env.OPENAI_API_KEY = '';

const provider = new PolymarketApiReadProvider();
const readService = new PolymarketReadService(provider);

interface TestCase {
	query: string;
	/** At least one of these keywords must appear in the top result's question */
	expectKeywords: string[];
	/** Keywords that should NOT appear (to catch wrong-category results) */
	rejectKeywords?: string[];
}

const TESTS: TestCase[] = [
	// ── NBA Matchups ──
	{ query: 'Clippers vs Warriors', expectKeywords: ['clipper', 'warrior'], rejectKeywords: ['starcraft', 'call of duty', 'league of legends'] },
	{ query: 'Celtics vs Bucks', expectKeywords: ['celtic', 'buck'], rejectKeywords: ['starcraft'] },
	{ query: 'Lakers vs Nuggets', expectKeywords: ['laker', 'nugget'], rejectKeywords: ['starcraft'] },
	{ query: 'Knicks vs Raptors', expectKeywords: ['knick', 'raptor'], rejectKeywords: ['starcraft'] },
	{ query: 'Thunder vs Bulls', expectKeywords: ['thunder', 'bull'], rejectKeywords: ['starcraft'] },
	{ query: 'Heat vs Hornets', expectKeywords: ['heat', 'hornet'], rejectKeywords: ['starcraft'] },
	{ query: 'Mavericks vs Celtics', expectKeywords: ['maverick', 'celtic'], rejectKeywords: ['starcraft'] },

	// ── NBA General ──
	{ query: 'NBA champion 2026', expectKeywords: ['nba', 'champion'], rejectKeywords: ['starcraft'] },
	{ query: 'who will win the NBA finals', expectKeywords: ['nba', 'champion', 'finals'], rejectKeywords: ['starcraft'] },

	// ── NFL ──
	{ query: 'Super Bowl winner', expectKeywords: ['super bowl', 'nfl', 'champion', 'chiefs', 'eagles', 'win', 'bowl'], rejectKeywords: ['starcraft'] },
	{ query: 'Chiefs vs Eagles', expectKeywords: ['chief', 'eagle'], rejectKeywords: ['starcraft'] },

	// ── Soccer ──
	{ query: 'Champions League winner', expectKeywords: ['champion', 'league', 'ucl', 'uefa'], rejectKeywords: ['starcraft'] },
	{ query: 'Premier League', expectKeywords: ['premier', 'league', 'epl', 'relegat'], rejectKeywords: ['starcraft'] },

	// ── Crypto ──
	{ query: 'bitcoin price', expectKeywords: ['bitcoin', 'btc'] },
	{ query: 'will ethereum hit 5000', expectKeywords: ['ethereum', 'eth'] },
	{ query: 'solana price prediction', expectKeywords: ['solana', 'sol'] },
	{ query: 'XRP price', expectKeywords: ['xrp', 'ripple'] },
	{ query: 'dogecoin', expectKeywords: ['doge', 'dogecoin'] },

	// ── Politics ──
	{ query: 'presidential election 2028', expectKeywords: ['president', 'nominee', '2028', 'election'] },
	{ query: 'Trump', expectKeywords: ['trump'] },
	{ query: 'who will be the next president', expectKeywords: ['president', 'nominee', 'election'] },

	// ── Finance ──
	{ query: 'S&P 500 today', expectKeywords: ['s&p', 'spx', '500', 'opens'] },
	{ query: 'will the stock market crash', expectKeywords: ['s&p', 'spx', 'stock', 'market', 'crash', 'recession', 'bear'] },
	{ query: 'Nasdaq', expectKeywords: ['nasdaq', 'qqq', 'tech', 'stock'] },

	// ── Economy ──
	{ query: 'Fed interest rate', expectKeywords: ['fed', 'interest', 'rate', 'fomc'] },
	{ query: 'inflation rate', expectKeywords: ['inflation', 'cpi'] },
	{ query: 'recession 2026', expectKeywords: ['recession', 'gdp', 'economy'] },

	// ── Geopolitics ──
	{ query: 'Ukraine Russia war', expectKeywords: ['ukrain', 'russia', 'war', 'peace', 'ceasefire'] },
	{ query: 'Iran sanctions', expectKeywords: ['iran', 'sanction', 'nuclear', 'khamenei'] },
	{ query: 'China Taiwan', expectKeywords: ['china', 'taiwan', 'chinese'] },

	// ── Tech ──
	{ query: 'will AI replace jobs', expectKeywords: ['ai', 'artificial', 'jobs', 'replace', 'automat', 'agi'] },
	{ query: 'Apple stock', expectKeywords: ['apple', 'aapl', 'largest', 'company', 'stock'] },
	{ query: 'OpenAI GPT', expectKeywords: ['openai', 'gpt', 'chatgpt', 'ai'] },

	// ── Culture ──
	{ query: 'Oscars best picture', expectKeywords: ['oscar', 'best picture', 'academy', 'award'] },

	// ── Recurring Series (successor lookup) ──
	{ query: 'Largest Company end of March', expectKeywords: ['nvidia', 'apple', 'tesla', 'largest', 'company'], rejectKeywords: ['company a', 'company b', 'company c'] },

	// ── Esports ──
	{ query: 'T1 vs Gen.G', expectKeywords: ['t1', 'gen', 'geng', 'lol', 'lck'], rejectKeywords: ['nba', 'nfl'] },
	{ query: 'Valorant champions', expectKeywords: ['valorant', 'vct', 'champion'] },

	// ── UFC/MMA ──
	{ query: 'UFC next fight', expectKeywords: ['ufc', 'mma', 'fight'] },

	// ── Trending/General ──
	{ query: 'what is trending', expectKeywords: [] },  // anything non-empty is fine
	{ query: 'show me the latest markets', expectKeywords: [] },

	// ── Edge cases ──
	{ query: 'asdfghjkl gibberish', expectKeywords: [] },  // should return empty, not garbage
];

async function runProbe() {
	console.log(`\n${'═'.repeat(70)}`);
	console.log(`  SEARCH PROBE — ${TESTS.length} queries against live pipeline`);
	console.log(`${'═'.repeat(70)}\n`);

	let passed = 0;
	let failed = 0;
	let warnings = 0;
	const failures: string[] = [];

	for (const test of TESTS) {
		try {
			const results = await readService.searchMarketsByText(test.query);
			const top = results[0]?.question ?? '';
			const topLower = top.toLowerCase();
			const count = results.length;

			// Check for rejected keywords in ALL results (not just top)
			if (test.rejectKeywords && test.rejectKeywords.length > 0) {
				const badResults = results.filter(m => {
					const q = m.question.toLowerCase();
					return test.rejectKeywords!.some(kw => q.includes(kw.toLowerCase()));
				});
				if (badResults.length > 0) {
					const msg = `FAIL  "${test.query}" → got WRONG category: "${badResults[0].question}"`;
					console.log(`  ❌ ${msg}`);
					failures.push(msg);
					failed++;
					continue;
				}
			}

			// For trending/general queries, just check non-empty
			if (test.expectKeywords.length === 0) {
				if (test.query.includes('gibberish')) {
					// Gibberish should return few/no results
					if (count <= 5) {
						console.log(`  ✅ "${test.query}" → ${count} results (correctly minimal)`);
						passed++;
					} else {
						const msg = `WARN  "${test.query}" → ${count} results (expected ≤5)`;
						console.log(`  ⚠️  ${msg}`);
						warnings++;
					}
				} else {
					if (count > 0) {
						console.log(`  ✅ "${test.query}" → ${count} results, top: "${top}"`);
						passed++;
					} else {
						const msg = `FAIL  "${test.query}" → 0 results`;
						console.log(`  ❌ ${msg}`);
						failures.push(msg);
						failed++;
					}
				}
				continue;
			}

			// Check if expected keywords appear in top result
			const hasMatch = test.expectKeywords.some(kw => topLower.includes(kw.toLowerCase()));

			if (count === 0) {
				// No results — might be OK if market doesn't exist on Polymarket
				const msg = `WARN  "${test.query}" → 0 results (market may not exist)`;
				console.log(`  ⚠️  ${msg}`);
				warnings++;
			} else if (hasMatch) {
				console.log(`  ✅ "${test.query}" → ${count} results, top: "${top}"`);
				passed++;
			} else {
				// Check if ANY result matches (not just top)
				const anyMatch = results.some(m =>
					test.expectKeywords.some(kw => m.question.toLowerCase().includes(kw.toLowerCase()))
				);
				if (anyMatch) {
					console.log(`  ✅ "${test.query}" → ${count} results (match in results, not top). Top: "${top}"`);
					passed++;
				} else {
					const msg = `FAIL  "${test.query}" → ${count} results but NONE match expected keywords [${test.expectKeywords.join(', ')}]. Top: "${top}"`;
					console.log(`  ❌ ${msg}`);
					failures.push(msg);
					failed++;
				}
			}
		} catch (err) {
			const msg = `FAIL  "${test.query}" → ERROR: ${err}`;
			console.log(`  ❌ ${msg}`);
			failures.push(msg);
			failed++;
		}
	}

	console.log(`\n${'═'.repeat(70)}`);
	console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${warnings} warnings`);
	if (failures.length > 0) {
		console.log(`\n  FAILURES:`);
		for (const f of failures) {
			console.log(`    • ${f}`);
		}
	}
	console.log(`${'═'.repeat(70)}\n`);

	process.exit(failed > 0 ? 1 : 0);
}

runProbe().catch(err => {
	console.error('Probe crashed:', err);
	process.exit(2);
});
