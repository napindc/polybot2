import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';

const provider = new PolymarketApiReadProvider();
const svc = new PolymarketReadService(provider);

async function test(q: string) {
  const r = await svc.searchMarketsByText(q);
  console.log(`\n"${q}" -> ${r.length} results`);
  r.slice(0, 3).forEach((m, i) => console.log(`  ${i + 1}. ${m.question}`));
}

(async () => {
  await test('CS2 esports match');
  await test('League of Legends LCK season');
  await test('Arsenal Premier League');
})();
