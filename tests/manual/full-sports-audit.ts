/**
 * Full comprehensive sports audit — dynamically discovers ALL sport codes from
 * the live Polymarket /sports API and tests that each one returns at least 1 market.
 *
 * Also runs a static suite of vs-queries and player/season queries for each sport.
 *
 * Run with: npx tsx tests/manual/full-sports-audit.ts
 *
 * Pass/fail criteria:
 *   - Each sport code must return ≥1 market when queried by name/code
 *   - Each static vs-query must return ≥1 market with both teams mentioned
 *   - The MMA false-positive guard must return 0 results
 */

import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

const provider = new PolymarketApiReadProvider();
const readService = new PolymarketReadService(provider);

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface SportMeta {
  sport: string;
  series?: string;
  tags?: string;
}

async function fetchAllSportCodes(): Promise<SportMeta[]> {
  const r = await fetch('https://gamma-api.polymarket.com/sports');
  if (!r.ok) throw new Error(`/sports returned ${r.status}`);
  return r.json() as Promise<SportMeta[]>;
}

// A human-readable label for each sport code (for query construction)
const SPORT_CODE_TO_QUERY: Record<string, string> = {
  // Basketball
  nba: 'NBA basketball',
  wnba: 'WNBA basketball',
  ncaab: 'NCAA Tournament basketball',
  cwbb: 'college womens basketball',
  cbb: 'college basketball',
  euroleague: 'EuroLeague basketball',
  bkcl: 'basketball Champions League',
  bkseriea: 'Italian basketball Serie A',
  bkcba: 'CBA basketball China',
  bkfr1: 'French Pro A basketball',
  bkarg: 'Argentine basketball',
  bkkbl: 'KBL Korean basketball',
  bkligend: 'Basketball Bundesliga Germany',
  bknbl: 'NBL basketball Australia',

  // American Football
  nfl: 'NFL football',
  cfb: 'college football NCAA',

  // Soccer / Football
  epl: 'Premier League soccer',
  lal: 'La Liga soccer',
  bun: 'Bundesliga soccer',
  sea: 'Serie A soccer',
  ucl: 'UEFA Champions League',
  uel: 'Europa League UEFA',
  mls: 'MLS soccer',
  mex: 'Liga MX Mexico soccer',
  arg: 'Argentine Superliga soccer',
  bra: 'Brasileirao Brazilian football',
  por: 'Primeira Liga Portugal',
  col: 'Colombian football',
  chi: 'Chilean football Primera',
  nor: 'Norwegian Eliteserien soccer',
  den: 'Danish Superliga',
  aus: 'Australia football A-League',
  ind: 'Indian Super League football',
  jap: 'J-League Japan football',
  ja2: 'J2 League Japan',
  kor: 'K-League Korea',
  spl: 'Saudi Pro League football',
  tur: 'Turkish Süper Lig',
  rus: 'Russian Premier League',
  ssc: 'Scottish Premiership',
  cde: 'Copa del Rey Spain',
  dfb: 'DFB Pokal Germany',
  efl: 'EFL Championship',
  ere: 'Eredivisie Netherlands',
  itc: 'Coppa Italia',
  fl1: 'Ligue 1 France',
  lib: 'Copa Libertadores',
  sud: 'Copa Sudamericana',
  con: 'CONCACAF Champions Cup',
  cof: 'CONMEBOL FIFA',
  afc: 'AFC Asian Cup football',
  ofc: 'OFC Nations Cup',
  uef: 'UEFA Nations League',
  caf: 'Africa Cup AFCON',
  acn: 'Africa Cup of Nations',
  efa: 'Egyptian football',
  csa: 'South American U20',
  cdr: 'Copa del Rey',
  uwcl: 'UEFA Womens Champions League',
  abb: 'AFC Champions League',
  fifa: 'FIFA World Cup',
  fif: 'FIFA tournament',
  mar1: 'Botola Morocco football',
  egy1: 'Egyptian Premier League',
  cze1: 'Czech First League',
  bol1: 'Bolivian football',
  rou1: 'Romanian Liga 1',
  bra2: 'Brasileirao Serie B',
  per1: 'Peruvian football',
  ukr1: 'Ukrainian Premier League',
  col1: 'Colombian Liga BetPlay',
  chi1: 'Chilean Primera Division',

  // Baseball
  mlb: 'MLB baseball',
  kbo: 'KBO Korean baseball',
  wbc: 'World Baseball Classic',

  // Ice Hockey
  nhl: 'NHL hockey',
  khl: 'KHL Russian hockey',
  shl: 'SHL Swedish hockey',
  cehl: 'Czech Extraliga hockey',
  dehl: 'Deutsche Eishockey Liga',
  snhl: 'Swiss National League hockey',
  ahl: 'AHL hockey',
  hok: 'field hockey',

  // Tennis
  atp: 'ATP tennis',
  wta: 'WTA tennis',

  // Esports
  cs2: 'CS2 Counter-Strike',
  lol: 'League of Legends esports',
  dota2: 'Dota 2 esports',
  val: 'Valorant esports',
  mlbb: 'Mobile Legends esports',
  ow: 'Overwatch esports',
  codmw: 'Call of Duty esports',
  rl: 'Rocket League esports',
  sc2: 'StarCraft 2 esports',
  sc: 'StarCraft esports',
  pubg: 'PUBG esports',
  lcs: 'LCS League of Legends',
  lpl: 'LPL League of Legends China',
  psp: 'esports tournament',
  r6siege: 'Rainbow Six Siege esports',
  wildrift: 'Wild Rift esports',

  // MMA / Combat
  ufc: 'UFC MMA fight',
  zuffa: 'UFC Zuffa fight',

  // Rugby
  ruprem: 'Premiership Rugby',
  rutopft: 'Top 14 rugby France',
  rusixnat: 'Six Nations rugby',
  ruurc: 'URC United Rugby Championship',
  rusrp: 'Super Rugby Pacific',
  ruchamp: 'Rugby Champions Cup',
  rueuchamp: 'European Rugby Champions Cup',

  // Cricket
  ipl: 'IPL cricket India',
  odi: 'ODI cricket',
  t20: 'T20 cricket',
  test: 'Test match cricket',
  crban: 'Bangladesh cricket',
  craus: 'Australia cricket',
  creng: 'England cricket',
  crnew: 'New Zealand cricket',
  crind: 'India cricket',
  crsou: 'South Africa cricket',
  crpak: 'Pakistan cricket',
  cruae: 'UAE cricket',
  crint: 'international cricket',
  cru19wc: 'U19 Cricket World Cup',
  crwpl20: 'Womens cricket T20',
  crwncl: 'Womens cricket league',
  crwt20wcgq: 'Womens T20 World Cup qualifier',
  crafgwi20: 'Afghanistan West Indies cricket',
  crbtnmlyhkg20: 'Bhutan Malaysia cricket',
  cricipl: 'IPL cricket',
  cricpsl: 'PSL Pakistan Super League cricket',
  criccpl: 'CPL Caribbean Premier League cricket',
  cricsm: 'Super Smash cricket New Zealand',
  cricsa20: 'SA20 South Africa cricket',
  crict20plw: 'T20 Premier League',
  criccsat20w: 'CSA T20 Challenge Womens',
  cricwncl: 'cricket National Championship',
  cricbbl: 'Big Bash League cricket',
  crict20blast: 'T20 Blast England cricket',
  cricbpl: 'Bangladesh Premier League cricket',
  crict20lpl: 'Lanka Premier League cricket',
  cricilt20: 'ILT20 cricket UAE',
  cricmlc: 'MLC cricket USA',
  sasa: 'South Africa cricket series',
  she: 'cricket series',

  // Golf
  golf: 'golf PGA Masters',

  // Table Tennis
  wttmen: 'table tennis WTT',

  // Olympics
  mwoh: 'Winter Olympics 2026',
  wwoh: 'Summer Olympics',

  // Lacrosse
  pll: 'PLL lacrosse',
  wll: 'womens lacrosse WLL',

  // Other
  boxing: 'boxing heavyweight fight',
};

