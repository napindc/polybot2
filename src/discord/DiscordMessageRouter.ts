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
		try {
			if (isDeterministicWriteMessage(message)) {
				return this.handleWrite(message, discordUserId);
			}

			const pipeline = classifyMessageIntent(message);

			if (pipeline === 'READ') {
				const content = await this.handleRead(message);
				return { type: 'text', content };
			}

			return this.handleWrite(message, discordUserId);
		} catch {
			return { type: 'text', content: 'Something went wrong while handling your request. Please try again.' };
		}
	}

	private async handleRead(message: string): Promise<string> {
		console.log(`[router] handleRead: "${message}"`);

		// Detect greetings / casual chat with no market query intent.
		// Skip market search entirely so the bot responds conversationally
		// without appending random unrelated Olympus links.
		if (isCasualChat(message)) {
			console.log(`[router] Casual chat detected, skipping market search`);
			const liveMarkets = await this.deps.readService.listLiveMarkets();
			return this.readExplainer({
				message,
				liveMarketCount: liveMarkets.length,
				sampleMarketSummaries: [],
				searchResultsCount: 0,
			});
		}

		const liveMarkets = await this.deps.readService.listLiveMarkets();
		console.log(`[router] Live markets: ${liveMarkets.length}`);
		const searchResults = await this.deps.readService.searchMarketsByText(message);
		console.log(`[router] Search results: ${searchResults.length}`);

		// Only show search results if we actually found any.
		// When search returns 0 results, pass an empty sample list so the AI
		// can honestly tell the user we couldn't find a match, instead of
		// showing random unrelated trending markets (like StarCraft II for an NBA query).
		let sampleSummaries;
		if (searchResults.length > 0) {
			// Refresh prices for the top result so the user sees live odds
			// (especially important for live sports where prices change rapidly)
			const refreshed = await this.deps.readService.refreshMarketPrices(searchResults[0] as import('../types').Market);
			const updatedResults = [refreshed, ...searchResults.slice(1)];
			sampleSummaries = summarizeUpToThree(updatedResults, message);
		} else {
			sampleSummaries = [];
		}
		console.log(`[router] Sample summaries: ${sampleSummaries.map(s => s.question).join(' | ')}`);

		return this.readExplainer({
			message,
			liveMarketCount: liveMarkets.length,
			sampleMarketSummaries: sampleSummaries,
			searchResultsCount: searchResults.length,
		});
	}

	private async handleWrite(message: string, discordUserId: DiscordUserId): Promise<RouteResult> {
		const agentOutput = await parseIntent(message, discordUserId);
		if (agentOutput === null) {
			const fallback = await this.tryDeterministicWriteFallback(message, discordUserId);
			if (fallback !== null) {
				return fallback;
			}
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

			if (queryStr) {
				const candidates = await this.deps.readService.searchMarketsByText(queryStr);

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

		if (!selectedMarket) {
			return { type: 'text', content: 'I could not find an active matching market right now. Please specify the market ID.' };
		}

		// If outcome still unresolved (no yes/no/up/down word found), fuzzy-match
		// the trailing word(s) against the market's actual outcome labels.
		// This handles sports markets where outcomes are team names (e.g., "OKC", "NYK",
		// "Thunder", "Knicks") instead of YES/NO.
		if (!resolvedOutcome && selectedMarket) {
			const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => o.toLowerCase());
			// Extract ONLY the last word as a potential outcome label.
			// Using a greedy last-word regex to avoid multi-word captures like
			// "grizzlies 76ers 76ers" which would incorrectly match "grizzlies" via .includes().
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
				// More can be added as needed
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

		if (!resolvedOutcome) {
			// Show the actual outcome labels from the market so the user knows what to type
			const labels = (selectedMarket.outcomes as string[]).join(' / ');
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

		// Search for the market
		const candidates = await this.deps.readService.searchMarketsByText(queryStr);
		if (candidates.length === 0) {
			return { type: 'text', content: 'I could not find an active matching market right now. Please specify the market more clearly.' };
		}

		// Prefer a candidate whose outcome labels include the trailing word
		let selectedMarket: Market | null = null;
		if (expandedLabel && candidates.length > 1) {
			const outcomeMatch = candidates.find(c => {
				const labels = (c.outcomes as string[]).map((o: string) => o.toLowerCase());
				return labels.some(l => l.includes(expandedLabel) || expandedLabel.includes(l));
			});
			selectedMarket = outcomeMatch ?? candidates[0];
		} else {
			selectedMarket = candidates[0];
		}

		if (!selectedMarket) {
			return { type: 'text', content: 'I could not find an active matching market right now.' };
		}

		// Resolve outcome from trailing label
		let resolvedOutcome: 'YES' | 'NO' | null = null;
		const outcomeLabels = (selectedMarket.outcomes as string[]).map((o: string) => o.toLowerCase());

		// Check standard direction words first
		if (/^(up|yes|long)$/.test(expandedLabel)) resolvedOutcome = 'YES';
		else if (/^(down|no|short)$/.test(expandedLabel)) resolvedOutcome = 'NO';

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

		// Look up user's position on this market to determine sell amount
		const walletAddr = process.env.POLYMARKET_PROXY_WALLET ?? '';
		if (!walletAddr) {
			return { type: 'text', content: 'Trading wallet not configured. Cannot look up positions.' };
		}

		// Determine the token ID for the resolved outcome
		// YES = outcomes[0] = token 0, NO = outcomes[1] = token 1
		const outcomeIndex = resolvedOutcome === 'YES' ? 0 : 1;
		const outcomeLabel = (selectedMarket.outcomes as string[])[outcomeIndex];

		let positionSize = 0;
		try {
			const posResp = await fetch(
				`https://data-api.polymarket.com/positions?user=${encodeURIComponent(walletAddr)}&sizeThreshold=0`,
			);
			if (posResp.ok) {
				const positions = (await posResp.json()) as Array<{
					market?: string; conditionId?: string; asset?: string;
					size?: number; outcome?: string; title?: string;
				}>;

				// Match position by market question/title and outcome
				const marketQuestion = selectedMarket.question.toLowerCase();
				const pos = positions.find(p => {
					const titleMatch = p.title?.toLowerCase().includes(marketQuestion.substring(0, 30).toLowerCase())
						|| marketQuestion.includes(p.title?.toLowerCase() ?? '___');
					const outcomeMatch = p.outcome?.toLowerCase() === outcomeLabel.toLowerCase();
					return titleMatch && outcomeMatch;
				});

				if (pos && pos.size) {
					positionSize = pos.size;
					console.log(`[sell-no-amount] Found position: ${positionSize} shares of ${outcomeLabel} on "${selectedMarket.question}"`);
				} else {
					console.log(`[sell-no-amount] No matching position found. Checked ${positions.length} positions for "${marketQuestion.substring(0, 40)}" / ${outcomeLabel}`);
				}
			}
		} catch (err) {
			console.error('[sell-no-amount] Position lookup failed:', err);
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
	// Convert Market → MarketSummary directly — no re-fetch needed, search results already have all data
	const validSummaries: MarketSummary[] = markets.slice(0, 15).map(m => ({
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
