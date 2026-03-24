import type { Market, MarketId, Outcome } from '../types';

/**
 * Read-provider contract for Polymarket market data.
 *
 * Separation rationale:
 * - READ provider is isolated from WRITE execution systems.
 * - Service code in this file performs only data retrieval/composition.
 * - No wallet, trader, AI-intent, or policy enforcement concerns belong here.
 */
export interface PolymarketReadProvider {
	/** Returns markets available from the data source. */
	listMarkets(): Promise<readonly Market[]>;
	/** Returns one market by ID, or null if not found. */
	getMarket(marketId: MarketId): Promise<Market | null>;
	/** Returns markets that match free-text query semantics from the provider. */
	searchMarkets(query: string): Promise<readonly Market[]>;
	/** Fetches live, uncached prices for a single market. Optional. */
	refreshMarketPrices?(market: Market): Promise<Market>;
}

/**
 * Data-only summary shape for market responses.
 * Contains factual metadata only; no prediction/opinion fields.
 */
export interface MarketSummary {
	/** Market identifier. */
	readonly id: MarketId;
	/** Canonical market question text. */
	readonly question: string;
	/** Current market lifecycle status. */
	readonly status: Market['status'];
	/** Declared outcomes as provided by the source. */
	readonly outcomes: readonly Outcome[];
	/** Count of declared outcomes for quick display/inspection. */
	readonly outcomeCount: number;
	/** Probability prices per outcome (0-1). */
	readonly outcomePrices: readonly number[];
	/** Total trading volume in USD. */
	readonly volume: number;
	/** URL-friendly slug for constructing Olympus/Polymarket links. */
	readonly slug?: string;
	/** Parent event slug — used for Polymarket event URLs and Olympus search. */
	readonly eventSlug?: string;
}

/**
 * Read-only intelligence service for market information.
 *
 * Architectural boundary:
 * - This service never executes trades and never enforces write-path rules.
 * - It delegates all fetching/searching to an injected provider interface.
 * - It avoids Discord/user identity assumptions and has no side effects.
 */
export class PolymarketReadService {
	public constructor(private readonly provider: PolymarketReadProvider) { }

	/**
	 * Lists live markets only.
	 * Live is defined here as markets with status === 'active'.
	 */
	public async listLiveMarkets(): Promise<readonly Market[]> {
		const markets = await this.provider.listMarkets();
		return markets.filter((market) => market.status === 'active');
	}

	/**
	 * Fetches a single market by ID from the provider.
	 */
	public async getMarketById(marketId: MarketId): Promise<Market | null> {
		return this.provider.getMarket(marketId);
	}

	/**
	 * Searches markets by text through provider-defined search behavior.
	 */
	public async searchMarketsByText(query: string): Promise<readonly Market[]> {
		return this.provider.searchMarkets(query);
	}

	/**
	 * Fetches live prices for a market, bypassing cache.
	 * Falls back to returning the market unchanged if provider doesn't support it.
	 */
	public async refreshMarketPrices(market: Market): Promise<Market> {
		if (this.provider.refreshMarketPrices) {
			return this.provider.refreshMarketPrices(market);
		}
		return market;
	}

	/**
	 * Produces a factual market summary with no opinionated fields.
	 * Returns null when the market does not exist.
	 */
	public async summarizeMarket(marketId: MarketId): Promise<MarketSummary | null> {
		const market = await this.provider.getMarket(marketId);
		if (!market) {
			return null;
		}

		return {
			id: market.id,
			question: market.question,
			status: market.status,
			outcomes: market.outcomes,
			outcomeCount: market.outcomes.length,
			outcomePrices: market.outcomePrices,
			volume: market.volume,
			slug: market.slug,
			eventSlug: market.eventSlug,
		};
	}
}

