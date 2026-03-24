import type {
	Balance,
	DiscordUserId,
	MarketId,
	PolymarketAccountId,
	TradeAction,
	TradeErrorCode,
	TradeRequest,
	TradeResult,
	Trader,
	UsdCents,
} from '../types';

function sanitizeExecutionErrorForLog(error: unknown): string {
	const raw = error instanceof Error
		? (error.message || error.name)
		: (() => {
			try {
				return typeof error === 'string' ? error : JSON.stringify(error);
			} catch {
				return String(error);
			}
		})();

	return raw
		.replace(/"(POLY_API_KEY|POLY_API_SECRET|POLY_PASSPHRASE|POLY_SIGNATURE|WALLET_PRIVATE_KEY|BOT_API_SECRET|authorization|x-bot-secret)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
		.replace(/\b(POLY_API_KEY|POLY_API_SECRET|POLYMARKET_API_KEY|POLYMARKET_API_SECRET|POLYMARKET_PASSPHRASE|WALLET_PRIVATE_KEY|OPENAI_API_KEY|GEMINI_API_KEY(?:_\d+)?|BOT_API_SECRET)\s*=\s*[^\s\",]+/gi, '$1=[REDACTED]')
		.replace(/\b(sk-[a-zA-Z0-9_\-]{10,})\b/g, '[REDACTED]')
		.slice(0, 500);
}

/**
 * External execution payload sent to the Polymarket execution boundary.
 * This layer does not implement real API details yet.
 */
export interface ExecuteTradeParams {
	readonly marketId: MarketId;
	readonly outcome: TradeRequest['outcome'];
	readonly action: TradeAction;
	readonly amountCents: UsdCents;
	/** When selling an entire position, the exact share count to sell (bypasses dollar→share conversion). */
	readonly sellShares?: number;
	readonly idempotencyKey: string;
}

/**
 * External execution result shape returned by the Polymarket execution boundary.
 */
export interface ExecuteTradeResponse {
	readonly tradeId: string;
	readonly executedAtMs: number;
}

/**
 * Provider gateway abstraction for user-account-scoped trading calls.
 *
 * Security boundary:
 * - This trader executes only in the scope of an already-linked user account.
 * - Auth and key custody are intentionally out of scope for this file.
 */
export interface PolymarketExecutionGateway {
	executeTradeForAccount(
		polymarketAccountId: PolymarketAccountId,
		params: ExecuteTradeParams,
	): Promise<ExecuteTradeResponse>;

	getBalanceForAccount(polymarketAccountId: PolymarketAccountId): Promise<Balance>;

	getRecentTradesForAccount(
		polymarketAccountId: PolymarketAccountId,
		limit: number,
	): Promise<readonly TradeResult[]>;
}

/**
 * Execution-only Trader implementation for user-connected Polymarket accounts.
 *
 * Why this class is execution-only:
 * - Validation and limits are deterministic upstream responsibilities.
 * - This layer should only transform a validated TradeRequest into execution I/O.
 * - Keeping responsibilities narrow makes failure handling predictable and auditable.
 */
export class UserAccountTrader implements Trader {
	public constructor(
		private readonly gateway: PolymarketExecutionGateway,
		private readonly resolveAccountId: (
			discordUserId: DiscordUserId,
		) => Promise<PolymarketAccountId | null>,
	) {}

	/**
	 * Executes a validated request in the context of the user's Polymarket account.
	 * No revalidation, retries, logging, or business-rule checks occur here.
	 */
	public async placeTrade(request: TradeRequest): Promise<TradeResult> {
		const startedAt = Date.now();
		try {
			const gatewayStartedAt = Date.now();
			const execution = await this.gateway.executeTradeForAccount(
				request.identity.polymarketAccountId,
				{
					marketId: request.market.id,
					outcome: request.outcome,
					action: request.action,
					amountCents: request.amountCents,
					sellShares: request.sellShares,
					idempotencyKey: request.idempotencyKey,
				},
			);
			console.log(`⏱️ [perf:trade] step:gateway.executeTradeForAccount ms=${Date.now() - gatewayStartedAt}`);
			console.log(`⏱️ [perf:trade] placeTrade.ok ms=${Date.now() - startedAt}`);

			return {
				ok: true,
				tradeId: execution.tradeId,
				userId: request.identity.discordUserId,
				marketId: request.market.id,
				outcome: request.outcome,
				amountCents: request.amountCents,
				executedAtMs: execution.executedAtMs,
			};
		} catch (error: unknown) {
			console.error('❌ placeTrade execution error:', sanitizeExecutionErrorForLog(error));
			console.log(`⏱️ [perf:trade] placeTrade.error ms=${Date.now() - startedAt}`);
			const errorCode = mapExecutionErrorToTradeErrorCode(error);
			const errorMessage = isCodeError(error) && typeof (error as { message?: unknown }).message === 'string'
				? (error as { code: string; message: string }).message
				: error instanceof Error ? error.message : undefined;
			console.error(`   ↳ Mapped to error code: ${errorCode}${errorMessage ? ` — ${errorMessage}` : ''}`);
			return {
				ok: false,
				errorCode,
				message: errorMessage,
				failedAtMs: Date.now(),
			};
		}
	}

	/**
	 * Pass-through account-scoped balance read.
	 * Upstream components decide when and why this read should be called.
	 */
	public async getBalance(userId: DiscordUserId): Promise<Balance> {
		const accountId = await this.resolveAccountId(userId);

		if (!accountId) {
			return {
				userId,
				availableCents: 0 as Balance['availableCents'],
				spentTodayCents: 0 as Balance['spentTodayCents'],
				remainingDailyLimitCents: 0 as Balance['remainingDailyLimitCents'],
				asOfMs: Date.now(),
			};
		}

		const accountBalance = await this.gateway.getBalanceForAccount(accountId);

		return {
			userId,
			availableCents: accountBalance.availableCents,
			spentTodayCents: accountBalance.spentTodayCents,
			remainingDailyLimitCents: accountBalance.remainingDailyLimitCents,
			asOfMs: accountBalance.asOfMs,
		};
	}

	/**
	 * Pass-through account-scoped recent trades read.
	 * Account resolution wiring is a TODO boundary outside this execution file.
	 */
	public async getRecentTrades(userId: DiscordUserId, limit: number): Promise<readonly TradeResult[]> {
		const accountId = await this.resolveAccountId(userId);
		if (!accountId) {
			return [];
		}

		const trades = await this.gateway.getRecentTradesForAccount(accountId, limit);
		return trades.map((trade) => {
			if (!trade.ok) {
				return trade;
			}

			return {
				...trade,
				userId,
			};
		});
	}
}

/**
 * Deterministic mapping from unknown execution errors to internal TradeErrorCode values.
 * The mapping is intentionally conservative until provider-specific error contracts are added.
 */
function mapExecutionErrorToTradeErrorCode(error: unknown): TradeErrorCode {
	if (isCodeError(error)) {
		switch (error.code) {
			case 'RATE_LIMITED':
				return 'RATE_LIMITED';
			case 'UPSTREAM_UNAVAILABLE':
				return 'UPSTREAM_UNAVAILABLE';
			case 'INVALID_MARKET':
				return 'INVALID_MARKET';
			case 'MARKET_NOT_ACTIVE':
				return 'MARKET_NOT_ACTIVE';
			case 'INVALID_AMOUNT':
				return 'INVALID_AMOUNT';
			case 'ABUSE_BLOCKED':
				return 'ABUSE_BLOCKED';
			case 'LIMIT_EXCEEDED':
				return 'LIMIT_EXCEEDED';
			default:
				return 'INTERNAL_ERROR';
		}
	}

	return 'INTERNAL_ERROR';
}

interface CodeError {
	readonly code: string;
}

function isCodeError(value: unknown): value is CodeError {
	return (
		typeof value === 'object' &&
		value !== null &&
		'code' in value &&
		typeof (value as { code?: unknown }).code === 'string'
	);
}

