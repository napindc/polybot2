import { createPolymarketApiReadProvider } from './src/read/PolymarketApiReadProvider';
import { PolymarketReadService } from './src/read/PolymarketReadService';
const svc = new PolymarketReadService(createPolymarketApiReadProvider());
const r = await svc.searchMarketsByText('Maximus Jones vs Tom Gentzsch');
console.log('results:', r.length);
for (const m of r.slice(0, 5)) {
  console.log(` slug=${m.slug} status=${m.status} q=${m.question.slice(0, 70)}`);
}
