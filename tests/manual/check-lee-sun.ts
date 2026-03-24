import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider.js';
import { PolymarketReadService } from '../../src/read/PolymarketReadService.js';
const provider = new PolymarketApiReadProvider();
const readService = new PolymarketReadService(provider);

async function main() {
    const queries = ['LEE vs SUN', 'Leeds vs Sunderland', 'Celtic vs Rangers', 'PSG vs Monaco'];
    for (const q of queries) {
        const result = await readService.searchMarketsByText(q);
        const titles = result.slice(0, 2).map((r: any) => r.question ?? r.title ?? JSON.stringify(r).slice(0, 80));
        console.log(`\n"${q}" → ${result.length} result(s)`);
        if (titles.length) titles.forEach((t: string) => console.log('  ', t));
        else console.log('   NO RESULTS');
    }
}

main().catch(console.error);
