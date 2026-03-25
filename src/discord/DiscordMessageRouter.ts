import { parseIntent } from '../agent/intentParser';
import { buildTradeRequest } from '../backend/buildTradeRequest';
import {
	type ValidationErrorCode,
	type ValidationContext,
	validateAgentOutput,
} from '../backend/validateAgentOutput';
import { classifyMessageIntent } from './classifyMessageIntent';
import { PolymarketReadService, type MarketSummary } from '../read/PolymarketReadService';
import type { DiscordUserId, Market, MarketId, TradeAction, TradeResult, Trader, UserIdentity, UsdCents } from '../types';
import {
	DAILY_LIMIT_CENTS,
	canSpend,
	getSpentToday,
	getRemainingToday,
	isOwnerExempt,
	trySpend,
} from '../storage/limits';
import crypto from 'crypto';
import { ActiveMarketIndex } from '../read/ActiveMarketIndex';

/**
 * Result of routing a Discord message.
 * Either a plain text response or a trade confirmation request.
 */
export type RouteResult =
	| { readonly type: 'text'; readonly content: string }
	| {
		readonly type: 'confirm';
		readonly confirmId: string;
		readonly marketQuestion: string;
		readonly outcome: 'YES' | 'NO';
		readonly outcomeLabel?: string;
		readonly action: TradeAction;
		readonly amountDollars: string;
		/** Optional market context shown in the confirm embed (odds, volume, position size). */
		readonly marketInfo?: string;
	};

/**
 * Data passed to the READ explainer.
 * The explainer is intentionally read-only and receives factual inputs only.
 */
export interface ReadExplainerInput {
	readonly message: string;
	readonly liveMarketCount: number;
	readonly sampleMarketSummaries: readonly MarketSummary[];
	readonly searchResultsCount: number;
}

/**
 * Dependency contract for Discord orchestration.
 *
 * Routing is centralized here so lower layers stay focused:
 * - READ layer returns market information only.
 * - WRITE layers parse/validate/build/execute only.
 * - This router is the first user-facing message boundary.
 */
export interface DiscordMessageRouterDependencies {
	readonly readService: PolymarketReadService;
	readonly activeMarketIndex?: ActiveMarketIndex;
	readonly trader: Trader;
	readonly buildValidationContext: (discordUserId: DiscordUserId) => Promise<ValidationContext>;
	readonly nowMs: () => number;
	readonly readExplainer?: (input: ReadExplainerInput) => Promise<string>;
}

/**
 * Orchestrates inbound Discord message handling.
 *
 * This class intentionally contains presentation mapping, while business rules remain
 * in deterministic validation/execution layers.
 */
export class DiscordMessageRouter {
	private readonly readExplainer: (input: ReadExplainerInput) => Promise<string>;
	/** Pending trade confirmations: confirmId → executor + expiry */
	private readonly pendingTrades = new Map<string, { execute: () => Promise<string>; expiresAtMs: number }>();

	public constructor(private readonly deps: DiscordMessageRouterDependencies) {
		this.readExplainer = deps.readExplainer ?? defaultReadExplainer;
		// Purge expired pending trades every 2 minutes
		setInterval(() => {
			const now = Date.now();
			for (const [id, p] of this.pendingTrades) {
				if (p.expiresAtMs < now) this.pendingTrades.delete(id);
			}
		}, 2 * 60 * 1000);
	}

	/**
	 * Execute a previously confirmed pending trade. Returns the result message.
	 * Returns null if the confirmId is unknown or expired.
	 */
	public async executePendingTrade(confirmId: string): Promise<string | null> {
		const pending = this.pendingTrades.get(confirmId);
		if (!pending) return null;
		this.pendingTrades.delete(confirmId);
		if (pending.expiresAtMs < Date.now()) return null;
		return pending.execute();
	}

	/** Cancel a pending trade. Returns true if it existed. */
	public cancelPendingTrade(confirmId: string): boolean {
		if (!this.pendingTrades.has(confirmId)) return false;
		this.pendingTrades.delete(confirmId);
		return true;
	}

	/** Store a pending trade and return its confirmId. Expires in 5 minutes. */
	private storePendingTrade(execute: () => Promise<string>): string {
		const confirmId = crypto.randomUUID();
		this.pendingTrades.set(confirmId, { execute, expiresAtMs: Date.now() + 5 * 60 * 1000 });
		return confirmId;
	}

