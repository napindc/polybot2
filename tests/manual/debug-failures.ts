import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

async function main() {
  const p = new PolymarketApiReadProvider();
  const s = new PolymarketReadService(p);
  const tests = [
    'Super Bowl winner',
    'Arsenal vs Liverpool',
    'US Open golf winner',
    'ATP tennis tournament',
    'League of Legends Worlds winner',
    'CS2 match today',
    'League of Legends LCK match',
  ];
  for (const q of tests) {
    const r = await s.searchMarketsByText(q);
    console.log(`\n"${q}" -> ${r.length} results`);
    r.slice(0, 2).forEach(m => console.log(`  - [${m.status}] ${m.question}`));
  }
}
main().catch(console.error);
