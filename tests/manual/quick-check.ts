import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';

const p = new PolymarketApiReadProvider();
const s = new PolymarketReadService(p);

const cases: [string, string[]][] = [
	['NBA playoffs 2026',                  ['nba', 'playoff']],
	['Will Messi play in World Cup 2026',  ['messi']],
	['Victor Wembanyama quadruple double', ['wembanyama']],
	['Jayson Tatum play this season',      ['tatum']],
	['NCAA Tournament winner 2026',        ['ncaa', 'tournament']],
];

async function run() {
	for (const [q, kws] of cases) {
		const r = await s.searchMarketsByText(q);
		const top = r[0]?.question?.toLowerCase() ?? '(none)';
		const ok = kws.some(k => top.includes(k));
		console.log(`${ok ? 'PASS' : 'FAIL'} | ${q}\n     => ${top}\n`);
	}
}
run().catch(console.error);