	/** Read on-chain USDC balance for any wallet address. Returns cents. */
	private async readOnchainUsdcBalance(address: string): Promise<number> {
		const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
		const RPC_ENDPOINTS = [
			process.env.POLYGON_RPC_URL,
			'https://polygon-bor-rpc.publicnode.com',
			'https://1rpc.io/matic',
		].filter((v): v is string => Boolean(v && v.length > 0));

		const addressHex = address.toLowerCase().replace(/^0x/, '');
		if (addressHex.length !== 40) return 0;

		const data = `0x70a08231000000000000000000000000${addressHex}`;

		for (const endpoint of RPC_ENDPOINTS) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						jsonrpc: '2.0', method: 'eth_call',
						params: [{ to: USDC_CONTRACT, data }, 'latest'], id: 1,
					}),
				});
				if (!response.ok) continue;
				const payload = (await response.json()) as { result?: string };
				if (!payload.result?.startsWith('0x')) continue;
				const raw = BigInt(payload.result);
				const cents = raw / 10_000n;
				return Number(cents > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cents);
			} catch { continue; }
		}
		return 0;
	}

	/**
	 * Main entry point for routing a Discord message.
	 * Returns either a plain text response or a trade confirmation request.
	 */
	public async routeMessage(message: string, discordUserId: DiscordUserId): Promise<RouteResult> {
		const traceId = crypto.randomUUID().slice(0, 8);
		const startedAt = Date.now();
		console.log(`[perf:${traceId}] route:start user=${discordUserId} msgLen=${message.length}`);
		try {
			// Intercept position queries before they hit the AI intent parser
			const positionsStartedAt = Date.now();
			const positionsResult = await this.tryHandlePositions(message);
			console.log(`[perf:${traceId}] step:positions ms=${Date.now() - positionsStartedAt}`);
			if (positionsResult !== null) {
				console.log(`[perf:${traceId}] route:end pipeline=positions ms=${Date.now() - startedAt}`);
				return positionsResult;
			}

			if (isDeterministicWriteMessage(message)) {
				const result = await this.handleWrite(message, discordUserId, traceId);
				console.log(`[perf:${traceId}] route:end pipeline=write-deterministic ms=${Date.now() - startedAt}`);
				return result;
			}

			const classifyStartedAt = Date.now();
			const pipeline = classifyMessageIntent(message);
			console.log(`[perf:${traceId}] step:classify ms=${Date.now() - classifyStartedAt} pipeline=${pipeline}`);

			if (pipeline === 'READ') {
				const content = await this.handleRead(message, traceId);
				console.log(`[perf:${traceId}] route:end pipeline=read ms=${Date.now() - startedAt}`);
				return { type: 'text', content };
			}

			const result = await this.handleWrite(message, discordUserId, traceId);
			console.log(`[perf:${traceId}] route:end pipeline=write-classified ms=${Date.now() - startedAt}`);
			return result;
		} catch {
			console.log(`[perf:${traceId}] route:error ms=${Date.now() - startedAt}`);
			return { type: 'text', content: 'Something went wrong while handling your request. Please try again.' };
		}
	}

	private async handleRead(message: string, traceId: string): Promise<string> {
		console.log(`[router] handleRead: "${message}"`);
		const normalizedReadQuery = normalizeReadSearchQuery(message);
		let matchTier: 'exact' | 'strong' | 'fallback' | 'none' = 'none';
		let providerVsSearched = false;
		let providerVsResults: readonly Market[] = [];
		let liveMarkets: readonly Market[] = [];
		let liveMarketCount = 0;
		let liveMarketsLoaded = false;
		const ensureLiveMarkets = async (): Promise<readonly Market[]> => {
			if (liveMarketsLoaded) return liveMarkets;
			const listLiveStartedAt = Date.now();
			liveMarkets = await this.deps.readService.listLiveMarkets();
			liveMarketCount = liveMarkets.length;
			liveMarketsLoaded = true;
			console.log(`[perf:${traceId}] step:read.listLiveMarkets ms=${Date.now() - listLiveStartedAt}`);
			console.log(`[router] Live markets: ${liveMarkets.length}`);
			return liveMarkets;
		};

		// Detect greetings / casual chat with no market query intent.
		// Skip market search entirely so the bot responds conversationally
		// without appending random unrelated Olympus links.
		if (isCasualChat(message)) {
			console.log(`[router] Casual chat detected, skipping market search`);
			await ensureLiveMarkets();
			const explainStartedAt = Date.now();
			const explained = await this.readExplainer({
				message,
				liveMarketCount,
				sampleMarketSummaries: [],
				searchResultsCount: 0,
			});
			console.log(`[perf:${traceId}] step:read.explainer ms=${Date.now() - explainStartedAt}`);
			return explained;
		}

		let searchResults: readonly Market[] = [];
		if (this.deps.activeMarketIndex) {
			const exactStartedAt = Date.now();
			const exact = await this.deps.activeMarketIndex.findBestMatch(normalizedReadQuery);
			console.log(`[perf:${traceId}] step:read.localIndexExact ms=${Date.now() - exactStartedAt} hit=${exact ? 1 : 0}`);
			if (exact) {
				searchResults = [exact];
				matchTier = 'exact';
			}
		}
		const readVsTeams = extractVsTeamsFromGeneralQuery(normalizedReadQuery);
		if (searchResults.length === 0 && readVsTeams) {
			const quickStartedAt = Date.now();
			const quick = await searchSportsMatchupQuick(readVsTeams.teamA, readVsTeams.teamB);
			console.log(`[perf:${traceId}] step:read.quickSportsSearch ms=${Date.now() - quickStartedAt} results=${quick.length}`);
			if (quick.length > 0) {
				searchResults = quick;
			} else {
				const specificStartedAt = Date.now();
				const specific = await searchSpecificMarketsQuick(normalizedReadQuery);
				console.log(`[perf:${traceId}] step:read.quickSpecificSearch ms=${Date.now() - specificStartedAt} results=${specific.length}`);
				searchResults = specific;
			}
		} else if (searchResults.length === 0) {
			const specificStartedAt = Date.now();
			const specific = await searchSpecificMarketsQuick(normalizedReadQuery);
			console.log(`[perf:${traceId}] step:read.quickSpecificSearch ms=${Date.now() - specificStartedAt} results=${specific.length}`);
			if (specific.length > 0) {
				searchResults = specific;
			}
		}
		if (searchResults.length === 0) {
			if (readVsTeams && searchResults.length === 0) {
				const slugGuessStartedAt = Date.now();
				const slugGuessMatches = await withTimeoutResult(
					searchSportsMatchupBySlugGuesses(readVsTeams.teamA, readVsTeams.teamB),
					2_500,
					[],
				);
				console.log(`[perf:${traceId}] step:read.slugGuessMatchup ms=${Date.now() - slugGuessStartedAt} results=${slugGuessMatches.length}`);
				if (slugGuessMatches.length > 0) {
					searchResults = slugGuessMatches;
				}
			}
			if (readVsTeams && searchResults.length === 0) {
				const rawEventTextStartedAt = Date.now();
				const rawEventTextMatches = await searchSportsMatchupByEventTextQuery(readVsTeams.teamA, readVsTeams.teamB, false);
				console.log(`[perf:${traceId}] step:read.rawEventTextMatchup ms=${Date.now() - rawEventTextStartedAt} results=${rawEventTextMatches.length}`);
				if (rawEventTextMatches.length > 0) {
					searchResults = rawEventTextMatches;
				}
			}
			if (readVsTeams && searchResults.length === 0) {
				// Provider search has broader sports matching logic; keep this bounded so
				// we gain coverage without the timeout race that can drop valid hits.
				const providerStartedAt = Date.now();
				const providerQuery = `${readVsTeams.teamA} vs ${readVsTeams.teamB}`;
				const providerMatches = await this.deps.readService.searchMarketsByText(providerQuery);
				providerVsSearched = true;
				providerVsResults = providerMatches;
				console.log(`[perf:${traceId}] step:read.providerSearch.vsFallback ms=${Date.now() - providerStartedAt} results=${providerMatches.length}`);
				if (providerMatches.length > 0) {
					const providerBest = pickBestSportsMatchupMarket(providerMatches, readVsTeams.teamA, readVsTeams.teamB)
						?? pickBestSportsMatchupMarketLenient(providerMatches, readVsTeams.teamA, readVsTeams.teamB);
					if (providerBest) {
						searchResults = [providerBest];
						if (matchTier === 'none') matchTier = 'fallback';
					} else {
						searchResults = providerMatches;
					}
				}
			}
			if (readVsTeams && searchResults.length === 0) {
				// The Gamma text_query endpoints can miss valid sports events for exact
				// team names, so for matchup queries we must still attempt provider-level
				// deterministic fallback without AI retrieval.
				const deterministicStartedAt = Date.now();
				searchResults = await withTimeoutResult(
					searchSpecificMarketsQuick(normalizedReadQuery),
					8_000,
					[],
				);
				console.log(`[perf:${traceId}] step:read.deterministicSpecific.vsFallback ms=${Date.now() - deterministicStartedAt} results=${searchResults.length}`);
			}
			if (readVsTeams && searchResults.length === 0) {
				const live = await withTimeoutResult(
					ensureLiveMarkets(),
					3_000,
					[],
				);
				const localStartedAt = Date.now();
				const localMatches = findSportsMatchupInLiveMarkets(live, readVsTeams.teamA, readVsTeams.teamB);
				console.log(`[perf:${traceId}] step:read.localLiveMatchup ms=${Date.now() - localStartedAt} results=${localMatches.length}`);
				if (localMatches.length > 0) {
					searchResults = localMatches;
				}
			} else if (!readVsTeams) {
				const deterministicStartedAt = Date.now();
				searchResults = await withTimeoutResult(
					searchSpecificMarketsQuick(normalizedReadQuery),
					8_000,
					[],
				);
				console.log(`[perf:${traceId}] step:read.deterministicSpecific ms=${Date.now() - deterministicStartedAt} results=${searchResults.length}`);
			}
		}
		if (readVsTeams && searchResults.length === 0) {
			const closedSlugStartedAt = Date.now();
			const closedSlugMatches = await withTimeoutResult(
				searchSportsMatchupBySlugGuesses(readVsTeams.teamA, readVsTeams.teamB, true),
				2_500,
				[],
			);
			console.log(`[perf:${traceId}] step:read.slugGuessMatchup.closed ms=${Date.now() - closedSlugStartedAt} results=${closedSlugMatches.length}`);
			if (closedSlugMatches.length > 0) {
				const closedBest = pickBestSportsMatchupMarket(closedSlugMatches, readVsTeams.teamA, readVsTeams.teamB);
				if (closedBest) {
					searchResults = [closedBest];
					matchTier = 'fallback';
				}
			}
		}
		if (readVsTeams && searchResults.length === 0) {
			const closedRawEventTextStartedAt = Date.now();
			const closedRawEventTextMatches = await searchSportsMatchupByEventTextQuery(readVsTeams.teamA, readVsTeams.teamB, true);
			console.log(`[perf:${traceId}] step:read.rawEventTextMatchup.closed ms=${Date.now() - closedRawEventTextStartedAt} results=${closedRawEventTextMatches.length}`);
			if (closedRawEventTextMatches.length > 0) {
				const closedBest = pickBestSportsMatchupMarket(closedRawEventTextMatches, readVsTeams.teamA, readVsTeams.teamB);
				if (closedBest) {
					searchResults = [closedBest];
					matchTier = 'fallback';
				}
			}
		}
		if (readVsTeams && searchResults.length === 0) {
			const marketTextStartedAt = Date.now();
			const marketTextMatches = await searchSportsMatchupByMarketTextQuery(readVsTeams.teamA, readVsTeams.teamB, false);
			console.log(`[perf:${traceId}] step:read.marketTextMatchup ms=${Date.now() - marketTextStartedAt} results=${marketTextMatches.length}`);
			if (marketTextMatches.length > 0) {
				const best = pickBestSportsMatchupMarketLenient(marketTextMatches, readVsTeams.teamA, readVsTeams.teamB);
				if (best) {
					searchResults = [best];
					if (matchTier === 'none') matchTier = 'fallback';
				}
			}
		}
		if (readVsTeams && searchResults.length === 0) {
			const marketTextClosedStartedAt = Date.now();
			const marketTextClosedMatches = await searchSportsMatchupByMarketTextQuery(readVsTeams.teamA, readVsTeams.teamB, true);
			console.log(`[perf:${traceId}] step:read.marketTextMatchup.closed ms=${Date.now() - marketTextClosedStartedAt} results=${marketTextClosedMatches.length}`);
			if (marketTextClosedMatches.length > 0) {
				const best = pickBestSportsMatchupMarketLenient(marketTextClosedMatches, readVsTeams.teamA, readVsTeams.teamB);
				if (best) {
					searchResults = [best];
					if (matchTier === 'none') matchTier = 'fallback';
				}
			}
		}
		if (readVsTeams && searchResults.length > 0) {
			const bestMatch = pickBestSportsMatchupMarket(searchResults, readVsTeams.teamA, readVsTeams.teamB);
			if (bestMatch) {
				searchResults = [bestMatch];
				if (matchTier === 'none') matchTier = 'strong';
				console.log(`[perf:${traceId}] step:read.matchupBestPick hit=1`);
			} else {
				const providerActive = searchResults.find((m) =>
					m.status === 'active' && marketLooksLikeMatchupForTeams(m, readVsTeams.teamA, readVsTeams.teamB),
				) ?? searchResults.find((m) => marketLooksLikeMatchupForTeams(m, readVsTeams.teamA, readVsTeams.teamB)) ?? null;
				if (providerActive) {
					searchResults = [providerActive];
					if (matchTier === 'none') matchTier = 'fallback';
					console.log(`[perf:${traceId}] step:read.matchupBestPick providerActiveFallback=1`);
				} else {
				// If earlier quick probes returned noisy one-team candidates, retry using
				// provider-level search before declaring no-match.
				const providerRetryStartedAt = Date.now();
				const providerRetry = providerVsSearched
					? providerVsResults
					: await withTimeoutResult(
						this.deps.readService.searchMarketsByText(`${readVsTeams.teamA} vs ${readVsTeams.teamB}`),
						15_000,
						[],
					);
				const providerBest = pickBestSportsMatchupMarket(providerRetry, readVsTeams.teamA, readVsTeams.teamB);
				const providerLenient = providerBest
					? providerBest
					: pickBestSportsMatchupMarketLenient(providerRetry, readVsTeams.teamA, readVsTeams.teamB);
				console.log(`[perf:${traceId}] step:read.matchupBestPick.providerRetry ms=${Date.now() - providerRetryStartedAt} results=${providerRetry.length} strictHit=${providerBest ? 1 : 0} lenientHit=${providerLenient ? 1 : 0}`);
				searchResults = providerLenient ? [providerLenient] : [];
				if (providerLenient && matchTier === 'none') matchTier = providerBest ? 'strong' : 'fallback';
				}
			}
		}
		if (!readVsTeams && searchResults.length > 0 && matchTier === 'none') {
			const top = searchResults[0];
			const queryKey = normalizeTradeLabel(normalizedReadQuery);
			const questionKey = normalizeTradeLabel(top.question);
			const eventSlugKey = normalizeTradeLabel(top.eventSlug ?? '');
			const slugKey = normalizeTradeLabel(top.slug ?? '');
			matchTier = queryKey.length > 0 && (queryKey === questionKey || queryKey === eventSlugKey || queryKey === slugKey)
				? 'exact'
				: 'fallback';
		}
		console.log(`[router] Search results: ${searchResults.length}`);

		// Only show search results if we actually found any.
		// When search returns 0 results, pass an empty sample list so the AI
		// can honestly tell the user we couldn't find a match, instead of
		// showing random unrelated trending markets (like StarCraft II for an NBA query).
		let sampleSummaries;
		if (searchResults.length > 0) {
			// Refresh prices for the top result so the user sees live odds
			// (especially important for live sports where prices change rapidly)
			let updatedResults = [...searchResults];
			const refreshStartedAt = Date.now();
			const refreshed = await this.deps.readService.refreshMarketPrices(searchResults[0] as import('../types').Market);
			console.log(`[perf:${traceId}] step:read.refreshTopMarket ms=${Date.now() - refreshStartedAt}`);

			if (readVsTeams) {
				const refreshedBest = pickBestSportsMatchupMarket([refreshed], readVsTeams.teamA, readVsTeams.teamB);
				if (refreshedBest) {
					updatedResults = [refreshed, ...searchResults.slice(1)];
				}
			} else {
				updatedResults = [refreshed, ...searchResults.slice(1)];
			}

			sampleSummaries = summarizeUpToThree(updatedResults, message);
		} else {
			sampleSummaries = [];
		}
		console.log(`[router] Sample summaries: ${sampleSummaries.map(s => s.question).join(' | ')}`);

		if (sampleSummaries.length > 0) {
			return renderMarketBrief(sampleSummaries[0], message, matchTier);
		}
		if (readVsTeams) {
			return `I couldn't find an active market for ${readVsTeams.teamA} vs ${readVsTeams.teamB} right now.\nMatch confidence: no-match.`;
		}

		const explainStartedAt = Date.now();
		const explained = await this.readExplainer({
			message,
			liveMarketCount,
			sampleMarketSummaries: sampleSummaries,
			searchResultsCount: searchResults.length,
		});
		console.log(`[perf:${traceId}] step:read.explainer ms=${Date.now() - explainStartedAt}`);
		return explained;
	}

	/**
	 * Detects position-related queries and returns the leader wallet's positions.
	 * Handles: "my positions", "show positions", "open positions", "closed positions",
	 * "what are my positions", "do i have any positions", etc.
	 */
	private async tryHandlePositions(message: string): Promise<RouteResult | null> {
		const normalized = message.trim().toLowerCase();

		// Match position-related queries — but NOT trade commands
		const isPositionQuery = /\b(positions?|portfolio|my\s+bets?|open\s+bets?|active\s+bets?)\b/i.test(normalized)
			&& !/\b(bet|buy|sell|trade|place|market\s+in)\b/i.test(normalized);

		if (!isPositionQuery) return null;

		const walletAddr = process.env.POLYMARKET_PROXY_WALLET;
		if (!walletAddr) {
			return { type: 'text', content: 'Trading wallet not configured. Cannot look up positions.' };
		}

		const wantsClosed = /\b(closed|resolved|settled|past|finished|ended)\b/i.test(normalized);
		const shortAddr = `${walletAddr.slice(0, 6)}...${walletAddr.slice(-4)}`;

		try {
			// Fetch positions from Polymarket data API
			const posUrl = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(walletAddr)}&sizeThreshold=0`;
			const posResp = await fetch(posUrl);
			if (!posResp.ok) {
				return { type: 'text', content: 'Failed to fetch positions from Polymarket. Please try again.' };
			}

			interface PositionData {
				title?: string;
				outcome?: string;
				size?: number;
				curPrice?: number;
				avgPrice?: number;
				resolved?: boolean;
				cashPnl?: number;
				percentPnl?: number;
				initialValue?: number;
				currentValue?: number;
			}

			const allPositions = (await posResp.json()) as PositionData[];
			if (!Array.isArray(allPositions) || allPositions.length === 0) {
				return { type: 'text', content: `📊 **No positions found** for wallet \`${shortAddr}\`` };
			}

			// Filter by open/closed
			const filtered = wantsClosed
				? allPositions.filter(p => p.resolved === true)
				: allPositions.filter(p => (p.size ?? 0) > 0.01 && p.resolved !== true);

			if (filtered.length === 0) {
				const label = wantsClosed ? 'closed' : 'open';
				return { type: 'text', content: `📊 **No ${label} positions** for wallet \`${shortAddr}\`` };
			}

			const label = wantsClosed ? '📕 Closed' : '📗 Open';
			const lines: string[] = [
				`${label} **Positions** (\`${shortAddr}\`)`,
				`Total: **${filtered.length}** ${wantsClosed ? 'closed' : 'open'} position${filtered.length !== 1 ? 's' : ''}`,
				'',
			];

			// Show up to 10 positions
			const display = filtered.slice(0, 10);
			for (const pos of display) {
				const title = pos.title ?? 'Unknown market';
				const outcome = pos.outcome ?? '';
				const size = pos.size != null ? Number(pos.size).toFixed(2) : '?';
				const curPrice = pos.curPrice != null ? `${(Number(pos.curPrice) * 100).toFixed(0)}¢` : '?';
				const avgPrice = pos.avgPrice != null ? `${(Number(pos.avgPrice) * 100).toFixed(0)}¢` : '?';

				// Calculate PnL
				let pnlStr = '';
				if (pos.currentValue != null && pos.initialValue != null) {
					const pnl = pos.currentValue - pos.initialValue;
					const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
					const pnlSign = pnl >= 0 ? '+' : '-';
					const pnlPct = typeof pos.percentPnl === 'number' ? ` (${pnlSign}${Math.abs(pos.percentPnl).toFixed(2)}%)` : '';
					pnlStr = ` ${pnlEmoji} ${pnlSign}$${Math.abs(pnl).toFixed(2)}${pnlPct}`;
				}

				lines.push(`• **${title}** — ${outcome}`);
				lines.push(`  ${size} shares @ ${curPrice} (avg: ${avgPrice})${pnlStr}`);
			}

			if (filtered.length > 10) {
				lines.push('', `_...and ${filtered.length - 10} more_`);
			}

			return { type: 'text', content: lines.join('\n') };
		} catch (err) {
			console.error('[positions] Error fetching positions:', err);
			return { type: 'text', content: 'Failed to fetch positions. Please try again.' };
		}
	}

	private async handleWrite(message: string, discordUserId: DiscordUserId, traceId: string): Promise<RouteResult> {
		const fallbackStartedAt = Date.now();
		const deterministicResult = await this.tryDeterministicWriteFallback(message, discordUserId, traceId);
		console.log(`[perf:${traceId}] step:write.deterministicFirst ms=${Date.now() - fallbackStartedAt} hit=${deterministicResult !== null}`);
		if (deterministicResult !== null) {
			return deterministicResult;
		}

		const parseStartedAt = Date.now();
		const agentOutput = await parseIntent(message, discordUserId);
		console.log(`[perf:${traceId}] step:write.parseIntent ms=${Date.now() - parseStartedAt}`);
		if (agentOutput === null) {
			return { type: 'text', content: 'I could not confidently parse that request. Please try again with a clearer command.' };
		}

		// --- get_balance ---
		if (agentOutput.intent === 'get_balance') {
			// Check if the user provided a wallet address in their message
			const rawText = agentOutput.rawText ?? message;
			const addrMatch = rawText.match(/0x[a-fA-F0-9]{40}/);
			const userProvidedAddr = addrMatch ? addrMatch[0] : null;

			if (userProvidedAddr) {
				// User wants to check a specific wallet — use public APIs (no login needed)
				const shortAddr = `${userProvidedAddr.slice(0, 6)}...${userProvidedAddr.slice(-4)}`;

				let cashDollars = '0.00';
				let positionValueDollars = '0.00';
				let openPositionsCount = 0;
				interface PositionRow { title?: string; curPrice?: number; size?: number; outcome?: string; }
				let topPositions: PositionRow[] = [];

				try {
					const [balResp, valueResp, posResp] = await Promise.all([
						this.readOnchainUsdcBalance(userProvidedAddr),
						fetch(`https://data-api.polymarket.com/value?user=${encodeURIComponent(userProvidedAddr)}`),
						fetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(userProvidedAddr)}&sizeThreshold=.1`),
					]);

					cashDollars = (balResp / 100).toFixed(2);

					if (valueResp.ok) {
						const rows = (await valueResp.json()) as Array<{ value?: number }>;
						positionValueDollars = (rows?.[0]?.value ?? 0).toFixed(2);
					}
					if (posResp.ok) {
						const positions = (await posResp.json()) as PositionRow[];
						openPositionsCount = Array.isArray(positions) ? positions.length : 0;
						topPositions = Array.isArray(positions) ? positions.slice(0, 5) : [];
					}
				} catch { /* fallback to defaults */ }

				const lines = [
					`💰 **Wallet Balance**`,
					`• Wallet: \`${shortAddr}\``,
					`• Cash (USDC): **$${cashDollars}**`,
					`• Position value: **$${positionValueDollars}**`,
					`• Open positions: **${openPositionsCount}**`,
				];

				if (topPositions.length > 0) {
					lines.push('', '📊 **Top Positions:**');
					for (const pos of topPositions) {
						const title = pos.title ?? 'Unknown market';
						const price = pos.curPrice != null ? `$${Number(pos.curPrice).toFixed(2)}` : '?';
						const size = pos.size != null ? Number(pos.size).toFixed(2) : '?';
						const outcome = pos.outcome ?? '';
						lines.push(`• ${title} — ${outcome} ${size} shares @ ${price}`);
					}
				}

				return { type: 'text', content: lines.join('\n') };
			}

			// No wallet address provided — show trading wallet balance + daily spend limit
			const balance = await this.deps.trader.getBalance(discordUserId);
			const availableDollars = (balance.availableCents / 100).toFixed(2);
			const tradingWallet = process.env.POLYMARKET_PROXY_WALLET ?? '';
			const shortAddr = tradingWallet ? `${tradingWallet.slice(0, 6)}...${tradingWallet.slice(-4)}` : 'N/A';

			if (isOwnerExempt(discordUserId)) {
				return {
					type: 'text', content: [
						`💰 **Trading Wallet**`,
						`• Wallet: \`${shortAddr}\``,
						`• Cash (USDC): **$${availableDollars}**`,
						`• Daily limit: **unlimited** (owner)`,
						``,
						`💡 *Tip: To check any wallet, include its address — e.g. \`balance 0xABC...\`*`,
					].join('\n')
				};
			}

			const spent = await getSpentToday(discordUserId);
			const remaining = await getRemainingToday(discordUserId);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			const spentDollars = (spent / 100).toFixed(2);
			const remainingDollars = (remaining / 100).toFixed(2);
			return {
				type: 'text', content: [
					`💰 **Trading Wallet**`,
					`• Wallet: \`${shortAddr}\``,
					`• Cash (USDC): **$${availableDollars}**`,
					`• Your daily spend: **$${spentDollars}** / $${limitDollars}`,
					`• Remaining today: **$${remainingDollars}**`,
					``,
					`💡 *Tip: To check your own wallet, include your proxy address — e.g. \`balance 0xABC...\`*`,
				].join('\n')
			};
		}

		// --- get_trade_history ---
		if (agentOutput.intent === 'get_trade_history') {
			const limit = agentOutput.limit ?? 5;

			const validationContext = await this.deps.buildValidationContext(discordUserId);
			const linkedAccountId = validationContext.polymarketAccountId ?? (process.env.POLYMARKET_PROXY_WALLET || null);
			if (!linkedAccountId) {
				return { type: 'text', content: 'Trading is not available right now. Please contact an admin.' };
			}

			const activities = await fetchPolymarketActivity(linkedAccountId, limit);
			if (activities.length > 0) {
				const lines = activities.map((activity, index) => formatActivityLine(activity, index));
				return { type: 'text', content: [`**Your last ${Math.min(limit, activities.length)} activity entries:**`, ...lines].join('\n') };
			}

			const trades = await this.deps.trader.getRecentTrades(discordUserId, limit);
			if (trades.length === 0) {
				return { type: 'text', content: 'You have no recent trades yet.' };
			}
			const lines = trades.map((t, i) => {
				if (!t.ok) return `${i + 1}. ❌ Trade failed (${t.errorCode})`;
				const dollars = (t.amountCents / 100).toFixed(2);
				const date = new Date(t.executedAtMs).toUTCString();
				return `${i + 1}. ✅ **${t.outcome}** $${dollars} on \`${t.marketId}\` — ${date}`;
			});
			return { type: 'text', content: [`**Your last ${limit} trades:**`, ...lines].join('\n') };
		}

		// --- place_bet ---
		if (agentOutput.intent !== 'place_bet') {
			return { type: 'text', content: 'I could not confirm a trade placement request. Please restate the trade with explicit action and amount.' };
		}

		// Enforce daily spend limit before doing anything else (only for BUY — sells return funds)
		// Owner is exempt from spend limits for testing purposes.
		const actionForSpend = (agentOutput.intent === 'place_bet' ? (agentOutput.action ?? 'BUY') : 'BUY') as TradeAction;
		if (actionForSpend === 'BUY' && !isOwnerExempt(discordUserId) && !(await canSpend(discordUserId, agentOutput.amountCents))) {
			const remaining = await getRemainingToday(discordUserId);
			const remainingDollars = (remaining / 100).toFixed(2);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			return { type: 'text', content: `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today (limit: $${limitDollars}/day).` };
		}

		const resolvedMarket = await this.deps.readService.getMarketById(agentOutput.marketId);
		const timedResolution = await tryResolveTimedUpDownMarket(this.deps.readService, message);
		const effectiveMarket = timedResolution?.market ?? resolvedMarket;
		const effectiveSlug = timedResolution?.slug ?? null;
		const effectiveIntent = {
			...agentOutput,
			marketId: (effectiveMarket?.id ?? agentOutput.marketId) as MarketId,
		};

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== effectiveIntent.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}
				if (effectiveMarket === null) return null;
				return { id: effectiveMarket.id, status: effectiveMarket.status };
			},
		};

		const validation = validateAgentOutput(effectiveIntent, validationContext);
		if (!validation.ok) {
			return { type: 'text', content: mapValidationErrorToUserMessage(validation.error.code) };
		}

		if (effectiveMarket === null) {
			return { type: 'text', content: mapValidationErrorToUserMessage('INVALID_MARKET') };
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = buildTradeRequest(effectiveIntent, {
			identity,
			market: effectiveMarket,
			nowMs: this.deps.nowMs(),
		});

		// Store pending trade and return confirmation prompt
		const amountCentsNum = Number(effectiveIntent.amountCents);
		const confirmId = this.storePendingTrade(async () => {
			// Atomic spend check-and-record BEFORE placing the trade (prevents TOCTOU race)
			if (actionForSpend === 'BUY' && !isOwnerExempt(discordUserId)) {
				const allowed = await trySpend(discordUserId, amountCentsNum);
				if (!allowed) {
					const remaining = await getRemainingToday(discordUserId);
					const remainingDollars = (remaining / 100).toFixed(2);
					return `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today.`;
				}
			}
			const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
			return formatTradeResultMessage(tradeResult, {
				marketQuestion: effectiveMarket.question,
				outcome: effectiveIntent.outcome,
				outcomeLabel: (effectiveMarket.outcomes as string[])[effectiveIntent.outcome === 'YES' ? 0 : 1],
				action: actionForSpend,
				amountCents: amountCentsNum,
			});
		});

		return {
			type: 'confirm',
			confirmId,
			marketQuestion: effectiveMarket.question,
			outcome: effectiveIntent.outcome,
			outcomeLabel: (effectiveMarket.outcomes as string[])[effectiveIntent.outcome === 'YES' ? 0 : 1] ?? effectiveIntent.outcome,
			action: actionForSpend,
			amountDollars: (amountCentsNum / 100).toFixed(2),
		};
	}

	private async tryDeterministicWriteFallback(
		message: string,
		discordUserId: DiscordUserId,
		traceId: string,
	): Promise<RouteResult | null> {
		const normalized = message.trim().toLowerCase();

		if (/\b(past | last | recent) \b.*\btrades ?\b |\btrade\s + history\b /.test(normalized)) {
			const wordToNumber: Record<string, number> = {
				one: 1, two: 2, three: 3, four: 4, five: 5,
				six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
			};

			const numericMatch = normalized.match(/\b(last|past)\s+(\d+)\s+trades?\b/);
			const wordMatch = normalized.match(/\b(last|past)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+trades?\b/);
			const limit = numericMatch
				? Math.max(1, Math.min(20, Number(numericMatch[2])))
				: wordMatch
					? wordToNumber[wordMatch[2]]
					: 5;

			const trades = await this.deps.trader.getRecentTrades(discordUserId, limit);
			if (trades.length === 0) {
				return { type: 'text', content: 'You have no recent trades yet.' };
			}

			const lines = trades.map((trade, index) => {
				if (!trade.ok) return `${index + 1}. ❌ Trade failed (${trade.errorCode})`;
				const dollars = (trade.amountCents / 100).toFixed(2);
				const date = new Date(trade.executedAtMs).toUTCString();
				return `${index + 1}. ✅ **${trade.outcome}** $${dollars} on \`${trade.marketId}\` — ${date}`;
			});

			return { type: 'text', content: [`**Your last ${limit} trades:**`, ...lines].join('\n') };
		}

		// Support both "$1" and "1$" amount formats (users often write amount then $)
		const amountMatch = normalized.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
			?? normalized.match(/\b(\d+(?:\.\d{1,2})?)\s*\$(?!\w)/)
			?? normalized.match(/\b(\d+(?:\.\d{1,2})?)\s*(dollars?|usd|bucks?)\b/);

		// Detect trade action: sell/exit/close => SELL, everything else => BUY
		const isSell = /\b(sell|exit|close)\b/.test(normalized);
		const action: TradeAction = isSell ? 'SELL' : 'BUY';

		// Detect outcome: up/yes/long => YES, down/no/short => NO
		// Use the LAST direction word so "bitcoin up or down ... on down" resolves to DOWN, not UP
		const directionMatches = [...normalized.matchAll(/\b(up|yes|long|down|no|short)\b/g)];
		const lastDir = directionMatches.length > 0 ? directionMatches[directionMatches.length - 1][1] : null;
		const outcome: 'YES' | 'NO' | null =
			lastDir && /^(up|yes|long)$/.test(lastDir) ? 'YES' :
				lastDir && /^(down|no|short)$/.test(lastDir) ? 'NO' :
					null;

		const isMarketInCommand = /\bmarket\s+in\b/i.test(message);
		const hasBetVerb = /\b(bet|buy|sell|trade|exit|close)\b/.test(normalized);

		// ── Sell-without-amount path ──────────────────────────────────────
		// "sell on Grizzlies 76ers 76ers" — no dollar amount, user wants to
		// close their entire position. Look up the position via data API.
		if (isSell && !amountMatch) {
			return this.handleSellWithoutAmount(message, normalized, discordUserId);
		}

		// Allow proceeding without a standard direction word (yes/no/up/down) when a bet verb
		// is present — the outcome can be resolved later via fuzzy matching against market
		// outcome labels (e.g., "Thunder", "OKC" for sports markets).
		if (!amountMatch || (!outcome && !isMarketInCommand && !hasBetVerb) || !/\b(bet|buy|sell|trade|market|exit|close)\b/.test(normalized)) {
			return null;
		}

		const amountDollars = Number(amountMatch[1]);
		if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
			return { type: 'text', content: 'The trade amount is invalid. Please provide a positive amount.' };
		}

		const amountCents = Math.round(amountDollars * 100);
		// resolvedOutcome starts from direction-word detection; may be overridden by market outcome matching below
		let resolvedOutcome: 'YES' | 'NO' | null = outcome;
		let preferredOutcomeLabel: string | null = null;
		let parsedSportsSelection: { teamA: string; teamB: string; selectedSide: string | null } | null = null;

		const assetQuery = /\b(bitcoin|btc)\b/.test(normalized)
			? 'bitcoin up or down'
			: /\b(ethereum|eth)\b/.test(normalized)
				? 'ethereum up or down'
				: null;

		let selectedMarket: Market | null = null;
		let selectedSlug: string | null = null;

		if (assetQuery) {
			// --- Crypto up/down timed markets path ---
			const timeframe = /\b(5|five)\s*(m|min|minute)\b/.test(normalized)
				? '5 minute'
				: /\b(15|fifteen)\s*(m|min|minute)\b/.test(normalized)
					? '15 minute'
					: '';

			// Try direct Gamma events API slug-based resolution first (reliable for timed markets)
			const timedResult = await tryResolveTimedUpDownMarket(this.deps.readService, message);
			selectedMarket = timedResult?.market ?? null;
			selectedSlug = timedResult?.slug ?? null;

			if (!selectedMarket) {
				const candidates = await this.deps.readService.searchMarketsByText(assetQuery);
				selectedMarket = pickBestNaturalTradeMarket(candidates, normalized, timeframe);
			}
		} else if (isMarketInCommand) {
			// --- Generic "market in $X [query] on [label]" path ---
			// Extract raw outcome label from "on [label]" at the end of the message
			const rawLabel = normalized.match(/\bon\s+([a-z0-9][a-z0-9 \-]+?)\s*$/)?.[1]?.trim() ?? null;

			// Try standard direction words first
			if (rawLabel) {
				if (/^(up|yes|long)$/.test(rawLabel)) resolvedOutcome = 'YES';
				else if (/^(down|no|short)$/.test(rawLabel)) resolvedOutcome = 'NO';
			}

			// Build market search query: strip "market in", amount, and "on [label]" suffix
			let queryStr = message.trim();
			queryStr = queryStr.replace(/\bmarket\s+in\b/i, '').trim();
			queryStr = queryStr.replace(/\$\s*\d+(?:\.\d{1,2})?/, '').trim();
			queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*\$(?!\w)/, '').trim();
			queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b/i, '').trim();
			if (rawLabel) {
				const onSuffix = ` on ${rawLabel}`;
				const onIdx = queryStr.toLowerCase().lastIndexOf(onSuffix);
				if (onIdx !== -1) queryStr = queryStr.substring(0, onIdx).trim();
			}

			if (!queryStr) return null;

			const candidates = await this.deps.readService.searchMarketsByText(queryStr);
			selectedMarket = candidates[0] ?? null;

			// If outcome still unresolved, fuzzy-match rawLabel against market outcome tokens
			// In binary markets: outcomes[0] = YES token, outcomes[1] = NO token
			if (selectedMarket && resolvedOutcome === null && rawLabel) {
				const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => o.toLowerCase());
				const matchIdx = outcomeLabels.findIndex(
					(o: string) => o.includes(rawLabel) || rawLabel.includes(o),
				);
				if (matchIdx === 0) resolvedOutcome = 'YES';
				else if (matchIdx >= 1) resolvedOutcome = 'NO';
			}
		} else {
			// --- Fallback: "bet/buy $X on [description] yes/no" ---
			// Strip the action verb, amount, leading "on", and trailing outcome word to get the market description
			let queryStr = message.trim();
			queryStr = queryStr.replace(/^\s*(bet|buy|sell|trade)\b\s*/i, '').trim();
			queryStr = queryStr.replace(/\$\s*\d+(?:\.\d{1,2})?/, '').trim();
			queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*\$(?!\w)/, '').trim();
			queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b/i, '').trim();
			queryStr = queryStr.replace(/^\s*on\b\s*/i, '').trim();
			// Strip trailing direction/outcome word (already captured in resolvedOutcome)
			queryStr = queryStr.replace(/\s*\b(yes|no|up|down|long|short)\s*$/i, '').trim();
			// Normalize / separator to "vs" so the sports search pipeline recognizes it as a matchup
			queryStr = queryStr.replace(/\//g, ' vs ').replace(/\s{2,}/g, ' ').trim();

			// For sports commands like "Team A vs Team B on Team A", search by matchup
			// and keep the trailing side selection for outcome resolution.
			const sportsSelection = extractMatchupSelectionFromTradeText(message);
			parsedSportsSelection = sportsSelection;
			if (sportsSelection) {
				queryStr = `${sportsSelection.teamA} vs ${sportsSelection.teamB}`;
				preferredOutcomeLabel = sportsSelection.selectedSide;
			}

			if (queryStr) {
				let candidates: readonly Market[] = [];
				if (sportsSelection) {
					const quickStartedAt = Date.now();
					const quickCandidates = await searchSportsMatchupQuick(sportsSelection.teamA, sportsSelection.teamB);
					console.log(`[perf:${traceId}] step:write.quickSportsSearch ms=${Date.now() - quickStartedAt} results=${quickCandidates.length}`);
					if (quickCandidates.length > 0) {
						candidates = quickCandidates;
					} else {
						const searchStartedAt = Date.now();
						candidates = await this.deps.readService.searchMarketsByText(queryStr);
						console.log(`[perf:${traceId}] step:write.searchMarketsByText ms=${Date.now() - searchStartedAt} results=${candidates.length}`);
					}
				} else {
					const searchStartedAt = Date.now();
					candidates = await this.deps.readService.searchMarketsByText(queryStr);
					console.log(`[perf:${traceId}] step:write.searchMarketsByText ms=${Date.now() - searchStartedAt} results=${candidates.length}`);
				}
				if (sportsSelection && candidates.length > 0) {
					selectedMarket = pickBestSportsMatchupMarket(candidates, sportsSelection.teamA, sportsSelection.teamB)
						?? pickBestSportsMatchupMarketLenient(candidates, sportsSelection.teamA, sportsSelection.teamB)
						?? candidates.find((m) => m.status === 'active')
						?? candidates[0]
						?? null;
				} else {

					// Extract the trailing potential outcome label from the raw message so we can
					// prefer a market whose outcomes actually contain it.
					// e.g. "bet $1 on Grizzlies 76ers 76ers" → trailingCandidateLabel = "76ers"
					const trailingCandidateLabel = normalized.match(/\b([a-z0-9][\w]*)\s*$/)?.[1]?.trim() ?? '';

					if (trailingCandidateLabel && candidates.length > 1) {
						// Try to find a candidate whose outcome labels include the trailing word.
						// This prevents landing on an O/U market when the user specified a team name.
						const TRADE_ABBR_MAP: Record<string, string> = {
							okc: 'thunder', nyk: 'knicks', lal: 'lakers', bos: 'celtics',
							gsw: 'warriors', mil: 'bucks', bkn: 'nets', lac: 'clippers',
							den: 'nuggets', mia: 'heat', chi: 'bulls', phx: 'suns',
							sas: 'spurs', det: 'pistons', tor: 'raptors', atl: 'hawks',
							por: 'blazers', ind: 'pacers', cle: 'cavaliers', was: 'wizards',
							nop: 'pelicans', uta: 'jazz', sac: 'kings', mem: 'grizzlies',
							hou: 'rockets', orl: 'magic', cha: 'hornets', phi: '76ers',
							dal: 'mavericks', min: 'timberwolves',
						};
						const expandedLabel = TRADE_ABBR_MAP[trailingCandidateLabel] ?? trailingCandidateLabel;
						const outcomeMatch = candidates.find(c => {
							const labels = (c.outcomes as string[]).map((o: string) => o.toLowerCase());
							return labels.some(l => l.includes(expandedLabel) || expandedLabel.includes(l));
						});
						selectedMarket = outcomeMatch ?? candidates[0] ?? null;
					} else {
						selectedMarket = candidates[0] ?? null;
					}
				}
			}
		}

		if (!selectedMarket) {
			return {
				type: 'text',
				content:
					'I could not find an active matching market right now. Try a more specific command like "bet $5 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers" for sports, or "bet $5 on [market description] yes/no" for non-sports. You can also provide the market ID.',
			};
		}

	// If outcome still unresolved (no yes/no/up/down word found), fuzzy-match
		// team/outcome names from the market against the user's full message.
		// This handles sports markets where outcomes are team names (e.g., "Missouri Tigers",
		// "Miami Hurricanes", "Thunder", "Knicks") instead of YES/NO.
		if (!resolvedOutcome && selectedMarket && preferredOutcomeLabel) {
			const normalizedPreferred = normalizeTradeLabel(preferredOutcomeLabel);
			const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => normalizeTradeLabel(o));
			const preferredIdx = outcomeLabels.findIndex(
				(o: string) => o.includes(normalizedPreferred) || normalizedPreferred.includes(o),
			);
			if (preferredIdx === 0) resolvedOutcome = 'YES';
			else if (preferredIdx >= 1) resolvedOutcome = 'NO';
		}

		// Some sports markets are binary YES/NO even when users specify team names.
		// In those cases, map selected team to YES/NO using the matchup question text.
		if (!resolvedOutcome && selectedMarket && parsedSportsSelection?.selectedSide) {
			resolvedOutcome = mapSportsTeamSelectionToBinaryOutcome(selectedMarket.question, parsedSportsSelection);
		}

		if (!resolvedOutcome && selectedMarket) {
			const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => o.toLowerCase());

			// Strategy 1: Multi-word match — check if any full outcome label appears in the message.
			// This handles team names like "Missouri Tigers", "Miami Hurricanes", etc.
			// We check longer labels first to avoid partial matches (e.g. "Miami" matching before "Miami Hurricanes").
			const sortedByLength = outcomeLabels
				.map((label, idx) => ({ label, idx }))
				.sort((a, b) => b.label.length - a.label.length);

			for (const { label, idx } of sortedByLength) {
				// Skip generic labels like "yes"/"no" — those are already handled above
				if (['yes', 'no', 'up', 'down'].includes(label)) continue;
				if (label.length >= 3 && normalized.includes(label)) {
					resolvedOutcome = idx === 0 ? 'YES' : 'NO';
					console.log(`[trade] Multi-word outcome match: "${label}" → ${resolvedOutcome}`);
					break;
				}
			}

			// Strategy 2: Single trailing word match with abbreviation expansion
			if (!resolvedOutcome) {
				const trailingMatch = normalized.match(/\b([a-z0-9]\w*)\s*$/);
				let trailingLabel = trailingMatch?.[1]?.trim() ?? '';

				// Map common sports abbreviations to full team names
				const TEAM_ABBR_MAP: Record<string, string> = {
					// NBA
					okc: 'thunder', nyk: 'knicks', lal: 'lakers', bos: 'celtics',
					gsw: 'warriors', mil: 'bucks', bkn: 'nets', lac: 'clippers',
					den: 'nuggets', mia: 'heat', chi: 'bulls', phx: 'suns',
					sas: 'spurs', det: 'pistons', tor: 'raptors', atl: 'hawks',
					por: 'blazers', ind: 'pacers', cle: 'cavaliers', was: 'wizards',
					nop: 'pelicans', uta: 'jazz', sac: 'kings', mem: 'grizzlies',
					hou: 'rockets', orl: 'magic', cha: 'hornets', phi: '76ers',
					dal: 'mavericks', min: 'timberwolves',
					// NFL
					kc: 'chiefs', buf: 'bills', sf: 'niners', bal: 'ravens',
					// NCAAB common
					missr: 'missouri', cuse: 'syracuse',
				};
				const expanded = TEAM_ABBR_MAP[trailingLabel];
				if (expanded) trailingLabel = expanded;

				if (trailingLabel) {
					const matchIdx = outcomeLabels.findIndex(
						(o: string) => o.includes(trailingLabel) || trailingLabel.includes(o),
					);
					if (matchIdx === 0) resolvedOutcome = 'YES';
					else if (matchIdx >= 1) resolvedOutcome = 'NO';
				}
			}

			// Strategy 3: Check each word in the message against outcome labels
			// (handles cases where the team name word appears mid-message, not just at the end)
			if (!resolvedOutcome) {
				const msgWords = normalized.split(/[\s/,]+/).filter(w => w.length >= 3);
				for (const word of msgWords.reverse()) { // prefer later words (closer to end = more likely the intended team)
					if (['bet', 'buy', 'sell', 'on', 'the', 'game', 'match'].includes(word)) continue;
					const matchIdx = outcomeLabels.findIndex(
						(o: string) => o.includes(word) || word.includes(o),
					);
					if (matchIdx >= 0) {
						resolvedOutcome = matchIdx === 0 ? 'YES' : 'NO';
						console.log(`[trade] Word-scan outcome match: "${word}" → ${resolvedOutcome}`);
						break;
					}
				}
			}
		}

		if (!resolvedOutcome) {
			// Show the actual outcome labels from the market so the user knows what to type
			const labels = (selectedMarket.outcomes as string[]).join(' / ');
			const matchupTeams = extractMatchupTeamsFromTradeText(message);
			if (matchupTeams) {
				const [teamA, teamB] = matchupTeams;
				const amountLabel = Number.isInteger(amountDollars) ? String(amountDollars) : amountDollars.toFixed(2);
				return {
					type: 'text',
					content:
						`I found the matchup, but I still need which side you want. Try: **bet $${amountLabel} on ${teamA} vs ${teamB} on ${teamA}** or **bet $${amountLabel} on ${teamA} vs ${teamB} on ${teamB}**.`,
				};
			}
			return { type: 'text', content: `I could not determine which outcome you want. Try ending with one of: **${labels}**` };
		}
		const pseudoIntent = {
			intent: 'place_bet' as const,
			userId: discordUserId,
			marketId: selectedMarket.id as MarketId,
			outcome: resolvedOutcome,
			action,
			amountCents: amountCents as UsdCents,
			rawText: message,
		};

		if (action === 'BUY' && !isOwnerExempt(discordUserId) && !(await canSpend(discordUserId, pseudoIntent.amountCents))) {
			const remaining = await getRemainingToday(discordUserId);
			const remainingDollars = (remaining / 100).toFixed(2);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			return { type: 'text', content: `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today (limit: $${limitDollars}/day).` };
		}

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== pseudoIntent.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}
				return { id: selectedMarket.id, status: selectedMarket.status };
			},
		};

		const validation = validateAgentOutput(pseudoIntent, validationContext);
		if (!validation.ok) {
			return { type: 'text', content: mapValidationErrorToUserMessage(validation.error.code) };
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = buildTradeRequest(pseudoIntent, {
			identity,
			market: selectedMarket,
			nowMs: this.deps.nowMs(),
		});

		// Store pending trade and return confirmation prompt
		const amountCentsNum = Number(pseudoIntent.amountCents);
		const confirmId = this.storePendingTrade(async () => {
			// Atomic spend check-and-record BEFORE placing the trade (prevents TOCTOU race)
			if (action === 'BUY' && !isOwnerExempt(discordUserId)) {
				const allowed = await trySpend(discordUserId, amountCentsNum);
				if (!allowed) {
					const remaining = await getRemainingToday(discordUserId);
					const remainingDollars = (remaining / 100).toFixed(2);
					return `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today.`;
				}
			}
			const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
			return formatTradeResultMessage(tradeResult, {
				marketQuestion: selectedMarket.question,
				outcome: pseudoIntent.outcome,
				outcomeLabel: (selectedMarket.outcomes as string[])[pseudoIntent.outcome === 'YES' ? 0 : 1],
				action: pseudoIntent.action,
				amountCents: amountCentsNum,
			});
		});

		return {
			type: 'confirm',
			confirmId,
			marketQuestion: selectedMarket.question,
			outcome: pseudoIntent.outcome,
			outcomeLabel: (selectedMarket.outcomes as string[])[pseudoIntent.outcome === 'YES' ? 0 : 1] ?? pseudoIntent.outcome,
			action: pseudoIntent.action,
			amountDollars: (amountCentsNum / 100).toFixed(2),
		};
	}

	/**
	 * Handles sell commands without an explicit dollar amount.
	 * e.g. "sell on Grizzlies 76ers 76ers" or "sell Celtics Spurs Celtics"
	 *
	 * Flow:
	 * 1. Parse the market search query and trailing outcome label
	 * 2. Search for the market
	 * 3. Resolve outcome from the trailing word
	 * 4. Look up the user's position size on that market/outcome
	 * 5. Sell the entire position
	 */
	private async handleSellWithoutAmount(
		message: string,
		normalized: string,
		discordUserId: DiscordUserId,
	): Promise<RouteResult | null> {
		// Strip sell/exit/close verb and optional leading "on" to get market query
		let queryStr = message.trim();
		queryStr = queryStr.replace(/^\s*(sell|exit|close)\b\s*/i, '').trim();
		queryStr = queryStr.replace(/^\s*on\b\s*/i, '').trim();

		if (!queryStr || queryStr.length < 3) {
			return { type: 'text', content: 'Please specify what to sell. Example: `sell Grizzlies 76ers 76ers`' };
		}

		// Extract trailing word as the candidate outcome label
		const trailingMatch = normalized.match(/\b([a-z0-9]\w*)\s*$/);
		const trailingLabel = trailingMatch?.[1]?.trim() ?? '';

		// Team abbreviation map
		const TEAM_ABBR_MAP: Record<string, string> = {
			okc: 'thunder', nyk: 'knicks', lal: 'lakers', bos: 'celtics',
			gsw: 'warriors', mil: 'bucks', bkn: 'nets', lac: 'clippers',
			den: 'nuggets', mia: 'heat', chi: 'bulls', phx: 'suns',
			sas: 'spurs', det: 'pistons', tor: 'raptors', atl: 'hawks',
			por: 'blazers', ind: 'pacers', cle: 'cavaliers', was: 'wizards',
			nop: 'pelicans', uta: 'jazz', sac: 'kings', mem: 'grizzlies',
			hou: 'rockets', orl: 'magic', cha: 'hornets', phi: '76ers',
			dal: 'mavericks', min: 'timberwolves',
			kc: 'chiefs', buf: 'bills', sf: 'niners', bal: 'ravens',
		};
		const expandedLabel = TEAM_ABBR_MAP[trailingLabel] ?? trailingLabel;

		const walletAddr = process.env.POLYMARKET_PROXY_WALLET ?? '';
		if (!walletAddr) {
			return { type: 'text', content: 'Trading wallet not configured. Cannot look up positions.' };
		}

		type PositionRow = {
			market?: string;
			conditionId?: string;
			asset?: string;
			size?: number;
			outcome?: string;
			title?: string;
			outcomeIndex?: number;
			oppositeOutcome?: string;
			curPrice?: number;
			eventSlug?: string;
		};

		let positions: PositionRow[] = [];
		try {
			const posResp = await fetch(
				`https://data-api.polymarket.com/positions?user=${encodeURIComponent(walletAddr)}&sizeThreshold=0`,
			);
			if (posResp.ok) {
				const rows = (await posResp.json()) as PositionRow[];
				positions = Array.isArray(rows) ? rows : [];
			}
		} catch (err) {
			console.error('[sell-no-amount] Position lookup failed:', err);
		}

		let selectedMarket: Market | null = null;
		let selectedPosition: PositionRow | null = null;

		// Position-first selection: when user says "close ...", bind directly to the
		// position they actually hold before considering search ranking among sibling
		// submarkets (main winner vs game winner, etc.).
		if (positions.length > 0) {
			const queryTokens = queryStr
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ')
				.split(/\s+/)
				.filter((w) => w.length >= 4 && !new Set(['team', 'game', 'match', 'winner', 'group']).has(w));

			const desired = expandedLabel.toLowerCase();
			const scored = positions
				.filter((p) => (p.size ?? 0) > 0 && (p.conditionId ?? '').length > 0)
				.map((p) => {
					const title = (p.title ?? '').toLowerCase();
					const tokenScore = queryTokens.length > 0
						? queryTokens.filter((t) => title.includes(t)).length
						: 0;
					const out = (p.outcome ?? '').toLowerCase();
					const outcomeScore = desired && (out.includes(desired) || desired.includes(out)) ? 10 : 0;
					return { p, score: tokenScore + outcomeScore };
				})
				.filter((row) => row.score > 0)
				.sort((a, b) => {
					if (b.score !== a.score) return b.score - a.score;
					return (b.p.size ?? 0) - (a.p.size ?? 0);
				});

			if (scored.length > 0) {
				selectedPosition = scored[0].p;
			} else {
				const openPositions = positions.filter((p) => (p.size ?? 0) > 0 && (p.conditionId ?? '').length > 0);
				if (openPositions.length === 1) {
					selectedPosition = openPositions[0];
				}
			}

			if (selectedPosition?.conditionId) {
				const heldOutcome = selectedPosition.outcome ?? 'YES';
				const oppositeOutcome = selectedPosition.oppositeOutcome ?? (heldOutcome === 'YES' ? 'NO' : 'YES');
				const heldPrice = Number.isFinite(selectedPosition.curPrice) ? Number(selectedPosition.curPrice) : 0.5;
				const idx = selectedPosition.outcomeIndex;

				const outcomes = idx === 1
					? [oppositeOutcome, heldOutcome]
					: [heldOutcome, oppositeOutcome];
				const outcomePrices = idx === 1
					? [Math.max(0, Math.min(1, 1 - heldPrice)), Math.max(0, Math.min(1, heldPrice))]
					: [Math.max(0, Math.min(1, heldPrice)), Math.max(0, Math.min(1, 1 - heldPrice))];

				selectedMarket = {
					id: selectedPosition.conditionId as MarketId,
					question: selectedPosition.title ?? queryStr,
					status: 'active',
					outcomes: outcomes as unknown as Market['outcomes'],
					outcomePrices,
					volume: 0,
					slug: selectedPosition.eventSlug,
					eventSlug: selectedPosition.eventSlug,
				};
			}
		}

		if (!selectedMarket) {
			const candidates = await this.deps.readService.searchMarketsByText(queryStr);
			if (candidates.length === 0) {
				return { type: 'text', content: 'I could not find an active matching market right now. Please specify the market more clearly.' };
			}

			if (expandedLabel && candidates.length > 1) {
				const outcomeMatch = candidates.find(c => {
					const labels = (c.outcomes as string[]).map((o: string) => o.toLowerCase());
					return labels.some(l => l.includes(expandedLabel) || expandedLabel.includes(l));
				});
				selectedMarket = outcomeMatch ?? candidates[0];
			} else {
				selectedMarket = candidates[0];
			}
		}

		if (!selectedMarket) {
			return { type: 'text', content: 'I could not find an active matching market right now.' };
		}

		// Resolve outcome from trailing label
		let resolvedOutcome: 'YES' | 'NO' | null = null;
		const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => o.toLowerCase());
		if (selectedPosition) {
			if (selectedPosition.outcomeIndex === 0) resolvedOutcome = 'YES';
			else if (selectedPosition.outcomeIndex === 1) resolvedOutcome = 'NO';
			else if (selectedPosition.outcome) {
				const posOutcome = selectedPosition.outcome.toLowerCase();
				const idx = outcomeLabels.findIndex((o) => o === posOutcome || o.includes(posOutcome) || posOutcome.includes(o));
				if (idx === 0) resolvedOutcome = 'YES';
				else if (idx >= 1) resolvedOutcome = 'NO';
			}
		}

		// Check standard direction words first
		if (!resolvedOutcome) {
			if (/^(up|yes|long)$/.test(expandedLabel)) resolvedOutcome = 'YES';
			else if (/^(down|no|short)$/.test(expandedLabel)) resolvedOutcome = 'NO';
		}

		// Then fuzzy-match against market outcome labels
		if (!resolvedOutcome && expandedLabel) {
			const matchIdx = outcomeLabels.findIndex(
				(o: string) => o.includes(expandedLabel) || expandedLabel.includes(o),
			);
			if (matchIdx === 0) resolvedOutcome = 'YES';
			else if (matchIdx >= 1) resolvedOutcome = 'NO';
		}

		if (!resolvedOutcome) {
			const labels = (selectedMarket.outcomes as string[]).join(' / ');
			return { type: 'text', content: `I could not determine which outcome you want to sell. Try ending with one of: **${labels}**` };
		}

		// Determine the token ID for the resolved outcome
		// YES = outcomes[0] = token 0, NO = outcomes[1] = token 1
		const outcomeIndex = resolvedOutcome === 'YES' ? 0 : 1;
		const outcomeLabel = (selectedMarket.outcomes as string[])[outcomeIndex];

		let positionSize = 0;
		if (selectedPosition && (selectedPosition.size ?? 0) > 0) {
			const posOutcome = (selectedPosition.outcome ?? '').toLowerCase();
			const desiredOutcome = outcomeLabel.toLowerCase();
			if (!posOutcome || posOutcome === desiredOutcome) {
				positionSize = selectedPosition.size ?? 0;
			}
		}

		if (positionSize <= 0) {
			const selectedConditionId = String(selectedMarket.id).toLowerCase();
			const desiredOutcome = outcomeLabel.toLowerCase();
			const pos = positions.find((p) => {
				const conditionMatch = (p.conditionId ?? '').toLowerCase() === selectedConditionId;
				const outcomeMatch = (p.outcome ?? '').toLowerCase() === desiredOutcome;
				return conditionMatch && outcomeMatch;
			});

			if (pos && pos.size) {
				positionSize = pos.size;
				console.log(`[sell-no-amount] Found position: ${positionSize} shares of ${outcomeLabel} on "${selectedMarket.question}"`);
			} else {
				console.log(`[sell-no-amount] No matching position found. Checked ${positions.length} positions for condition=${selectedMarket.id} outcome=${outcomeLabel}`);
			}
		}

		if (positionSize <= 0) {
			return { type: 'text', content: `You don't appear to have a position on **${outcomeLabel}** in **${selectedMarket.question}**.` };
		}

		// Convert position size to cents: position size from data API is in shares,
		// and we sell at current market price. Use the price * shares to estimate dollar value.
		const currentPrice = selectedMarket.outcomePrices[outcomeIndex] ?? 0.5;
		const estimatedValueDollars = positionSize * currentPrice;
		const amountCents = Math.max(Math.round(estimatedValueDollars * 100), 100) as UsdCents; // min $1

		const pseudoIntent = {
			intent: 'place_bet' as const,
			userId: discordUserId,
			marketId: selectedMarket.id as MarketId,
			outcome: resolvedOutcome,
			action: 'SELL' as TradeAction,
			amountCents,
			rawText: message,
		};

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== pseudoIntent.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}
				return { id: selectedMarket!.id, status: selectedMarket!.status };
			},
		};

		const validation = validateAgentOutput(pseudoIntent, validationContext);
		if (!validation.ok) {
			return { type: 'text', content: mapValidationErrorToUserMessage(validation.error.code) };
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = {
			...buildTradeRequest(pseudoIntent, {
				identity,
				market: selectedMarket,
				nowMs: this.deps.nowMs(),
			}),
			sellShares: positionSize, // pass exact share count so execution skips dollar→share conversion
		};

		const amountCentsNum = Number(pseudoIntent.amountCents);
		const confirmId = this.storePendingTrade(async () => {
			const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
			return formatTradeResultMessage(tradeResult, {
				marketQuestion: selectedMarket!.question,
				outcome: pseudoIntent.outcome,
				outcomeLabel: (selectedMarket!.outcomes as string[])[pseudoIntent.outcome === 'YES' ? 0 : 1],
				action: 'SELL',
				amountCents: amountCentsNum,
			});
		});

		return {
			type: 'confirm',
			confirmId,
			marketQuestion: selectedMarket.question,
			outcome: pseudoIntent.outcome,
			outcomeLabel: (selectedMarket.outcomes as string[])[pseudoIntent.outcome === 'YES' ? 0 : 1] ?? pseudoIntent.outcome,
			action: 'SELL',
			amountDollars: (amountCentsNum / 100).toFixed(2),
			marketInfo: `Position: ${positionSize.toFixed(2)} shares @ ${(currentPrice * 100).toFixed(0)}¢`,
		};
	}
}

