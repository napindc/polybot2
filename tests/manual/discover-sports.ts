/**
 * Discovers all active sport tags on Polymarket via the Gamma API.
 * Prints unique sport codes, their market counts, and sample events.
 * Run with: npx tsx tests/manual/discover-sports.ts
 */

interface SportEvent {
  sport: string;
  seriesId?: string;
  title?: string;
  homeTeam?: string;
  awayTeam?: string;
  startDate?: string;
}

interface GammaTag {
  id: number;
  label: string;
  slug: string;
  forceShow?: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  active: boolean;
  markets: { id: string; question: string; active: boolean }[];
  tags?: GammaTag[];
}

// Fetch all sports from Gamma /sports
async function fetchAllSports(): Promise<SportEvent[]> {
  const results: SportEvent[] = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const url = `https://gamma-api.polymarket.com/sports?limit=${limit}&offset=${offset}&active=true&order=startDate&ascending=true`;
    const r = await fetch(url);
    if (!r.ok) break;
    const batch = await r.json() as SportEvent[];
    if (batch.length === 0) break;
    results.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return results;
}

// Fetch all events tagged "sports" to find non-series sports markets
async function fetchSportsTags(): Promise<GammaTag[]> {
  const r = await fetch('https://gamma-api.polymarket.com/tags?limit=500');
  if (!r.ok) return [];
  const tags = await r.json() as GammaTag[];
  // Find tags that appear to be sports-related
  return tags.filter(t =>
    t.label.toLowerCase().includes('sport') ||
    t.label.toLowerCase().includes('nba') ||
    t.label.toLowerCase().includes('nfl') ||
    t.label.toLowerCase().includes('nhl') ||
    t.label.toLowerCase().includes('mlb') ||
    t.label.toLowerCase().includes('soccer') ||
    t.label.toLowerCase().includes('tennis') ||
    t.label.toLowerCase().includes('golf') ||
    t.label.toLowerCase().includes('mma') ||
    t.label.toLowerCase().includes('boxing') ||
    t.label.toLowerCase().includes('esports') ||
    t.label.toLowerCase().includes('cricket') ||
    t.label.toLowerCase().includes('football')
  );
}

async function run() {
  console.log('Fetching live sports data from Gamma API...\n');

  const [sports, tags] = await Promise.all([fetchAllSports(), fetchSportsTags()]);

  // Tally unique sport codes
  const codeMap = new Map<string, { count: number; samples: string[] }>();
  for (const s of sports) {
    const code = s.sport;
    if (!codeMap.has(code)) codeMap.set(code, { count: 0, samples: [] });
    const entry = codeMap.get(code)!;
    entry.count++;
    const name = s.homeTeam && s.awayTeam
      ? `${s.homeTeam} vs ${s.awayTeam}`
      : (s.title ?? '');
    if (entry.samples.length < 2 && name) entry.samples.push(name);
  }

  const sorted = [...codeMap.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`─── ${sports.length} active sport events across ${sorted.length} sport codes ───\n`);
  for (const [code, { count, samples }] of sorted) {
    const sample = samples[0] ? ` → e.g. "${samples[0]}"` : '';
    console.log(`  ${code.padEnd(12)} ${String(count).padStart(4)} events${sample}`);
  }

  console.log(`\n─── Sport codes list (for COMMON_SPORT_CODES) ───`);
  console.log(sorted.map(([code]) => `'${code}'`).join(', '));

  console.log(`\n─── Relevant sports tags found (${tags.length}) ───`);
  tags.slice(0, 40).forEach(t => console.log(`  ${t.slug.padEnd(30)} "${t.label}"`));
}

run().catch(console.error);
