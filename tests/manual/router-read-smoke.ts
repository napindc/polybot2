import { DiscordMessageRouter } from '../../src/discord/DiscordMessageRouter';
import { PolymarketReadService } from '../../src/read/PolymarketReadService';
import { PolymarketApiReadProvider } from '../../src/read/PolymarketApiReadProvider';
import { createAiReadExplainer } from '../../src/read/aiReadExplainer';
import type { DiscordUserId, Trader } from '../../src/types';

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

type Case = {
  query: string;
  mustContainAny: string[];
  mustNotContainAny: string[];
};

const cases: Case[] = [
  {
    query: 'tell me about Louisville Cardinals vs Michigan State Spartans',
    mustContainAny: ['louisville', 'michigan state', 'lou', 'mst'],
    mustNotContainAny: ['stanley cup', 'colorado avalanche', 'carolina hurricanes'],
  },
  {
    query: 'tell me about Missouri Tigers vs Miami Hurricanes',
    mustContainAny: ['missouri', 'miami'],
    mustNotContainAny: ['stanley cup', 'colorado avalanche'],
  },
  {
    query: 'tell me about Timberwolves vs Celtics',
    mustContainAny: ['timberwolves', 'celtics', 'wolves'],
    mustNotContainAny: ['stanley cup', 'hurricanes'],
  },
  {
    query: 'tell me about Reignite vs QT DIG match',
    mustContainAny: ['reignite', 'qt dig'],
    mustNotContainAny: ['stanley cup', 'hurricanes'],
  },
  {
    query: 'tell me about New Zealand vs South Africa match',
    mustContainAny: ['new zealand', 'south africa', 'nzl', 'rsa'],
    mustNotContainAny: ['stanley cup', 'hurricanes'],
  },
];

const caseFilter = (process.env.CASE_FILTER ?? '').trim().toLowerCase();
const activeCases = caseFilter
  ? cases.filter((c) => c.query.toLowerCase().includes(caseFilter))
  : cases;
const queryTimeoutMs = Number(process.env.QUERY_TIMEOUT_MS ?? 35000) || 35000;

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function includesAny(hay: string, needles: string[]): boolean {
  return needles.some((n) => hay.includes(normalize(n)));
}

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

(async () => {
  const userId = '1161631744768884746' as DiscordUserId;
  let passCount = 0;

  if (activeCases.length === 0) {
    console.log(`No test cases matched CASE_FILTER="${caseFilter}"`);
    process.exitCode = 1;
    return;
  }

  for (const testCase of activeCases) {
    const started = Date.now();
    let ok = false;
    let reason = '';
    let preview = '';

    try {
      const result = await withTimeout(router.routeMessage(testCase.query, userId), queryTimeoutMs);
      const elapsed = Date.now() - started;
      if (result.type !== 'text') {
        reason = `unexpected-confirm-response elapsedMs=${elapsed}`;
      } else {
        const normalized = normalize(result.content);
        preview = result.content.slice(0, 220).replace(/\s+/g, ' ');
        const containsNeeded = includesAny(normalized, testCase.mustContainAny);
        const containsBlocked = includesAny(normalized, testCase.mustNotContainAny);
        if (!containsNeeded) {
          reason = `missing-expected-keyword elapsedMs=${elapsed}`;
        } else if (containsBlocked) {
          reason = `contains-blocked-keyword elapsedMs=${elapsed}`;
        } else {
          ok = true;
          reason = `ok elapsedMs=${elapsed}`;
        }
      }
    } catch (err) {
      reason = `exception ${(err as Error).message}`;
    }

    if (ok) passCount += 1;

    console.log('\n---');
    console.log(`query: ${testCase.query}`);
    console.log(`result: ${ok ? 'PASS' : 'FAIL'} (${reason})`);
    if (preview) {
      console.log(`preview: ${preview}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`passed ${passCount}/${activeCases.length}`);
  if (passCount !== activeCases.length) {
    process.exitCode = 1;
  }
})();
