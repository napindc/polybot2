import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';

async function run() {
	const p = new PolymarketApiReadProvider();
	const r = await p.searchMarkets('tell me about 3DMAX vs Gaimin Gladiators market');
	console.log('RESULTS:', r.length);
	r.slice(0, 3).forEach(m => console.log('MARKET:', m.question, '| status:', m.status));
	if (r.length === 0) {
		console.log('FAIL — no results');
		process.exit(1);
	} else {
		console.log('PASS');
	}
}
run();
