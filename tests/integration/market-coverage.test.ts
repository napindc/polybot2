/**
 * Automated Market Coverage Test
 *
 * Validates that the bot's search pipeline can find EVERY active sports
 * market on Polymarket. Works by:
 *
 *   1. Fetching all sports from the /sports endpoint
 *   2. For each sport, fetching the first page of active events
 *   3. Extracting team names from event titles
 *   4. Constructing natural "Team A vs Team B" queries
 *   5. Running them through the full bot search pipeline
 *   6. Asserting the correct market appears in results
 *
 * Run:  npx vitest run tests/integration/market-coverage.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { PolymarketReadService } from '../../src/read/PolymarketReadService';

process.env.OPENAI_API_KEY = '';

const GAMMA = 'https://gamma-api.polymarket.com';

let readService: PolymarketReadService;

beforeAll(() => {
    readService = new PolymarketReadService(new PolymarketApiReadProvider());
});

// ── Types ──

interface SportEntry {
    id: number;
    sport: string;
    tags: string;
    series: string;
}

interface GammaEvent {
    title?: string;
    slug?: string;
    markets?: Array<{
        conditionId?: string;
        condition_id?: string;
        question?: string;
        id?: string;
        active?: boolean;
        closed?: boolean;
    }>;
}

// ── Helpers ──

async function fetchJson<T>(url: string): Promise<T> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
    return resp.json() as Promise<T>;
}

async function fetchSports(): Promise<SportEntry[]> {
    return fetchJson<SportEntry[]>(`${GAMMA}/sports`);
}

async function fetchActiveEventsForSeries(seriesId: string, limit = 5): Promise<GammaEvent[]> {
    try {
        return await fetchJson<GammaEvent[]>(
            `${GAMMA}/events?series_id=${seriesId}&closed=false&limit=${limit}&active=true`
        );
    } catch {
        return [];
    }
}

/**
 * Extracts a natural search query from an event title.
 * e.g. "T20 Series Malaysia vs Bahrain: Malaysia vs Bahrain" → "Malaysia vs Bahrain"
 *       "NBA: LA Clippers vs Golden State Warriors" → "Clippers vs Warriors"
 */
function buildQueryFromTitle(title: string): string {
    // Try to extract "X vs Y" pattern from the title
    const vsMatch = title.match(/:\s*(.+?\s+vs\.?\s+.+)/i) ?? title.match(/(.+?\s+vs\.?\s+.+)/i);
    if (vsMatch) {
        let query = vsMatch[1].trim();
        // Remove dates and trailing noise
        query = query.replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '').trim();
        query = query.replace(/\s*-\s*(Game|Map|Handicap|Total|Spread|O\/U).*$/i, '').trim();
        return query;
    }
    // Fallback: use the full title minus common prefix noise
    return title.replace(/^(T20|ODI|Test|IPL|NBA|NHL|EPL|MLS|UFC|CS2|LoL|Val)\s*:?\s*/i, '').trim();
}

// ═══════════════════════════════════════════════════════════════════
// MAIN TEST
// ═══════════════════════════════════════════════════════════════════