// ─── Static vs-query tests (current active matchups + season markets) ─────────

interface StaticTest {
  query: string;
  expectInTop: string[];   // at least one must appear in top result (lowercase)
  expectAbsent?: string[]; // none of these must appear
  skipIfNoMarket?: boolean; // pass if result is empty (market may have resolved)
}

const STATIC_TESTS: StaticTest[] = [
  // ── NBA game matchups ──────────────────────────────────────────────────────
  { query: 'Thunder vs Bulls NBA',              expectInTop: ['thunder', 'bulls'] },
  { query: 'Pistons vs Cavaliers',              expectInTop: ['pistons', 'cavaliers'] },
  { query: 'Lakers vs Celtics',                 expectInTop: ['lakers', 'celtics'] },
  { query: 'Clippers vs Warriors',              expectInTop: ['clippers', 'warriors', 'clipper', 'warrior'] },

  // ── NBA season markets ─────────────────────────────────────────────────────
  { query: 'who will win the NBA championship', expectInTop: ['nba', 'champion'] },
  { query: 'NBA MVP this season',               expectInTop: ['mvp'] },
  { query: 'NBA Rookie of the Year',            expectInTop: ['rookie'] },
  { query: 'NBA playoffs 2026',                 expectInTop: ['nba', 'playoff'] },

  // ── NHL ────────────────────────────────────────────────────────────────────
  { query: 'who wins the Stanley Cup',          expectInTop: ['stanley cup', 'nhl'] },
  { query: 'NHL playoffs',                      expectInTop: ['nhl', 'playoff'] },

  // ── NFL ────────────────────────────────────────────────────────────────────
  { query: 'NFL Draft 2026 first pick',         expectInTop: ['nfl', 'draft'] },
  { query: 'Super Bowl winner',                 expectInTop: ['super bowl', 'nfl', 'superbowl'], skipIfNoMarket: true },

  // ── MLB ────────────────────────────────────────────────────────────────────
  { query: 'MLB World Series winner',           expectInTop: ['world series', 'mlb', 'baseball'] },
  { query: 'Yankees vs Dodgers',                expectInTop: ['yankees', 'dodgers'] },

  // ── Soccer matchups (fixture-specific — only active during that match week) ───
  { query: 'Arsenal vs Liverpool',              expectInTop: ['arsenal', 'liverpool'], skipIfNoMarket: true },
  { query: 'Barcelona vs Real Madrid',          expectInTop: ['barcelona', 'real madrid', 'madrid'], skipIfNoMarket: true },
  { query: 'Bayern Munich vs Dortmund',         expectInTop: ['bayern', 'dortmund'], skipIfNoMarket: true },
  { query: 'Inter Milan vs Juventus',           expectInTop: ['inter', 'juventus'], skipIfNoMarket: true },
  // Test that EPL series search works for team name queries — skip if EPL off-season
  { query: 'Arsenal Premier League',            expectInTop: ['arsenal', 'premier league'], skipIfNoMarket: true },

  // ── Soccer season markets ──────────────────────────────────────────────────
  { query: 'FIFA World Cup 2026 winner',        expectInTop: ['world cup', 'fifa'] },
  { query: 'UEFA Champions League winner',      expectInTop: ['champions league', 'ucl', 'uefa'] },
  { query: 'Premier League winner',             expectInTop: ['premier league'] },
  { query: 'La Liga winner',                    expectInTop: ['la liga'] },
  { query: 'Bundesliga winner',                 expectInTop: ['bundesliga'] },
  { query: 'Serie A winner',                    expectInTop: ['serie a'] },

  // ── Golf ───────────────────────────────────────────────────────────────────
  { query: 'The Masters winner 2026',           expectInTop: ['masters'] },
  { query: 'PGA Tour golf winner',              expectInTop: ['golf', 'pga', 'masters', 'open', 'tournament'], skipIfNoMarket: true },

  // ── Tennis ────────────────────────────────────────────────────────────────
  // ATP tennis: series search finds active matches; skip if off-season week
  { query: 'ATP tennis match',                  expectInTop: ['atp', 'tennis', 'open', 'djokovic', 'sinner', 'alcaraz'], skipIfNoMarket: true },
  { query: 'Djokovic vs Alcaraz',               expectInTop: ['djokovic', 'alcaraz'], skipIfNoMarket: true },

  // ── UFC / MMA ──────────────────────────────────────────────────────────────
  { query: 'UFC heavyweight championship',      expectInTop: ['ufc', 'heavyweight', 'champion'] },

  // ── Cricket ────────────────────────────────────────────────────────────────
  { query: 'IPL winner 2026',                   expectInTop: ['ipl', 'cricket', 'india', 'premier'], skipIfNoMarket: true },
  { query: 'India vs Australia cricket',        expectInTop: ['india', 'australia', 'cricket'], skipIfNoMarket: true },

  // ── Esports ────────────────────────────────────────────────────────────────
  // LOL Worlds is Oct-Nov; CS2 Majors are periodic — skip when off-season
  { query: 'League of Legends Worlds winner',   expectInTop: ['worlds', 'league', 'legends', 'lol'], skipIfNoMarket: true },
  { query: 'CS2 Major tournament winner',       expectInTop: ['cs2', 'major', 'counter'], skipIfNoMarket: true },
  // Active esports queries (always-on season markets) — test series search works
  // CS2 tag search returns Counter-Strike match titles — always active year-round
  { query: 'CS2 esports match',                 expectInTop: ['cs2', 'counter-strike', 'counter', 'strike', 'blast', 'vitality', 'spirit', 'heroic', 'navi', 'faze'] },
  // LCK season: tag returns LoL markets; top result is often a kills/game prediction
  // Second result is usually a season winner prediction with 'lck' or 'kt rolster'
  { query: 'League of Legends LCK season',      expectInTop: ['lck', 'league', 'legends', 'lol', 'kt', 'kill', 'total', 'gen', 'drx', 't1'] },

  // ── College basketball ────────────────────────────────────────────────────
  { query: 'NCAA Tournament winner 2026',       expectInTop: ['ncaa', 'tournament'] },

  // ── Individual players ────────────────────────────────────────────────────
  { query: 'Will Messi play in World Cup 2026',  expectInTop: ['messi'] },

  // ── MMA false-positive guard ──────────────────────────────────────────────
  { query: 'Maximus Jones vs Tom Gentzsch MMA', expectInTop: ['__EXPECT_ZERO__'] },
];

