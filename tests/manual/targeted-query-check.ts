import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

const svc = new PolymarketReadService(new PolymarketApiReadProvider());
const queries = [
  'Nigeria vs Rwanda',
  'New Zealand vs South Africa',
  'Yankees vs Dodgers',
  'UFC heavyweight championship',
  'CS2 esports match',
];

(async () => {
  for (const query of queries) {
    const results = await svc.searchMarketsByText(query);
    console.log('---');
    console.log(`query: ${query}`);
    console.log(`count: ${results.length}`);
    console.log(`top: ${results[0]?.question ?? '(no results)'}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