function formatTradeResultMessage(
	result: import('../types').TradeResult,
	context: { marketQuestion: string; outcome: 'YES' | 'NO'; outcomeLabel?: string; action: TradeAction; amountCents: number },
): string {
	const amountDollars = (context.amountCents / 100).toFixed(2);
	const actionLabel = context.action === 'SELL' ? 'Sold' : 'Bought';
	const actionVerb = context.action === 'SELL' ? 'SELL' : 'BUY';
	const sideLabel = context.outcomeLabel ?? context.outcome;
	if (result.ok) {
		const isTxHash = result.tradeId.startsWith('0x');
		const tradeIdLine = isTxHash
			? `• Trade: [${result.tradeId.substring(0, 10)}…${result.tradeId.slice(-6)}](<https://polygonscan.com/tx/${result.tradeId}>)`
			: `• Trade ID: \`${result.tradeId}\``;
		const lines = [
			`✅ **${actionLabel}!**`,
			`• Market: **${context.marketQuestion}**`,
			`• Action: **${actionVerb}**`,
			`• Side: **${sideLabel}**`,
			`• Amount: **$${amountDollars}**`,
			tradeIdLine,
			`• Time: ${new Date(result.executedAtMs).toUTCString()}`,
		];
		if (context.action === 'BUY') {
			lines.push('', '*This is not using your money — this is using the Professor\'s money.*');
		}
		return lines.join('\n');
	}

	const errorMessages: Record<string, string> = {
		INVALID_AMOUNT: 'Invalid amount — Polymarket minimum order is $5.',
		INVALID_MARKET: 'Market not found or not tradeable on Polymarket.',
		MARKET_NOT_ACTIVE: 'Market is not currently accepting orders.',
		RATE_LIMITED: 'Rate limited — please wait a moment and try again.',
		LIMIT_EXCEEDED: 'Daily spending limit exceeded.',
		ABUSE_BLOCKED: 'Trade blocked by risk controls.',
		INTERNAL_ERROR: 'Internal error — please try again.',
	};

	// For UPSTREAM_UNAVAILABLE, prefer the specific message from the execution layer
	// (e.g. "Order not filled — you may not have a position") over the generic fallback.
	const upstreamMsg = result.errorCode === 'UPSTREAM_UNAVAILABLE'
		? (result.message ?? 'Polymarket API is temporarily unavailable. Try again shortly.')
		: null;

	const msg = upstreamMsg ?? errorMessages[result.errorCode] ?? `Trade failed: ${result.errorCode}`;
	return `❌ **Trade failed** — ${msg}`;
}

function isDeterministicWriteMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	if (normalized.length === 0) {
		return false;
	}

	const accountScopedPattern = /\b(balance|portfolio|positions?|trade\s+history|history|recent\s+trades?|past\s+\w+\s+trades?|last\s+\w+\s+trades?|connect\s+account|verify|disconnect|status|linked\s+wallet)\b/;
	if (accountScopedPattern.test(normalized)) {
		return true;
	}

	const hasTradeVerb = /\b(bet|place|buy|sell|exit|close|trade|market)\b/.test(normalized);
	const hasAmount = /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b)/.test(normalized);
	// Sell/exit/close without an amount = position-close command — always handle as write
	const isSellNoAmount = /\b(sell|exit|close)\b/.test(normalized) && !hasAmount;
	return (hasTradeVerb && hasAmount) || isSellNoAmount;
}

function extractMatchupTeamsFromTradeText(message: string): [string, string] | null {
	const parsed = extractMatchupSelectionFromTradeText(message);
	if (!parsed) {
		return null;
	}
	return [parsed.teamA, parsed.teamB];
}

function extractMatchupSelectionFromTradeText(message: string): { teamA: string; teamB: string; selectedSide: string | null } | null {
	let queryStr = message.trim();
	queryStr = queryStr.replace(/^\s*(bet|buy|sell|trade)\b\s*/i, '').trim();
	queryStr = queryStr.replace(/\$\s*\d+(?:\.\d{1,2})?/, '').trim();
	queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*\$(?!\w)/, '').trim();
	queryStr = queryStr.replace(/\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b/i, '').trim();
	queryStr = queryStr.replace(/^\s*on\b\s*/i, '').trim();

	const matchupWithSide = queryStr.match(/^(.+?)\s+vs\.?\s+(.+?)\s+on\s+(.+)$/i);
	if (matchupWithSide) {
		const teamA = matchupWithSide[1]?.trim().replace(/^['\"]|['\"]$/g, '');
		const teamB = matchupWithSide[2]?.trim().replace(/^['\"]|['\"]$/g, '');
		const selectedSide = matchupWithSide[3]?.trim().replace(/^['\"]|['\"]$/g, '') ?? null;
		if (!teamA || !teamB) {
			return null;
		}
		return { teamA, teamB, selectedSide: selectedSide || null };
	}

	queryStr = queryStr.replace(/\s*\b(yes|no|up|down|long|short)\s*$/i, '').trim();
	const matchup = queryStr.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
	if (!matchup) return null;

	const teamA = matchup[1]?.trim().replace(/^['\"]|['\"]$/g, '');
	const teamB = matchup[2]?.trim().replace(/^['\"]|['\"]$/g, '');
	if (!teamA || !teamB) {
		return null;
	}
	return { teamA, teamB, selectedSide: null };
}

function normalizeTradeLabel(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeReadSearchQuery(message: string): string {
	let q = message.trim();
	q = q.replace(/^\s*(tell\s+me\s+about|show\s+me|find|search\s+for)\s+/i, '');
	q = q.replace(/^\s*(what\s+are\s+the\s+odds\s+on|what\s+are\s+odds\s+on|odds\s+on)\s+/i, '');
	q = q.replace(/\b(game|market|markets)\b/gi, ' ');
	q = q.replace(/\s{2,}/g, ' ').trim();
	return q.length > 0 ? q : message.trim();
}

function extractVsTeamsFromGeneralQuery(message: string): { teamA: string; teamB: string } | null {
	const cleaned = normalizeReadSearchQuery(message);
	const m = cleaned.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
	if (!m) return null;
	const teamA = m[1].trim().replace(/^['"]|['"]$/g, '');
	const teamB = m[2].trim().replace(/^['"]|['"]$/g, '');
	if (!teamA || !teamB) return null;
	return { teamA, teamB };
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, { signal: controller.signal });
		if (!resp.ok) return null;
		return (await resp.json()) as T;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function findSportsMatchupInLiveMarkets(
	liveMarkets: readonly Market[],
	teamA: string,
	teamB: string,
): readonly Market[] {
	if (liveMarkets.length === 0) return [];
	const aStrictTokens = toNormalizedTokenSet(teamA);
	const bStrictTokens = toNormalizedTokenSet(teamB);
	const aTokens = buildTeamAliasTokens(teamA);
	const bTokens = buildTeamAliasTokens(teamB);
	if (aStrictTokens.size === 0 || bStrictTokens.size === 0 || aTokens.size === 0 || bTokens.size === 0) return [];

	const scored = liveMarkets
		.map((m) => {
			const hay = `${m.question} ${(m.outcomes ?? []).join(' ')} ${m.slug ?? ''} ${m.eventSlug ?? ''}`;
			const strictHayTokens = toNormalizedTokenSet(hay);
			const aStrictOverlap = overlapCount(aStrictTokens, strictHayTokens);
			const bStrictOverlap = overlapCount(bStrictTokens, strictHayTokens);
			if (aStrictOverlap === 0 || bStrictOverlap === 0) return null;

			const tokens = toExtendedTokenSet(hay);
			const aOverlap = overlapCount(aTokens, tokens);
			const bOverlap = overlapCount(bTokens, tokens);
			if (aOverlap === 0 || bOverlap === 0) return null;
			let score = aOverlap * 4 + bOverlap * 4;
			score += aStrictOverlap * 8 + bStrictOverlap * 8;
			const q = normalizeTradeLabel(m.question);
			if (q.includes(' vs ') || q.includes(' v ')) score += 3;
			if (m.status === 'active') score += 2;
			return { m, score };
		})
		.filter((row): row is { m: Market; score: number } => row !== null)
		.sort((x, y) => y.score - x.score || y.m.volume - x.m.volume);

	return scored.slice(0, 10).map((x) => x.m);
}

function buildTeamAliasTokens(team: string): Set<string> {
	const base = [...toNormalizedTokenSet(team)];
	const allParts = normalizeTradeLabel(team)
		.split(/\s+/)
		.filter((t) => t.length >= 2);
	const rawParts = normalizeTradeLabel(team)
		.split(/\s+/)
		.filter((t) => t.length >= 2 && !TEAM_NOISE_TOKENS.has(t));
	const aliases = new Set<string>(base);

	for (const part of rawParts) {
		aliases.add(part);
		if (part.length >= 3) aliases.add(part.slice(0, 3));
	}

	if (rawParts.length >= 2) {
		const acronym = rawParts.map((p) => p[0]).join('');
		if (acronym.length >= 2) aliases.add(acronym);
		const firstTwo = rawParts.slice(0, 2).map((p) => p[0]).join('');
		if (firstTwo.length >= 2) aliases.add(firstTwo);
	}

	// Add short pairwise abbreviations from the full phrase to catch
	// common slug forms like "mst" (Michigan State).
	for (let i = 0; i < allParts.length - 1; i += 1) {
		const left = allParts[i];
		const right = allParts[i + 1];
		if (!left || !right) continue;
		const pairCodeA = `${left[0]}${right.slice(0, 2)}`;
		const pairCodeB = `${left.slice(0, 2)}${right[0]}`;
		if (pairCodeA.length >= 3) aliases.add(pairCodeA);
		if (pairCodeB.length >= 3) aliases.add(pairCodeB);
	}

	return aliases;
}

const TEAM_NOISE_TOKENS = new Set([
	'state', 'university', 'college', 'club', 'team', 'city', 'county',
	'fc', 'cf', 'sc', 'ac', 'bc',
]);

function toExtendedTokenSet(value: string): Set<string> {
	const words = normalizeTradeLabel(value).split(/\s+/).filter((t) => t.length >= 2);
	const tokens = new Set<string>(words);
	for (const w of words) {
		if (w.length >= 3) tokens.add(w.slice(0, 2));
		if (w.length >= 3) tokens.add(w.slice(0, 3));
	}
	return tokens;
}

async function searchSportsMatchupQuick(teamA: string, teamB: string): Promise<readonly Market[]> {
	const query = `${teamA} ${teamB}`.trim();
	if (!query) return [];

	const encoded = encodeURIComponent(query);
	const url = `https://gamma-api.polymarket.com/events?closed=false&limit=8&text_query=${encoded}`;
	type RawEvent = {
		title?: string;
		slug?: string;
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

	const events = await fetchJsonWithTimeout<RawEvent[]>(url, 5000);
	if (!events || !Array.isArray(events) || events.length === 0) return [];

	const aTokens = toNormalizedTokenSet(teamA);
	const bTokens = toNormalizedTokenSet(teamB);
	const results: Market[] = [];

	for (const evt of events) {
		if (!Array.isArray(evt.markets)) continue;
		const hay = normalizeTradeLabel(`${evt.title ?? ''} ${evt.slug ?? ''}`);
		const hTokens = toNormalizedTokenSet(hay);
		let aMatch = overlapCount(aTokens, hTokens) > 0;
		let bMatch = overlapCount(bTokens, hTokens) > 0;

		// Some events have generic titles, but the specific matchup appears in market question.
		if (!aMatch || !bMatch) {
			for (const market of evt.markets) {
				const qTokens = toNormalizedTokenSet(market.question ?? '');
				if (!aMatch && overlapCount(aTokens, qTokens) > 0) aMatch = true;
				if (!bMatch && overlapCount(bTokens, qTokens) > 0) bMatch = true;
				if (aMatch && bMatch) break;
			}
		}
		if (!aMatch || !bMatch) continue;

		for (const m of evt.markets) {
			const marketId = (m.conditionId ?? m.id ?? '').trim();
			if (!marketId) continue;

			let outcomes: string[] = ['YES', 'NO'];
			let outcomePrices: number[] = [0.5, 0.5];
			try {
				const parsedOutcomes = JSON.parse(m.outcomes ?? '[]');
				if (Array.isArray(parsedOutcomes) && parsedOutcomes.length >= 2) {
					outcomes = parsedOutcomes.map((v) => String(v));
				}
			} catch { }
			try {
				const parsedPrices = JSON.parse(m.outcomePrices ?? '[]');
				if (Array.isArray(parsedPrices) && parsedPrices.length >= 2) {
					outcomePrices = parsedPrices.map((v) => Number(v) || 0);
				}
			} catch { }

			results.push({
				id: marketId as MarketId,
				question: (m.question ?? evt.title ?? '').trim(),
				status: m.closed ? 'closed' : m.active === false ? 'paused' : 'active',
				outcomes: outcomes as Market['outcomes'],
				outcomePrices,
				volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
				slug: evt.slug,
				eventSlug: evt.slug,
			});
		}
	}

	return results;
}

async function searchSportsMatchupBySlugGuesses(teamA: string, teamB: string, includeClosed = false): Promise<readonly Market[]> {
	const aCodes = buildSlugCodes(teamA);
	const bCodes = buildSlugCodes(teamB);
	const aPrimaryCodes = buildPrimarySlugCodes(teamA);
	const bPrimaryCodes = buildPrimarySlugCodes(teamB);
	if (aCodes.length === 0 || bCodes.length === 0) return [];

	const leaguePrefixes = ['cbb', 'nba', 'nhl', 'nfl', 'cfb', 'mlb', 'wnba', 'soc', 'lol', 'cs2', 'val'];
	const dateCandidates = buildDateCandidates(3);
	const seen = new Set<string>();
	const candidates: string[] = [];
	const addCandidate = (slug: string): void => {
		if (!seen.has(slug)) {
			seen.add(slug);
			candidates.push(slug);
		}
	};

	// First pass: prioritize high-signal short codes (e.g., lou/mst) on the nearest dates.
	const nearDates = dateCandidates.slice(0, 3);
	for (const league of leaguePrefixes) {
		for (const d of nearDates) {
			for (const a of aPrimaryCodes) {
				for (const b of bPrimaryCodes) {
					addCandidate(`${league}-${a}-${b}-${d}`);
					addCandidate(`${league}-${b}-${a}-${d}`);
				}
			}
		}
	}

	for (const league of leaguePrefixes) {
		for (const d of dateCandidates) {
			for (const a of aCodes) {
				for (const b of bCodes) {
					addCandidate(`${league}-${a}-${b}-${d}`);
					addCandidate(`${league}-${b}-${a}-${d}`);
				}
			}
		}
	}
	const limitedCandidates = candidates.slice(0, 160);

	const fetchBySlug = async (slug: string): Promise<readonly Market[]> => {
		const url = `https://gamma-api.polymarket.com/events?closed=${includeClosed ? 'true' : 'false'}&limit=1&slug=${encodeURIComponent(slug)}`;
		let events = await fetchJsonWithTimeout<Array<{ slug?: string; markets?: Array<{ id?: string; conditionId?: string; question?: string; outcomes?: string; outcomePrices?: string; volume?: number | string; active?: boolean; closed?: boolean; }> }>>(url, 900);
		if (!events || events.length === 0) {
			events = await fetchJsonWithTimeout<Array<{ slug?: string; markets?: Array<{ id?: string; conditionId?: string; question?: string; outcomes?: string; outcomePrices?: string; volume?: number | string; active?: boolean; closed?: boolean; }> }>>(url, 1800);
		}
		if (!events || events.length === 0) return [];
		const event = events[0];
		if (!event || !Array.isArray(event.markets)) return [];

		const mapped: Market[] = [];
		for (const m of event.markets) {
			const marketId = (m.conditionId ?? m.id ?? '').trim();
			if (!marketId) continue;
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

			mapped.push({
				id: marketId as MarketId,
				question: (m.question ?? '').trim(),
				status: m.closed ? 'closed' : m.active === false ? 'paused' : 'active',
				outcomes: outcomes as Market['outcomes'],
				outcomePrices: prices,
				volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
				slug: event.slug,
				eventSlug: event.slug,
			});
		}

		return mapped;
	};

	const priorityCodes = (codes: readonly string[]): string[] => {
		if (codes.length === 0) return [];
		const picked = new Set<string>();
		picked.add(codes[0]);
		if (codes.length > 1) picked.add(codes[1]);
		if (codes.length > 2) picked.add(codes[codes.length - 1]);
		return [...picked];
	};

	// Targeted probe for high-confidence slugs first.
	const probeDates = dateCandidates.slice(0, 3);
	const probeLeagues = ['cbb', 'nba', 'nfl', 'nhl', 'mlb', 'wnba', 'cfb', 'soc'];
	const aProbeCodes = priorityCodes(aPrimaryCodes);
	const bProbeCodes = priorityCodes(bPrimaryCodes);

	for (const league of probeLeagues) {
		for (const d of probeDates) {
			for (const a of aProbeCodes) {
				for (const b of bProbeCodes) {
					for (const slug of [`${league}-${a}-${b}-${d}`, `${league}-${b}-${a}-${d}`]) {
						const hit = await fetchBySlug(slug);
						if (hit.length > 0) return hit;
					}
				}
			}
		}
	}

	const batchSize = 8;
	for (let i = 0; i < limitedCandidates.length; i += batchSize) {
		const batch = limitedCandidates.slice(i, i + batchSize);
		const batchResults = await Promise.all(batch.map((slug) => fetchBySlug(slug)));
		const hit = batchResults.find((markets) => markets.length > 0);
		if (hit && hit.length > 0) return hit;
	}

	return [];
}

async function searchSportsMatchupByEventTextQuery(
	teamA: string,
	teamB: string,
	includeClosed: boolean,
): Promise<readonly Market[]> {
	const queries = [
		`${teamA} ${teamB}`.trim(),
		`${teamA.split(/\s+/)[0] ?? ''} ${teamB.split(/\s+/)[0] ?? ''}`.trim(),
	].filter((q) => q.length >= 3);

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

	const teamATokens = toNormalizedTokenSet(teamA);
	const teamBTokens = toNormalizedTokenSet(teamB);
	const byId = new Map<string, Market>();

	for (const q of queries) {
		const url = `https://gamma-api.polymarket.com/events?closed=${includeClosed ? 'true' : 'false'}&limit=100&text_query=${encodeURIComponent(q)}`;
		const rows = await fetchJsonWithTimeout<RawEvent[]>(url, 2500);
		if (!rows || rows.length === 0) continue;

		for (const evt of rows) {
			const eventHay = `${evt.title ?? ''} ${evt.slug ?? ''}`;
			const eventTokens = toNormalizedTokenSet(eventHay);
			if (overlapCount(teamATokens, eventTokens) === 0 || overlapCount(teamBTokens, eventTokens) === 0) continue;

			for (const m of evt.markets ?? []) {
				const marketId = (m.conditionId ?? m.id ?? '').trim();
				if (!marketId || byId.has(marketId)) continue;

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

				byId.set(marketId, {
					id: marketId as MarketId,
					question: (m.question ?? evt.title ?? '').trim(),
					status: m.closed ? 'closed' : m.active === false ? 'paused' : 'active',
					outcomes: outcomes as Market['outcomes'],
					outcomePrices: prices,
					volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
					slug: evt.slug,
					eventSlug: evt.slug,
				});
			}
		}
	}

	return [...byId.values()];
}

async function searchSportsMatchupByMarketTextQuery(
	teamA: string,
	teamB: string,
	includeClosed: boolean,
): Promise<readonly Market[]> {
	const queries = [
		`${teamA} vs ${teamB}`.trim(),
		`${teamA} ${teamB}`.trim(),
		`${teamA.split(/\s+/)[0] ?? ''} ${teamB.split(/\s+/)[0] ?? ''}`.trim(),
	].filter((q) => q.length >= 3);

	type RawMarket = {
		id?: string;
		conditionId?: string;
		question?: string;
		title?: string;
		outcomes?: string;
		outcomePrices?: string;
		volume?: number | string;
		active?: boolean;
		closed?: boolean;
		slug?: string;
		eventSlug?: string;
	};

	const teamATokens = toNormalizedTokenSet(teamA);
	const teamBTokens = toNormalizedTokenSet(teamB);
	const byId = new Map<string, Market>();

	for (const q of queries) {
		const url = `https://gamma-api.polymarket.com/markets?closed=${includeClosed ? 'true' : 'false'}&limit=200&text_query=${encodeURIComponent(q)}`;
		const rows = await fetchJsonWithTimeout<RawMarket[]>(url, 3000);
		if (!rows || rows.length === 0) continue;

		for (const m of rows) {
			const marketId = (m.conditionId ?? m.id ?? '').trim();
			if (!marketId || byId.has(marketId)) continue;

			const hay = `${m.question ?? m.title ?? ''} ${m.slug ?? ''} ${m.eventSlug ?? ''}`;
			const tokens = toNormalizedTokenSet(hay);
			if (overlapCount(teamATokens, tokens) === 0 || overlapCount(teamBTokens, tokens) === 0) continue;

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

			byId.set(marketId, {
				id: marketId as MarketId,
				question: (m.question ?? m.title ?? '').trim(),
				status: m.closed ? 'closed' : m.active === false ? 'paused' : 'active',
				outcomes: outcomes as Market['outcomes'],
				outcomePrices: prices,
				volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
				slug: m.slug,
				eventSlug: m.eventSlug,
			});
		}
	}

	return [...byId.values()];
}

function buildSlugCodes(team: string): string[] {
	const allParts = normalizeTradeLabel(team)
		.split(/\s+/)
		.filter((p) => p.length >= 2);
	const parts = normalizeTradeLabel(team)
		.split(/\s+/)
		.filter((p) => p.length >= 2 && !TEAM_NOISE_TOKENS.has(p));
	if (parts.length === 0 && allParts.length === 0) return [];

	const set = new Set<string>();

	if (parts.length > 0) {
		set.add(parts[0].slice(0, 3));
		set.add(parts[0].slice(0, 4));
		if (parts.length > 1) {
			set.add(parts.slice(0, 2).map((p) => p[0]).join(''));
			set.add(parts.map((p) => p[0]).join(''));
			set.add(parts[parts.length - 1].slice(0, 3));
			set.add(parts[parts.length - 1].slice(0, 4));
		}
	}

	if (allParts.length > 1) {
		// Include pairwise codes from the full phrase (including tokens like "state")
		// so we can derive slugs such as "mst" from "Michigan State".
		for (let i = 0; i < allParts.length - 1; i += 1) {
			const left = allParts[i];
			const right = allParts[i + 1];
			if (!left || !right) continue;
			set.add(`${left[0]}${right.slice(0, 2)}`);
			set.add(`${left.slice(0, 2)}${right[0]}`);
			set.add(`${left.slice(0, 3)}${right.slice(0, 2)}`);
		}
	}

	return [...set].filter((s) => s.length >= 2 && s.length <= 5);
}

function buildPrimarySlugCodes(team: string): string[] {
	const allParts = normalizeTradeLabel(team)
		.split(/\s+/)
		.filter((p) => p.length >= 2);
	const parts = allParts.filter((p) => !TEAM_NOISE_TOKENS.has(p));
	const set = new Set<string>();

	if (parts.length > 0) {
		set.add(parts[0].slice(0, 3));
		set.add(parts[0].slice(0, 4));
	}
	if (parts.length > 1) {
		set.add(parts.slice(0, 2).map((p) => p[0]).join(''));
	}
	if (allParts.length > 1) {
		set.add(`${allParts[0][0]}${allParts[1].slice(0, 2)}`);
		set.add(`${allParts[0].slice(0, 3)}${allParts[1].slice(0, 2)}`);
	}

	return [...set].filter((s) => s.length >= 2 && s.length <= 5);
}

function buildDateCandidates(dayWindow: number): string[] {
	const deltas: number[] = [0];
	for (let step = 1; step <= dayWindow; step += 1) {
		deltas.push(-step);
		deltas.push(step);
	}

	const dates: string[] = [];
	for (const delta of deltas) {
		const d = new Date();
		d.setUTCDate(d.getUTCDate() + delta);
		dates.push(d.toISOString().slice(0, 10));
	}
	return dates;
}

async function searchSpecificMarketsQuick(query: string): Promise<readonly Market[]> {
	const q = normalizeReadSearchQuery(query);
	if (q.length < 3) return [];
	const matchup = extractVsTeamsFromGeneralQuery(q);
	const leftTokens = matchup ? toNormalizedTokenSet(matchup.teamA) : new Set<string>();
	const rightTokens = matchup ? toNormalizedTokenSet(matchup.teamB) : new Set<string>();

	type RawMarket = {
		id?: string;
		conditionId?: string;
		question?: string;
		title?: string;
		outcomes?: string;
		outcomePrices?: string;
		volume?: number | string;
		active?: boolean;
		closed?: boolean;
		slug?: string;
		eventSlug?: string;
	};
	type RawEvent = {
		title?: string;
		slug?: string;
		markets?: RawMarket[];
	};

	const encoded = encodeURIComponent(q);
	const marketsUrl = `https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=40&text_query=${encoded}`;
	const eventsUrl = `https://gamma-api.polymarket.com/events?closed=false&limit=12&text_query=${encoded}`;

	const [marketRows, eventRows] = await Promise.all([
		fetchJsonWithTimeout<RawMarket[]>(marketsUrl, 5500),
		fetchJsonWithTimeout<RawEvent[]>(eventsUrl, 5500),
	]);

	const byId = new Map<string, Market>();
	const addRawMarket = (m: RawMarket, parentEventSlug?: string): void => {
		const id = (m.conditionId ?? m.id ?? '').trim();
		if (!id || byId.has(id)) return;

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

		byId.set(id, {
			id: id as MarketId,
			question: (m.question ?? m.title ?? '').trim(),
			status: m.closed ? 'closed' : m.active === false ? 'paused' : 'active',
			outcomes: outcomes as Market['outcomes'],
			outcomePrices: prices,
			volume: typeof m.volume === 'number' ? m.volume : Number(m.volume ?? 0) || 0,
			slug: m.slug,
			eventSlug: m.eventSlug ?? parentEventSlug,
		});
	};

	for (const m of marketRows ?? []) addRawMarket(m);
	for (const e of eventRows ?? []) {
		for (const m of e.markets ?? []) addRawMarket(m, e.slug);
	}

	const keywords = toNormalizedTokenSet(q);
	const scored = [...byId.values()]
		.map((m) => {
			const hay = `${m.question} ${m.slug ?? ''} ${m.eventSlug ?? ''}`;
			const tokens = toNormalizedTokenSet(hay);
			const overlap = overlapCount(keywords, tokens);
			let score = overlap * 6;
			if (normalizeTradeLabel(m.question).includes(normalizeTradeLabel(q))) score += 20;
			if (matchup) {
				const leftOverlap = overlapCount(leftTokens, tokens);
				const rightOverlap = overlapCount(rightTokens, tokens);
				// Matchup queries must match BOTH sides; one-sided matches create
				// false positives like unrelated New York/Stanley Cup markets.
				if (leftOverlap > 0 && rightOverlap > 0) score += 30;
				else score -= 100;
				if (normalizeTradeLabel(m.question).includes('vs')) score += 4;
			}
			return { m, score };
		})
		.filter((x) => x.score >= (matchup ? 8 : 2))
		.sort((a, b) => {
			const ar = a.m.status === 'active' ? 0 : a.m.status === 'paused' ? 1 : 2;
			const br = b.m.status === 'active' ? 0 : b.m.status === 'paused' ? 1 : 2;
			if (ar !== br) return ar - br;
			return b.score - a.score || b.m.volume - a.m.volume;
		});

	return scored.slice(0, 12).map((x) => x.m);
}

function toNormalizedTokenSet(value: string): Set<string> {
	const stopWords = new Set([
		'the', 'and', 'vs', 'v', 'on', 'at', 'of', 'to', 'for',
		'state', 'university', 'college', 'club', 'team',
	]);
	const noStemTeams = new Set([
		'76ers', 'spurs', 'nets', 'suns', 'bucks', 'bulls', 'kings', 'hawks',
		'knicks', 'lakers', 'celtics', 'warriors', 'clippers', 'mavericks', 'thunder',
		'predators', 'sharks',
	]);
	const tokens = normalizeTradeLabel(value)
		.split(/\s+/)
		.filter((t) => t.length >= 3 && !stopWords.has(t))
		.map((t) => {
			if (noStemTeams.has(t)) return t;
			return t.endsWith('s') && t.length > 5 ? t.slice(0, -1) : t;
		});
	return new Set(tokens);
}

function overlapCount(a: Set<string>, b: Set<string>): number {
	let count = 0;
	for (const token of a) {
		if (b.has(token)) count += 1;
	}
	return count;
}

function marketLooksLikeMatchupForTeams(market: Market, teamA: string, teamB: string): boolean {
	const aTokens = toNormalizedTokenSet(teamA);
	const bTokens = toNormalizedTokenSet(teamB);
	if (aTokens.size === 0 || bTokens.size === 0) return false;

	const hay = `${market.question} ${(market.outcomes ?? []).join(' ')} ${market.slug ?? ''} ${market.eventSlug ?? ''}`;
	const tokens = toNormalizedTokenSet(hay);
	return overlapCount(aTokens, tokens) > 0 && overlapCount(bTokens, tokens) > 0;
}

async function withTimeoutResult<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(fallback), timeoutMs);
		promise
			.then((value) => {
				clearTimeout(timer);
				resolve(value);
			})
			.catch(() => {
				clearTimeout(timer);
				resolve(fallback);
			});
	});
}

function mapSportsTeamSelectionToBinaryOutcome(
	marketQuestion: string,
	selection: { teamA: string; teamB: string; selectedSide: string | null },
): 'YES' | 'NO' | null {
	if (!selection.selectedSide) return null;

	const selected = normalizeTradeLabel(selection.selectedSide);
	if (!selected) return null;

	const q = normalizeTradeLabel(marketQuestion);
	const splitMatch = q.match(/^(.+?)\s+(?:vs|v)\s+(.+)$/i);
	if (splitMatch) {
		const left = splitMatch[1]?.trim() ?? '';
		const right = splitMatch[2]?.trim() ?? '';
		if (left && (left.includes(selected) || selected.includes(left))) return 'YES';
		if (right && (right.includes(selected) || selected.includes(right))) return 'NO';
	}

	const questionWillMatch = q.match(/^will\s+(.+?)\s+(?:beat|defeat|win(?:\s+against)?|over)\s+(.+?)(?:\s+on\s+|\?|$)/i);
	if (questionWillMatch) {
		const yesTeam = questionWillMatch[1]?.trim() ?? '';
		const noTeam = questionWillMatch[2]?.trim() ?? '';
		if (yesTeam && (yesTeam.includes(selected) || selected.includes(yesTeam))) return 'YES';
		if (noTeam && (noTeam.includes(selected) || selected.includes(noTeam))) return 'NO';
	}

	const teamA = normalizeTradeLabel(selection.teamA);
	const teamB = normalizeTradeLabel(selection.teamB);
	if (teamA && (teamA.includes(selected) || selected.includes(teamA))) return 'YES';
	if (teamB && (teamB.includes(selected) || selected.includes(teamB))) return 'NO';

	return null;
}

function pickBestSportsMatchupMarket(candidates: readonly Market[], teamA: string, teamB: string): Market | null {
	if (candidates.length === 0) return null;
	const a = normalizeTradeLabel(teamA);
	const b = normalizeTradeLabel(teamB);
	const aStrictTokens = toNormalizedTokenSet(teamA);
	const bStrictTokens = toNormalizedTokenSet(teamB);
	const aTokens = buildTeamAliasTokens(teamA);
	const bTokens = buildTeamAliasTokens(teamB);

	if (aStrictTokens.size === 0 || bStrictTokens.size === 0 || aTokens.size === 0 || bTokens.size === 0) {
		return candidates.find((c) => c.status === 'active') ?? candidates[0] ?? null;
	}

	const scored = candidates
		.filter((c) => c.status === 'active')
		.filter((c) => !isPropMarket(c.question))
		.map((c) => {
			const q = normalizeTradeLabel(c.question);
			const hay = normalizeTradeLabel(`${c.question} ${(c.outcomes ?? []).join(' ')} ${c.slug ?? ''} ${c.eventSlug ?? ''}`);
			const strictHayTokens = toNormalizedTokenSet(hay);
			const aStrictOverlap = overlapCount(aStrictTokens, strictHayTokens);
			const bStrictOverlap = overlapCount(bStrictTokens, strictHayTokens);
			if (aStrictOverlap === 0 || bStrictOverlap === 0) {
				return { c, score: -999, aOverlap: 0, bOverlap: 0, aStrictOverlap, bStrictOverlap };
			}

			const qTokens = toExtendedTokenSet(`${c.question} ${(c.outcomes ?? []).join(' ')} ${c.slug ?? ''} ${c.eventSlug ?? ''}`);
			const aOverlap = overlapCount(aTokens, qTokens);
			const bOverlap = overlapCount(bTokens, qTokens);
			let score = 0;

			// Strongly require both sides of the matchup to appear.
			if (aOverlap > 0) score += 12;
			if (bOverlap > 0) score += 12;
			score += aOverlap * 3;
			score += bOverlap * 3;
			score += aStrictOverlap * 10;
			score += bStrictOverlap * 10;
			if (hay.includes(a)) score += 10;
			if (hay.includes(b)) score += 10;
			if (q.includes(' vs ') || q.includes(' v ')) score += 8;
			if (!isBinaryYesNoOutcomes(c.outcomes)) score += 6;

			// For plain matchup queries, prefer the direct head-to-head market over props.
			if (q.includes('spread') || q.includes(' o u ') || q.includes('over under') || q.includes('total points')) {
				score -= 8;
			}

			// Penalize markets that mention only one side; these are commonly wrong picks.
			if ((aOverlap > 0) !== (bOverlap > 0)) score -= 12;

			return { c, score, aOverlap, bOverlap, aStrictOverlap, bStrictOverlap };
		})
		.sort((x, y) => y.score - x.score);

	if (scored.length === 0) return candidates[0] ?? null;

	const strict = scored.filter((s) => s.aOverlap > 0 && s.bOverlap > 0 && s.aStrictOverlap > 0 && s.bStrictOverlap > 0);
	if (strict.length > 0) return strict[0].c;

	// Last fallback inside strict picker: if all active candidates were props,
	// explicitly fail closed instead of returning a wrong market.
	const hadActive = candidates.some((c) => c.status === 'active');
	const hadActiveNonProp = candidates.some((c) => c.status === 'active' && !isPropMarket(c.question));
	if (hadActive && !hadActiveNonProp) return null;

	// Fail closed for sports matchup commands: if we cannot confidently match
	// both teams, do not place/confirm on a potentially unrelated market.
	return null;
}

function pickBestSportsMatchupMarketLenient(candidates: readonly Market[], teamA: string, teamB: string): Market | null {
	if (candidates.length === 0) return null;
	const aTokens = toNormalizedTokenSet(teamA);
	const bTokens = toNormalizedTokenSet(teamB);
	if (aTokens.size === 0 || bTokens.size === 0) return null;

	const scored = candidates
		.filter((c) => !isPropMarket(c.question))
		.map((c) => {
			const hay = normalizeTradeLabel(`${c.question} ${(c.outcomes ?? []).join(' ')} ${c.slug ?? ''} ${c.eventSlug ?? ''}`);
			const tokens = toNormalizedTokenSet(hay);
			const aHit = overlapCount(aTokens, tokens);
			const bHit = overlapCount(bTokens, tokens);
			if (aHit === 0 || bHit === 0) return null;
			let score = aHit * 8 + bHit * 8;
			const q = normalizeTradeLabel(c.question);
			if (q.includes(' vs ') || q.includes(' v ')) score += 8;
			if (!isBinaryYesNoOutcomes(c.outcomes)) score += 5;
			if (c.status === 'active') score += 10;
			return { c, score };
		})
		.filter((row): row is { c: Market; score: number } => row !== null)
		.sort((x, y) => y.score - x.score || y.c.volume - x.c.volume);

	return scored[0]?.c ?? null;
}

function pickBestNaturalTradeMarket(
	markets: readonly Market[],
	normalizedMessage: string,
	timeframeHint: string,
): Market | null {
	const activeMarkets = markets.filter((market) => market.status === 'active');
	if (activeMarkets.length === 0) {
		return null;
	}

	const wantsBitcoin = /\b(bitcoin|btc)\b/.test(normalizedMessage);
	const wantsEthereum = /\b(ethereum|eth)\b/.test(normalizedMessage);
	const wantsFiveMin = /\b(5|five)\s*(m|min|minute)\b/.test(normalizedMessage);
	const wantsFifteenMin = /\b(15|fifteen)\s*(m|min|minute)\b/.test(normalizedMessage);

	const strictCandidates = activeMarkets.filter((market) => {
		const q = market.question.toLowerCase();
		const hasAsset = wantsBitcoin
			? q.includes('bitcoin') || q.includes('btc')
			: wantsEthereum
				? q.includes('ethereum') || q.includes('eth')
				: true;
		const hasTimedLabel = q.includes('up or down') || q.includes('updown');
		const minutes = extractQuestionMinuteRange(q);
		const timeframeOk = wantsFifteenMin
			? minutes === 15
			: wantsFiveMin
				? minutes === 5
				: true;

		return hasAsset && hasTimedLabel && timeframeOk;
	});

	const pool = strictCandidates.length > 0 ? strictCandidates : activeMarkets;

	const scored = pool.map((market) => {
		const q = market.question.toLowerCase();
		let score = 0;

		if (wantsBitcoin) {
			if (q.includes('bitcoin')) score += 8;
			if (q.includes('btc')) score += 5;
		}
		if (wantsEthereum) {
			if (q.includes('ethereum')) score += 8;
			if (q.includes('eth')) score += 5;
		}

		if (q.includes('up or down')) score += 4;
		if (q.includes('updown')) score += 3;

		const rangeMinutes = extractQuestionMinuteRange(q);
		if (wantsFifteenMin) {
			if (rangeMinutes === 15) score += 6;
			else if (rangeMinutes !== null) score -= 3;
		}
		if (wantsFiveMin) {
			if (rangeMinutes === 5) score += 6;
			else if (rangeMinutes !== null) score -= 3;
		}

		if (timeframeHint && q.includes(timeframeHint.replace(' minute', ''))) {
			score += 2;
		}

		if (q.includes('current')) score += 1;

		return { market, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.score > 0 ? scored[0].market : pool[0] ?? null;
}

interface TimedMarketResult {
	market: Market;
	slug: string;
}

async function tryResolveTimedUpDownMarket(
	_readService: PolymarketReadService,
	message: string,
): Promise<TimedMarketResult | null> {
	const normalized = message.trim().toLowerCase();

	// --- detect asset ---
	const wantsBitcoin = /\b(bitcoin|btc)\b/.test(normalized);
	const wantsEthereum = /\b(ethereum|eth)\b/.test(normalized);
	const wantsSolana = /\b(solana|sol)\b/.test(normalized);
	const wantsXrp = /\b(xrp|ripple)\b/.test(normalized);

	const assetSlug = wantsBitcoin ? 'btc' : wantsEthereum ? 'eth' : wantsSolana ? 'sol' : wantsXrp ? 'xrp' : null;
	if (!assetSlug) return null;

	// --- detect timeframe ---
	const wantsFifteen = /\b(15|fifteen)\s*(m|min|minute)/i.test(normalized);
	const wantsFive = /\b(5|five)\s*(m|min|minute)/i.test(normalized);
	const wantsOneHour = /\b(1|one)\s*(h|hr|hour)/i.test(normalized) || /\b(60)\s*(m|min)/i.test(normalized);
	const wantsFourHour = /\b(4|four)\s*(h|hr|hour)/i.test(normalized);
	const wantsOneDay = /\b(1|one)\s*(d|day)/i.test(normalized) || /\b(24)\s*(h|hr|hour)/i.test(normalized);

	const timeframeSlug = wantsFifteen ? '15m' : wantsFive ? '5m' : wantsOneHour ? '1h' : wantsFourHour ? '4h' : wantsOneDay ? '1d' : null;
	if (!timeframeSlug) return null;

	const timeframeSeconds: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
	const intervalSec = timeframeSeconds[timeframeSlug] ?? 900;

	// Must also mention up/down/bet/market to be a timed trade request
	if (!/\b(up|down|bet|market|buy|sell)\b/.test(normalized)) return null;

	// --- Calculate the current time window slug ---
	// Polymarket timed markets use slugs like btc-updown-15m-TIMESTAMP
	// where TIMESTAMP is the unix epoch of the window start, aligned to the interval
	const nowSec = Math.floor(Date.now() / 1000);
	const windowStart = Math.floor(nowSec / intervalSec) * intervalSec;

	// Try current window first, then previous window (in case current hasn't been created yet)
	const candidates = [windowStart, windowStart - intervalSec];

	for (const startTs of candidates) {
		const slug = `${assetSlug}-updown-${timeframeSlug}-${startTs}`;
		console.log(`[tryResolveTimedUpDownMarket] Trying slug: ${slug}`);

		try {
			const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
			const resp = await fetch(url);
			if (!resp.ok) continue;

			const events: GammaEventResponse[] = await resp.json() as GammaEventResponse[];
			if (events.length === 0) continue;

			const event = events[0];
			const eventMarket = event.markets?.[0];
			if (!eventMarket) continue;

			// Skip if market is already closed
			if (eventMarket.closed) {
				console.log(`[tryResolveTimedUpDownMarket] ${slug} is closed, skipping`);
				continue;
			}

			console.log(`[tryResolveTimedUpDownMarket] Found: ${event.title} (slug: ${event.slug})`);

			const outcomes = safeParse<string[]>(eventMarket.outcomes, ['YES', 'NO']).map((o: string) => o.toUpperCase()) as Market['outcomes'];
			const outcomePrices = safeParse<string[]>(eventMarket.outcomePrices, []).map((p: string) => parseFloat(p) || 0);

			return {
				market: {
					id: (eventMarket.conditionId ?? eventMarket.id) as MarketId,
					question: eventMarket.question ?? event.title,
					status: eventMarket.closed ? 'closed' : eventMarket.active === false ? 'paused' : 'active',
					outcomes,
					outcomePrices,
					volume: typeof eventMarket.volume === 'number' ? eventMarket.volume : parseFloat(String(eventMarket.volume ?? '0')) || 0,
				},
				slug: event.slug,
			};
		} catch (err) {
			console.error(`[tryResolveTimedUpDownMarket] Error fetching ${slug}:`, err);
		}
	}

	// Fallback: fetch recent open events with matching prefix
	console.log(`[tryResolveTimedUpDownMarket] Calculated slugs failed, falling back to prefix search`);
	const slugPrefix = `${assetSlug}-updown-${timeframeSlug}`;
	try {
		const url = `https://gamma-api.polymarket.com/events?closed=false&active=true&order=id&ascending=false&limit=50`;
		const resp = await fetch(url);
		if (!resp.ok) return null;

		const events: GammaEventResponse[] = await resp.json() as GammaEventResponse[];
		const matching = events.filter((e) => e.slug?.startsWith(slugPrefix));

		if (matching.length === 0) return null;

		// Pick the event whose slug timestamp is closest to now (prefer current/past over far future)
		matching.sort((a, b) => {
			const tsA = parseInt(a.slug.split('-').pop() ?? '0');
			const tsB = parseInt(b.slug.split('-').pop() ?? '0');
			return Math.abs(tsA - nowSec) - Math.abs(tsB - nowSec);
		});

		const bestEvent = matching[0];
		const eventMarket = bestEvent.markets?.[0];
		if (!eventMarket) return null;

		console.log(`[tryResolveTimedUpDownMarket] Fallback selected: ${bestEvent.title} (slug: ${bestEvent.slug})`);

		const outcomes = safeParse<string[]>(eventMarket.outcomes, ['YES', 'NO']).map((o: string) => o.toUpperCase()) as Market['outcomes'];
		const outcomePrices = safeParse<string[]>(eventMarket.outcomePrices, []).map((p: string) => parseFloat(p) || 0);

		return {
			market: {
				id: (eventMarket.conditionId ?? eventMarket.id) as MarketId,
				question: eventMarket.question ?? bestEvent.title,
				status: eventMarket.closed ? 'closed' : eventMarket.active === false ? 'paused' : 'active',
				outcomes,
				outcomePrices,
				volume: typeof eventMarket.volume === 'number' ? eventMarket.volume : parseFloat(String(eventMarket.volume ?? '0')) || 0,
			},
			slug: bestEvent.slug,
		};
	} catch (err) {
		console.error('[tryResolveTimedUpDownMarket] Fallback error:', err);
		return null;
	}
}

/** Gamma event response shape (minimal) */
interface GammaEventResponse {
	id: string;
	title: string;
	slug: string;
	closed: boolean;
	active: boolean;
	markets?: GammaEventMarket[];
}

interface GammaEventMarket {
	id: string;
	conditionId?: string;
	question?: string;
	outcomes?: string;
	outcomePrices?: string;
	volume?: number | string;
	active?: boolean;
	closed?: boolean;
}

function safeParse<T>(value: string | T | undefined, fallback: T): T {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'string') return value;
	try { return JSON.parse(value) as T; } catch { return fallback; }
}

function extractQuestionMinuteRange(question: string): number | null {
	const match = question.match(/(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)/i);
	if (!match) {
		return null;
	}

	const start = toMinuteOfDay(Number(match[1]), Number(match[2]), match[3].toUpperCase());
	const end = toMinuteOfDay(Number(match[4]), Number(match[5]), match[6].toUpperCase());
	if (start === null || end === null) {
		return null;
	}

	let diff = end - start;
	if (diff < 0) {
		diff += 24 * 60;
	}
	return diff;
}

function toMinuteOfDay(hourRaw: number, minute: number, ampm: string): number | null {
	if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) {
		return null;
	}
	if (hourRaw < 1 || hourRaw > 12 || minute < 0 || minute > 59) {
		return null;
	}

	let hour = hourRaw % 12;
	if (ampm === 'PM') {
		hour += 12;
	}

	return hour * 60 + minute;
}

interface PolymarketActivityRow {
	readonly timestamp?: number;
	readonly type?: string;
	readonly usdcSize?: number;
	readonly size?: number;
	readonly price?: number;
	readonly title?: string;
	readonly slug?: string;
	readonly conditionId?: string;
	readonly outcome?: string;
	readonly side?: string;
}

async function fetchPolymarketActivity(accountId: string, limit: number): Promise<readonly PolymarketActivityRow[]> {
	const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 5)));
	try {
		const response = await fetch(
			`https://data-api.polymarket.com/activity?user=${encodeURIComponent(accountId)}&limit=${safeLimit}`,
		);
		if (!response.ok) {
			return [];
		}

		const rows = (await response.json()) as unknown;
		if (!Array.isArray(rows)) {
			return [];
		}

		return rows as PolymarketActivityRow[];
	} catch {
		return [];
	}
}

function formatActivityLine(activity: PolymarketActivityRow, index: number): string {
	const type = (activity.type || activity.side || 'TRADE').toUpperCase();
	const amount =
		type === 'BUY' || type === 'SELL'
			? (Number(activity.size ?? 0) * Number(activity.price ?? 0))
			: Number(activity.usdcSize ?? activity.size ?? 0);
	const safeAmount = Number.isFinite(amount) ? amount : 0;
	const title =
		(activity.title && activity.title.trim().length > 0 && activity.title.trim())
		|| (activity.slug && activity.slug.trim().length > 0 && activity.slug.trim())
		|| (activity.conditionId ? activity.conditionId.slice(0, 18) : 'Unknown market');
	const side = activity.outcome ? ` (${activity.outcome})` : '';
	const date = activity.timestamp
		? new Date(activity.timestamp * 1000).toUTCString()
		: 'Unknown time';

	return `${index + 1}. **${type}${side}** $${safeAmount.toFixed(2)} — ${title} — ${date}`;
}

function formatCompactVolume(value: number): string {
	if (!Number.isFinite(value)) return '$0';
	if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
	return `$${Math.round(value)}`;
}

function renderMarketBrief(summary: MarketSummary, userMessage: string, matchTier: 'exact' | 'strong' | 'fallback' | 'none' = 'none'): string {
	const sideA = summary.outcomes[0] ?? 'YES';
	const sideB = summary.outcomes[1] ?? 'NO';
	const pctA = Math.round((summary.outcomePrices[0] ?? 0) * 100);
	const pctB = Math.round((summary.outcomePrices[1] ?? 0) * 100);
	const leader = pctA >= pctB ? sideA : sideB;
	const edge = Math.abs(pctA - pctB);
	const status = summary.status === 'active' ? 'Active' : summary.status;
	const volume = formatCompactVolume(summary.volume);
	const isMatchup = /\bvs\b|\bversus\b/i.test(userMessage)
		|| /\bvs\b|\bversus\b/i.test(summary.question)
		|| summary.outcomes.length === 2;

	const lines: string[] = [];
	lines.push(`About this market:`);
	lines.push(`- Question: **${summary.question}**`);
	lines.push(`- Status: **${status}**`);
	if (matchTier !== 'none') {
		const label = matchTier === 'exact'
			? 'exact match'
			: matchTier === 'strong'
				? 'strong matchup match'
				: 'fallback match';
		lines.push(`- Match confidence: **${label}**`);
	}
	if (summary.status === 'closed' && matchTier === 'fallback') {
		lines.push(`- Note: **Active market not found; showing closest recent closed market.**`);
	}
	lines.push(`- Odds now: **${sideA} ${pctA}%** vs **${sideB} ${pctB}%**`);
	lines.push(`- Market lean: **${leader}** by **${edge} points**`);
	lines.push(`- Volume: **${volume}**`);

	lines.push('');
	lines.push('Bet commands for this market:');
	if (isMatchup) {
		lines.push(`- **bet $5 on ${sideA} vs ${sideB} on ${sideA}**`);
		lines.push(`- **bet $5 on ${sideA} vs ${sideB} on ${sideB}**`);
	} else {
		lines.push(`- **bet $5 on ${summary.question} yes**`);
		lines.push(`- **bet $5 on ${summary.question} no**`);
	}

	const linkSlug = summary.eventSlug ?? summary.slug;
	if (linkSlug) {
		lines.push('');
		lines.push('View on Olympus:');
		lines.push(`<https://olympusx.app/app/market/${linkSlug}>`);
	}

	return lines.join('\n');
}

/**
 * Default READ-mode explainer stub.
 * This is intentionally a placeholder for a dedicated read-only AI explainer.
 */
async function defaultReadExplainer(input: ReadExplainerInput): Promise<string> {
	void input.message;
	return `I found ${input.liveMarketCount} live markets and ${input.searchResultsCount} matching results.`;
}

/**
 * Produces up to three factual summaries for READ responses.
 * For sports/esports events, prioritizes outright winner markets over prop/handicap markets.
 */
function summarizeUpToThree(
	markets: readonly import('../types').Market[],
	query?: string
): readonly MarketSummary[] {
	const normalizedQuery = (query ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
	const commonStopwords = new Set([
		'and', 'the', 'for', 'with', 'from', 'this', 'that', 'about', 'will', 'have',
		'what', 'when', 'where', 'which', 'who', 'into', 'over', 'under', 'than', 'tell',
	]);
	const vsParts = normalizedQuery.split(/\s+vs\.?\s+|\s+versus\s+/);
	const isVsQuery = vsParts.length >= 2;
	const leftTerms = isVsQuery
		? new Set(vsParts[0].split(/\s+/).filter(w => w.length >= 3 && !commonStopwords.has(w)))
		: new Set<string>();
	const rightTerms = isVsQuery
		? new Set(vsParts.slice(1).join(' ').split(/\s+/).filter(w => w.length >= 3 && !commonStopwords.has(w)))
		: new Set<string>();

	// Convert Market → MarketSummary directly — no re-fetch needed, search results already have all data
	const prefiltered = markets.slice(0, 20).filter((m) => {
		if (!isVsQuery || leftTerms.size === 0 || rightTerms.size === 0) return true;
		const hay = `${m.question} ${m.slug ?? ''} ${m.eventSlug ?? ''}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
		const leftHit = [...leftTerms].some(t => hay.includes(t));
		const rightHit = [...rightTerms].some(t => hay.includes(t));
		return leftHit && rightHit;
	});
	const candidateMarkets = prefiltered.length > 0 ? prefiltered : markets.slice(0, 20);

	const validSummaries: MarketSummary[] = candidateMarkets.map(m => ({
		id: m.id,
		question: m.question,
		status: m.status,
		outcomes: m.outcomes,
		outcomeCount: m.outcomes.length,
		outcomePrices: m.outcomePrices,
		volume: m.volume,
		slug: m.slug,
		eventSlug: m.eventSlug,
	}));

	// The search layer already ranked markets by keyword relevance then volume.
	// Trust that ordering — do NOT re-sort by volume here, which would promote
	// high-volume but query-irrelevant markets (e.g. Richard Grenell over María Corina Machado).

	// If the query contains specific keywords, prefer the first active non-prop market
	// whose question contains at least one meaningful keyword from the query.
	let bestActive: MarketSummary | undefined;
	if (isVsQuery && leftTerms.size > 0 && rightTerms.size > 0) {
		bestActive = validSummaries.find((m) => {
			if (m.status !== 'active') return false;
			if (isPropMarket(m.question)) return false;
			// For team-vs-team queries, prefer markets whose outcomes are team labels
			// rather than generic YES/NO binaries.
			if (isBinaryYesNoOutcomes(m.outcomes)) return false;

			const hay = `${m.question} ${(m.outcomes ?? []).join(' ')} ${m.slug ?? ''} ${m.eventSlug ?? ''}`
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ');
			const leftHit = [...leftTerms].some((t) => hay.includes(t));
			const rightHit = [...rightTerms].some((t) => hay.includes(t));
			return leftHit && rightHit;
		});
	}
	if (query) {
		const queryKeywords = query
			.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 4 && !new Set([
				'tell', 'about', 'what', 'show', 'market', 'odds', 'will', 'the', 'for',
			]).has(w));
		if (queryKeywords.length > 0) {
			bestActive = validSummaries.find(m =>
				m.status === 'active' &&
				!isPropMarket(m.question) &&
				queryKeywords.some(kw =>
					m.question.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(kw)
				)
			);
		}
	}
	// Extract date from event slug for recency checks (e.g. lol-jdg-blg-2026-03-04 → "2026-03-04")
	const getSlugDate = (m: MarketSummary): string =>
		m.eventSlug?.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? '0000-00-00';
	const today = new Date().toISOString().slice(0, 10);

	// If the best active non-prop is from a stale event (>3 days ago) but there is a
	// more recent active market (even if it's a "prop" like Game 4), prefer the recent one.
	if (bestActive) {
		const bestDate = getSlugDate(bestActive);
		if (bestDate < today) {
			const moreRecent = validSummaries.find(m =>
				m.status === 'active' && m !== bestActive && getSlugDate(m) >= today
			);
			if (moreRecent) bestActive = moreRecent;
		}
	}
	// Fall back to first active non-prop in search order (search already ranked by relevance)
	if (!bestActive) {
		bestActive = validSummaries.find(m => m.status === 'active' && !isPropMarket(m.question));
	}
	// Last resort: any active market
	if (!bestActive) {
		bestActive = validSummaries.find(m => m.status === 'active');
	}

	const rest = validSummaries.filter(m => m !== bestActive);
	const result = bestActive ? [bestActive, ...rest] : validSummaries;
	return result.slice(0, 1);
}

/**
 * Returns true if a market question appears to be a prop/sub-market
 * rather than an outright winner market.
 */
function isPropMarket(question: string): boolean {
	const lower = question.toLowerCase();
	const propIndicators = [
		'game 1', 'game 2', 'game 3', 'game 4', 'game 5',
		'handicap', 'spread', 'total', 'o/u', 'over/under',
		'most sixes', 'most fours', 'most wickets',
		'top batter', 'top batsman', 'top bowler',
		'player of the match', 'man of the match',
		'first blood', 'first to', 'kill handicap',
		'map 1', 'map 2', 'map 3', 'map 4', 'map 5',
		'map winner', 'game winner', 'half time', 'halftime',
		'quarter', '1st map', '2nd map', '3rd map',
	];
	if (propIndicators.some(indicator => lower.includes(indicator))) return true;
	// Player props: "Name: Points/Rebounds/Assists/Kills O/U N.N"
	if (/:\s*(points|rebounds|assists|steals|blocks|threes|turnovers|kills|deaths)\s*(o\/u|over\/under)?\s*\d/i.test(question)) return true;
	// Generic O/U with number anywhere: "O/U 4.5", "Over/Under 2.5"
	if (/\b(o\/u|over\/under)\s*\d/i.test(question)) return true;
	return false;
}

function isBinaryYesNoOutcomes(outcomes: readonly string[]): boolean {
	if (!Array.isArray(outcomes) || outcomes.length < 2) return false;
	const normalized = outcomes.map((o) => normalizeTradeLabel(String(o)));
	return normalized.length === 2
		&& ((normalized[0] === 'yes' && normalized[1] === 'no')
			|| (normalized[0] === 'no' && normalized[1] === 'yes'));
}

/**
 * Validation errors are mapped to user-safe language at the orchestration boundary.
 * Internal error codes are not exposed directly to Discord users.
 */
function mapValidationErrorToUserMessage(errorCode: ValidationErrorCode): string {
	switch (errorCode) {
		case 'ACCOUNT_NOT_CONNECTED':
			return 'Trading is not available right now. Please contact an admin.';
		case 'INVALID_MARKET':
			return 'That market could not be found. Please check the market and try again.';
		case 'MARKET_NOT_ACTIVE':
			return 'That market is not currently active for trading.';
		case 'INVALID_AMOUNT':
			return 'The trade amount is invalid. Please provide a positive whole-number amount in cents.';
		case 'LIMIT_EXCEEDED':
			return 'This trade exceeds your current spending limit window.';
		default:
			return assertNever(errorCode);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled case: ${String(value)}`);
}

/**
 * Detects greetings and casual chat that have no market-query intent.
 * When true, the router skips market search and lets the AI respond
 * conversationally without appending random Olympus links.
 */
const GREETING_PATTERNS = [
	/^\s*(hi|hey|hello|yo|sup|hola|howdy|hiya|heya|what'?s?\s*up|wassup|wsp)\s*[.!?]*\s*$/i,
	/^\s*(hi|hey|hello|yo)\s+(there|everyone|all|guys|folks|team|bot|buddy|friend|fam|bro|dude|man)\s*[.!?]*\s*$/i,
	/^\s*(good\s+(morning|afternoon|evening|night|day))\s*[.!?]*\s*$/i,
	/^\s*(gm|gn|gg|ty|thx|thanks|thank\s+you|cheers)\s*[.!?]*\s*$/i,
	/^\s*(how\s+are\s+you|how'?s?\s+it\s+going|how\s+do\s+you\s+do)\s*\?*\s*$/i,
	/^\s*(nice\s+to\s+meet\s+you|pleased\s+to\s+meet\s+you)\s*[.!?]*\s*$/i,
	/^\s*(bye|goodbye|see\s+ya|later|cya|peace\s+out|take\s+care)\s*[.!?]*\s*$/i,
	/^\s*(lol|lmao|haha|hehe|xd|kek|rofl|😂|🤣|👋|😀|😊|🙌)\s*$/i,
	/^\s*[👋🙋‍♂️🙋‍♀️🙋😀😊🤝✌️🫡]+\s*$/,
];

export function isCasualChat(message: string): boolean {
	const trimmed = message.trim();
	// Very short messages with no topic substance
	if (trimmed.length <= 2 && !/\d/.test(trimmed)) return true;
	return GREETING_PATTERNS.some(pattern => pattern.test(trimmed));
}
