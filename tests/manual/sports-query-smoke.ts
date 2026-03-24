import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { PolymarketReadService } from '../../src/read/PolymarketReadService';

const queries = [
  'Louisville Cardinals vs Michigan State Spartans',
  'Missouri Tigers vs Miami Hurricanes',
  'Timberwolves vs Celtics',
  'Reignite vs QT DIG',
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function containsBothSides(question: string, query: string): boolean {
  const q = normalize(query);
  const m = q.match(/^(.+?)\s+vs\s+(.+)$/i);
  if (!m) return false;
  const leftTerms = normalize(m[1]).split(' ').filter((w) => w.length >= 3 && !new Set(['state', 'team', 'match', 'game']).has(w));
  const rightTerms = normalize(m[2]).split(' ').filter((w) => w.length >= 3 && !new Set(['state', 'team', 'match', 'game']).has(w));
  const hay = normalize(question);
  const leftHit = leftTerms.length === 0 ? false : leftTerms.some((t) => hay.includes(t));
  const rightHit = rightTerms.length === 0 ? false : rightTerms.some((t) => hay.includes(t));
  return leftHit && rightHit;
}

async function run(): Promise<void> {
  const svc = new PolymarketReadService(new PolymarketApiReadProvider());

  for (const query of queries) {
    const results = await svc.searchMarketsByText(query);
    const top = results[0];
    const topQuestion = top?.question ?? '<none>';
    const pass = top ? containsBothSides(top.question, query) : false;

    console.log('\n---');
    console.log(`query: ${query}`);
    console.log(`results: ${results.length}`);
    console.log(`top: ${topQuestion}`);
    console.log(`match-pass: ${pass ? 'YES' : 'NO'}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
