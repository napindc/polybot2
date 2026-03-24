import type { Market } from '../types';
import { PolymarketReadService } from './PolymarketReadService';

interface IndexedMarket {
  market: Market;
  questionKey: string;
  slugKey: string;
  eventSlugKey: string;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type RawEvent = {
  slug?: string;
  title?: string;
  markets?: Array<{
    id?: string;
    conditionId?: string;
    question?: string;
    outcomes?: string;
    outcomePrices?: string;
    volume?: number | string;
    active?: boolean;
    closed?: boolean;
  }>;
};

export class ActiveMarketIndex {
  private readonly byQuestion = new Map<string, IndexedMarket[]>();
  private readonly bySlug = new Map<string, IndexedMarket>();
  private readonly byEventSlug = new Map<string, IndexedMarket[]>();
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private lastRefreshMs = 0;

  public constructor(
    private readonly readService: PolymarketReadService,
    private readonly refreshMs = 60_000,
  ) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => {
        console.error('[market-index] periodic refresh failed', err);
      });
    }, this.refreshMs);
    void this.refresh().catch((err) => {
      console.error('[market-index] initial refresh failed', err);
    });
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public async refresh(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async () => {
      const liveMarkets = await this.readService.listLiveMarkets();
      this.rebuild(liveMarkets);
      this.lastRefreshMs = Date.now();
      console.log(`[market-index] refreshed active markets: ${liveMarkets.length}`);
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  public getLastRefreshMs(): number {
    return this.lastRefreshMs;
  }

  public getSize(): number {
    let count = 0;
    for (const list of this.byQuestion.values()) {
      count += list.length;
    }
    return count;
  }

  public async findBestMatch(query: string): Promise<Market | null> {
    const rawQuery = query.trim();
    const q = normalizeKey(query);
    if (!q) return null;

    // Refresh on demand if index is stale or empty.
    if (this.lastRefreshMs === 0 || Date.now() - this.lastRefreshMs > this.refreshMs * 2 || this.byQuestion.size === 0) {
      await this.refresh().catch(() => {
        // Use stale index if refresh fails.
      });
    }

    const bySlug = this.bySlug.get(q);
    if (bySlug) return bySlug.market;

    const byQuestion = this.byQuestion.get(q);
    if (byQuestion && byQuestion.length > 0) return byQuestion[0].market;

    const byEventSlug = this.byEventSlug.get(q);
    if (byEventSlug && byEventSlug.length > 0) return byEventSlug[0].market;

    const remote = await this.findByExactEventText(rawQuery, q);
    if (remote) return remote;

    return null;
  }

  private async findByExactEventText(rawQuery: string, normalizedQuery: string): Promise<Market | null> {
    if (!rawQuery) return null;

    try {
      const url = `https://gamma-api.polymarket.com/events?closed=false&limit=50&text_query=${encodeURIComponent(rawQuery)}`;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const rows = (await resp.json()) as RawEvent[];
      if (!Array.isArray(rows) || rows.length === 0) return null;

      const candidates: Market[] = [];
      for (const evt of rows) {
        const eventTitleKey = normalizeKey(evt.title ?? '');
        const eventSlugKey = normalizeKey(evt.slug ?? '');
        const exactEvent = eventTitleKey === normalizedQuery || eventSlugKey === normalizedQuery;

        for (const m of evt.markets ?? []) {
          if (m.closed || m.active === false) continue;
          const marketQuestion = (m.question ?? evt.title ?? '').trim();
          const marketQuestionKey = normalizeKey(marketQuestion);
          const exactMarket = marketQuestionKey === normalizedQuery;
          const strongTitle = eventTitleKey.length > 0 && normalizedQuery.length > 0 && (eventTitleKey.includes(normalizedQuery) || normalizedQuery.includes(eventTitleKey));
          if (!exactEvent && !exactMarket && !strongTitle) continue;

          const id = (m.conditionId ?? m.id ?? '').trim();
          if (!id) continue;

          let outcomes: string[] = ['YES', 'NO'];
          let prices: number[] = [0.5, 0.5];
          try {
            const parsed = JSON.parse(m.outcomes ?? '[]');
            if (Array.isArray(parsed) && parsed.length >= 2) outcomes = parsed.map((v) => String(v));
          } catch { }
          try {
            const parsed = JSON.parse(m.outcomePrices ?? '[]');
            if (Array.isArray(parsed) && parsed.length >= 2) prices = parsed.map((v) => Number(v) || 0);
          } catch { }

          candidates.push({
            id: id as Market['id'],
            question: marketQuestion,
            status: 'active',
            outcomes: outcomes as Market['outcomes'],
            outcomePrices: prices,
            volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
            slug: evt.slug,
            eventSlug: evt.slug,
          });
        }
      }

      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.volume - a.volume);
      return candidates[0] ?? null;
    } catch {
      return null;
    }
  }

  private rebuild(markets: readonly Market[]): void {
    this.byQuestion.clear();
    this.bySlug.clear();
    this.byEventSlug.clear();

    for (const market of markets) {
      const questionKey = normalizeKey(market.question);
      const slugKey = normalizeKey(market.slug ?? '');
      const eventSlugKey = normalizeKey(market.eventSlug ?? '');

      const row: IndexedMarket = {
        market,
        questionKey,
        slugKey,
        eventSlugKey,
      };

      this.pushMap(this.byQuestion, questionKey, row);
      if (slugKey) this.bySlug.set(slugKey, row);
      this.pushMap(this.byEventSlug, eventSlugKey, row);
    }
  }

  private pushMap(map: Map<string, IndexedMarket[]>, key: string, value: IndexedMarket): void {
    if (!key) return;
    const list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  }
}