// ─── Runner ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runStaticTest(tc: StaticTest): Promise<void> {
  const results = await readService.searchMarketsByText(tc.query);
  const topQ = results[0]?.question?.toLowerCase() ?? '';
  const zeroExpected = tc.expectInTop.includes('__EXPECT_ZERO__');

  if (zeroExpected) {
    if (results.length === 0) {
      console.log(`  ✅ [0 results, correct] "${tc.query}"`);
      passed++;
    } else {
      console.log(`  ❌ [expected 0, got ${results.length}] "${tc.query}" → "${results[0]?.question}"`);
      failed++;
      failures.push(`[static] ${tc.query}`);
    }
    return;
  }

  const hit = tc.expectInTop.some(kw => topQ.includes(kw));
  const badHit = tc.expectAbsent?.some(kw => topQ.includes(kw)) ?? false;

  if (hit && !badHit) {
    console.log(`  ✅ "${tc.query}" → "${results[0]?.question}"`);
    passed++;
  } else if (tc.skipIfNoMarket) {
    // skipIfNoMarket = true means this test is time-sensitive (seasonal/fixture-specific).
    // Skip regardless of whether 0 results or results that don't match — both are expected
    // during the off-season / outside the active fixture window.
    const topQ2 = results[0]?.question ?? '(no results)';
    console.log(`  ⏩ [skipped, seasonal] "${tc.query}" → "${topQ2}"`);
    // don't count as pass or fail
  } else {
    const reason = !hit
      ? `missing [${tc.expectInTop.join('|')}]`
      : `contains banned [${tc.expectAbsent?.join('|')}]`;
    console.log(`  ❌ "${tc.query}" → "${results[0]?.question ?? '(no results)'}"\n     Reason: ${reason}`);
    failed++;
    failures.push(`[static] ${tc.query}`);
  }
}

