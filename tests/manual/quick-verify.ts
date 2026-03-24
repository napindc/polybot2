import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

async function main() {
  const p = new PolymarketApiReadProvider();
  const s = new PolymarketReadService(p);
  const tests = [
    'ATP tennis tournament',
    'CS2 match today',
    'League of Legends LCK match',
    'Super Bowl winner',
    'Bayern Munich vs Dortmund',
  ];
  for (const q of tests) {
    const r = await s.searchMarketsByText(q);
    console.log((r.length > 0 ? '✅' : '⏩') + ' ' + JSON.stringify(q) + ' -> ' + (r[0]?.question ?? 'no results'));
  }
}
main().catch(console.error);