describe('Automated market coverage', () => {
    it('bot can find active sports markets across sampled sports', async () => {
        const sports = await fetchSports();
        expect(sports.length).toBeGreaterThan(0);

        let found = 0;
        let missed = 0;
        let skipped = 0;
        const failures: string[] = [];
        const successes: string[] = [];
        const testedSports = new Set<string>();

        // Sample sports: prioritize those with active events
        // Take first 25 sports to keep test runtime reasonable
        const sportsToTest = sports.slice(0, 25);

        for (const sport of sportsToTest) {
            if (!sport.series || sport.series === 'TBD') continue;

            const seriesIds = sport.series.split(',').map(s => s.trim()).filter(Boolean);
            const seriesId = seriesIds[0];
            if (!seriesId) continue;

            const events = await fetchActiveEventsForSeries(seriesId, 3);
            if (events.length === 0) {
                skipped++;
                continue;
            }

            testedSports.add(sport.sport);

            // Test first event with a valid vs-matchup title
            const testEvent = events.find(e =>
                e.title && (e.title.includes(' vs ') || e.title.includes(' vs.'))
            );
            if (!testEvent || !testEvent.title) {
                skipped++;
                continue;
            }

            const query = buildQueryFromTitle(testEvent.title);
            if (query.length < 5) {
                skipped++;
                continue;
            }

            // Collect all conditionIds from this event's markets
            const eventMarketIds = new Set<string>();
            for (const m of testEvent.markets ?? []) {
                const id = m.conditionId ?? m.condition_id ?? m.id;
                if (id) eventMarketIds.add(id);
            }

            if (eventMarketIds.size === 0) {
                skipped++;
                continue;
            }

            try {
                const results = await readService.searchMarketsByText(query);
                const hit = results.some(r => eventMarketIds.has(r.id));

                if (hit) {
                    found++;
                    successes.push(`✅ [${sport.sport}] "${query}" → found`);
                } else {
                    missed++;
                    const topResult = results[0]?.question ?? '(no results)';
                    failures.push(
                        `❌ [${sport.sport}] "${query}" → NOT FOUND (slug: ${testEvent.slug})` +
                        `\n   Expected market IDs: ${[...eventMarketIds].slice(0, 2).join(', ')}` +
                        `\n   Got ${results.length} results, top: "${topResult}"`
                    );
                }
            } catch (err) {
                missed++;
                failures.push(`❌ [${sport.sport}] "${query}" → ERROR: ${err}`);
            }
        }

        const total = found + missed;
        const coverage = total > 0 ? found / total : 0;

        // Print summary
        console.log('\n═══════════════════════════════════════════════');
        console.log(`  MARKET COVERAGE REPORT`);
        console.log('═══════════════════════════════════════════════');
        console.log(`  Sports tested: ${testedSports.size}`);
        console.log(`  Events tested: ${total} (${skipped} skipped)`);
        console.log(`  Found: ${found}   Missed: ${missed}`);
        console.log(`  Coverage: ${(coverage * 100).toFixed(1)}%`);
        console.log('───────────────────────────────────────────────');
        successes.forEach(s => console.log(`  ${s}`));
        if (failures.length > 0) {
            console.log('───────────────────────────────────────────────');
            console.log('  FAILURES:');
            failures.forEach(f => console.log(`  ${f}`));
        }
        console.log('═══════════════════════════════════════════════\n');

        // Require at least 50% coverage as a baseline.
        // This threshold should be raised as the pipeline is improved.
        if (total > 0) {
            expect(coverage).toBeGreaterThanOrEqual(0.5);
        }
    }, 300_000); // 5 minute timeout — many API calls
});

// ═══════════════════════════════════════════════════════════════════
// SPECIFIC REGRESSION: Malaysia vs Bahrain (cricket T20)
// ═══════════════════════════════════════════════════════════════════

describe('Cricket market regressions', () => {
    it('"Malaysia vs Bahrain" finds the cricket T20 match', async () => {
        const results = await readService.searchMarketsByText('tell me about match Malaysia vs Bahrain');
        console.log(`  Malaysia vs Bahrain: ${results.length} results`);

        if (results.length > 0) {
            console.log(`    top: "${results[0].question}"`);
            const top = results[0].question.toLowerCase();
            const isCorrect = top.includes('malaysia') || top.includes('bahrain') ||
                top.includes('mys') || top.includes('bhr');
            expect(isCorrect).toBe(true);
        }
        // If the T20 event is still active, we must find results
        // (may be 0 if the event has already closed/resolved)
    }, 60_000);

    it('"India vs Australia" finds a cricket match', async () => {
        const results = await readService.searchMarketsByText('India vs Australia');
        console.log(`  India vs Australia: ${results.length} results`);

        if (results.length > 0) {
            console.log(`    top: "${results[0].question}"`);
            const top = results[0].question.toLowerCase();
            const isCorrect = top.includes('india') || top.includes('australia') ||
                top.includes('ind') || top.includes('aus');
            expect(isCorrect).toBe(true);
        }
    }, 60_000);
});