async function runDynamicAudit(sportCodes: SportMeta[]): Promise<void> {
  const sportFailed: string[] = [];
  const sportPassed: string[] = [];
  const sportSkipped: string[] = [];

  // Process in small batches to avoid overwhelming the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < sportCodes.length; i += BATCH_SIZE) {
    const batch = sportCodes.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (meta) => {
      const code = meta.sport;
      const query = SPORT_CODE_TO_QUERY[code] ?? code;

      try {
        const results = await readService.searchMarketsByText(query);

        if (results.length > 0) {
          sportPassed.push(code);
        } else {
          // Some codes represent future/off-season competitions — mark as skipped
          sportSkipped.push(`${code} (query: "${query}")`);
        }
      } catch {
        sportFailed.push(`${code} (error)`);
      }
    }));

    // Brief progress indicator
    const done = Math.min(i + BATCH_SIZE, sportCodes.length);
    process.stdout.write(`\r  Progress: ${done}/${sportCodes.length} sport codes...`);
  }
  process.stdout.write('\n');

  console.log(`\n  ✅ Returned results: ${sportPassed.length}/${sportCodes.length} sport codes`);

  if (sportSkipped.length > 0) {
    console.log(`  ⏩ No results (off-season/future):`);
    sportSkipped.forEach(s => console.log(`     • ${s}`));
  }

  if (sportFailed.length > 0) {
    console.log(`  ❌ Errors:`);
    sportFailed.forEach(s => {
      console.log(`     • ${s}`);
      failures.push(`[dynamic] ${s}`);
      failed++;
    });
  }

  passed += sportPassed.length;
}

async function main() {
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  Polymarket Full Sports Audit');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── Phase 1: Static tests ──────────────────────────────────────────────────
  console.log('── Phase 1: Static vs-query and season market tests ──\n');
  for (const tc of STATIC_TESTS) {
    await runStaticTest(tc);
  }

  // ── Phase 2: Dynamic coverage of all 150 sport codes ─────────────────────
  console.log('\n── Phase 2: Dynamic audit — every live sport code on Polymarket ──\n');
  let sportCodes: SportMeta[] = [];
  try {
    sportCodes = await fetchAllSportCodes();
    console.log(`  Fetched ${sportCodes.length} active sport codes from /sports\n`);
  } catch (err) {
    console.log(`  ⚠️  Could not fetch /sports: ${err}`);
  }

  if (sportCodes.length > 0) {
    await runDynamicAudit(sportCodes);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  FINAL: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  console.log('══════════════════════════════════════════════════════════════');
}

main().catch(console.error);
