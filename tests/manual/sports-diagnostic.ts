import { DiscordMessageRouter } from '../../src/discord/DiscordMessageRouter';
import { PolymarketReadService } from '../../src/read/PolymarketReadService';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { createAiReadExplainer } from '../../src/read/aiReadExplainer';
import type { DiscordUserId, Trader } from '../../src/types';
import { writeFile } from 'node:fs/promises';

const readService = new PolymarketReadService(new PolymarketApiReadProvider());

const traderStub: Trader = {
  async placeTrade() {
    return { ok: false, errorCode: 'INTERNAL_ERROR', failedAtMs: Date.now(), message: 'stub' };
  },
  async getBalance(userId) {
    return {
      userId,
      availableCents: 0 as never,
      spentTodayCents: 0 as never,
      remainingDailyLimitCents: 0 as never,
      asOfMs: Date.now(),
    };
  },
  async getRecentTrades() {
    return [];
  },
};

const router = new DiscordMessageRouter({
  readService,
  trader: traderStub,
  buildValidationContext: async () => ({
    polymarketAccountId: null,
    marketLookup: () => null,
    getSpentToday: async () => 0 as never,
    dailyLimitCents: 10000 as never,
    remainingDailyLimitCents: 10000 as never,
    spentThisHourCents: 0 as never,
  }),
  nowMs: () => Date.now(),
  readExplainer: createAiReadExplainer(),
});

const queries = [
  'tell me about Louisville Cardinals vs Michigan State Spartans',
  'tell me about Illinois State Redbirds vs Wake Forest Demon Deacons',
  'tell me about Missouri Tigers vs Miami Hurricanes',
  'tell me about Timberwolves vs Celtics',
  'tell me about Reignite vs QT DIG match',
  'tell me about New Zealand vs South Africa match',
];

const queryFilter = (process.env.QUERY_FILTER ?? '').trim().toLowerCase();
const activeQueries = queryFilter
  ? queries.filter((q) => q.toLowerCase().includes(queryFilter))
  : queries;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout-${timeoutMs}ms`)), timeoutMs);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

async function fetchEventBySlug(slug: string, closed: boolean): Promise<unknown[]> {
  const url = `https://gamma-api.polymarket.com/events?closed=${closed ? 'true' : 'false'}&limit=5&slug=${encodeURIComponent(slug)}`;
  const resp = await fetch(url);
  const json = await resp.json();
  return Array.isArray(json) ? json : [];
}

function printSlugDiagnostics(events: unknown[], closed: boolean): void {
  console.log(`\n=== SLUG CHECK closed=${closed} ===`);
  console.log(`events: ${events.length}`);
  for (const e of events as Array<{ slug?: string; title?: string; active?: boolean; closed?: boolean; markets?: Array<{ question?: string; active?: boolean; closed?: boolean }> }>) {
    console.log(`event: ${e.slug ?? ''} | ${e.title ?? ''} | active=${String(e.active)} closed=${String(e.closed)}`);
    for (const m of (e.markets ?? []).slice(0, 10)) {
      console.log(`  market: ${m.question ?? ''} | active=${String(m.active)} closed=${String(m.closed)}`);
    }
  }
}

(async () => {
  const activeEvents = await fetchEventBySlug('cbb-lou-mst-2026-03-21', false);
  const closedEvents = await fetchEventBySlug('cbb-lou-mst-2026-03-21', true);
  printSlugDiagnostics(activeEvents, false);
  printSlugDiagnostics(closedEvents, true);

  const userId = '1161631744768884746' as DiscordUserId;
  const outputRows: Array<{ query: string; result: string; elapsedMs: number; preview?: string }> = [];
  for (const query of activeQueries) {
    const started = Date.now();
    try {
      const result = await withTimeout(router.routeMessage(query, userId), 45000);
      const elapsed = Date.now() - started;
      console.log('\n---');
      console.log(`query: ${query}`);
      if (result.type !== 'text') {
        console.log(`result: confirm-response elapsedMs=${elapsed}`);
        outputRows.push({ query, result: 'confirm-response', elapsedMs: elapsed });
      } else {
        const preview = result.content.replace(/\s+/g, ' ').slice(0, 280);
        console.log(`result: text elapsedMs=${elapsed}`);
        console.log(`preview: ${preview}`);
        outputRows.push({ query, result: 'text', elapsedMs: elapsed, preview });
      }
    } catch (err) {
      const elapsed = Date.now() - started;
      console.log('\n---');
      console.log(`query: ${query}`);
      console.log(`result: exception elapsedMs=${elapsed} message=${(err as Error).message}`);
      outputRows.push({ query, result: `exception:${(err as Error).message}`, elapsedMs: elapsed });
    }
  }

  const outputPath = process.env.OUTPUT_JSON_PATH?.trim();
  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(outputRows, null, 2), 'utf8');
    console.log(`\nWrote diagnostic json: ${outputPath}`);
  }
})();
