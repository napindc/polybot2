import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

const p = new PolymarketApiReadProvider();
const s = new PolymarketReadService(p);

// Fetch EFL series directly to see slug/title format
const r = await fetch('https://gamma-api.polymarket.com/sports');
const data = await r.json() as Array<{ sport: string; series?: string }>;
const efl = data.find(d => d.sport === 'efl');
console.log('EFL entry:', JSON.stringify(efl));

if (efl?.series) {
  const seriesId = efl.series.split(',')[0].trim();
  const eventsResp = await fetch(`https://gamma-api.polymarket.com/events?series_id=${seriesId}&closed=false&limit=10`);
  const events = await eventsResp.json() as Array<{ title?: string; slug?: string }>;
  console.log('\nSample EFL events:');
  events.slice(0, 8).forEach(e => console.log(' ', e.slug, '|', e.title));
}

// Test the two queries
console.log('\n--- Query tests ---');
for (const q of ['LEE vs SUN', 'Leeds United FC vs Sunderland AFC']) {
  const results = await s.searchMarketsByText(q);
  console.log(`"${q}" → ${results.length} results, top: "${results[0]?.question ?? 'none'}"`);
}
