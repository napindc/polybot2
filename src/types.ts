/**
 * Contracts-only type definitions for the Discord Polymarket bot.
 * No implementation, no API logic, no business logic.
 */

/** Branded primitive for Discord user IDs to avoid mixing with generic strings. */
export type DiscordUserId = string & { readonly __brand: 'DiscordUserId' };

/** Branded primitive for connected Polymarket account IDs. */
export type PolymarketAccountId = string & { readonly __brand: 'PolymarketAccountId' };

/** Branded primitive for market IDs to avoid mixing with other IDs. */
export type MarketId = string & { readonly __brand: 'MarketId' };

/** Branded integer amount in USD cents (e.g., $5.00 = 500). */
export type UsdCents = number & { readonly __brand: 'UsdCents' };

/** Supported binary outcomes for Polymarket-style markets. */
export type Outcome = 'YES' | 'NO';

/** Trade action: BUY to enter a position, SELL to exit. */
export type TradeAction = 'BUY' | 'SELL';

/** Canonical user record used across Discord and backend layers. */
export interface User {
  /** Stable Discord user identifier. */
  readonly id: DiscordUserId;
  /** Current Discord display name (non-authoritative for identity). */
  readonly username: string;
}

/**
 * Stable identity binding between Discord and a connected Polymarket account.
 * This is a contract-only mapping with no authentication or business logic.
 */
export interface UserIdentity {
  /** Stable Discord user identifier. */
  readonly discordUserId: DiscordUserId;
  /** Stable Polymarket account identifier linked to the Discord user. */
  readonly polymarketAccountId: PolymarketAccountId;
}

/** Market contract used by validated trading flows. */
export interface Market {
  /** Unique market identifier. */
  readonly id: MarketId;
  /** Human-readable market question/title. */
  readonly question: string;
  /** Execution eligibility state enforced by deterministic code. */
  readonly status: 'active' | 'closed' | 'paused';
  /** Allowed outcomes for this market. */
  readonly outcomes: readonly Outcome[];
  /** Probability prices per outcome (0-1), aligned with outcomes array. */
  readonly outcomePrices: readonly number[];
  /** Total trading volume in USD. */
  readonly volume: number;
  /** URL-friendly slug from the Gamma API (used for Olympus/Polymarket links). */
  readonly slug?: string;
  /** Parent event slug from the Gamma API — used for Polymarket event URLs. */
  readonly eventSlug?: string;
}

/** AI-parsed trade intent before deterministic validation. */
export interface TradeIntent {
  /** Intent type from the AI parser. */
  readonly intent: 'place_bet';
  /** Requesting Discord user. */
  readonly userId: DiscordUserId;
  /** Target market from user language. */
  readonly marketId: MarketId;
  /** Intended side of the bet. */
  readonly outcome: Outcome;
  /** BUY to enter, SELL to exit. Defaults to BUY if omitted. */
  readonly action?: TradeAction;
  /** User-requested amount in cents (untrusted until validated). */
  readonly amountCents: UsdCents;
}

/** Fully validated trade request safe for execution by trading layer. */
export interface TradeRequest {
  /** Validated bound identity for Discord user and connected Polymarket account. */
  readonly identity: UserIdentity;
  /** Validated market object. */
  readonly market: Market;
  /** Validated trade side. */
  readonly outcome: Outcome;
  /** BUY to enter, SELL to exit. */
  readonly action: TradeAction;
  /** Validated amount in cents after all limit checks. */
  readonly amountCents: UsdCents;
  /** When selling an entire position, the exact share count to sell (bypasses dollar→share conversion). */
  readonly sellShares?: number;
  /** Idempotency key to prevent duplicate execution. */
  readonly idempotencyKey: string;
  /** Request timestamp (epoch ms) from backend boundary. */
  readonly requestedAtMs: number;
}

/** Trade execution success shape. */
export interface TradeResultSuccess {
  readonly ok: true;
  /** Internal trade identifier for auditability. */
  readonly tradeId: string;
  /** Confirmed user ID. */
  readonly userId: DiscordUserId;
  /** Confirmed market ID. */
  readonly marketId: MarketId;
  /** Executed outcome. */
  readonly outcome: Outcome;
  /** Executed amount in cents. */
  readonly amountCents: UsdCents;
  /** Execution timestamp (epoch ms). */
  readonly executedAtMs: number;
}

/** Enumerated failure reasons for deterministic handling and audit. */
export type TradeErrorCode =
  | 'LIMIT_EXCEEDED'
  | 'INVALID_MARKET'
  | 'MARKET_NOT_ACTIVE'
  | 'INVALID_AMOUNT'
  | 'RATE_LIMITED'
  | 'ABUSE_BLOCKED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/** Trade execution failure shape. */
export interface TradeResultFailure {
  readonly ok: false;
  /** Stable machine-readable error code. */
  readonly errorCode: TradeErrorCode;
  /**
   * Optional internal detail string.
   * Execution layers should return errorCode only; any user-facing formatting happens elsewhere.
   */
  readonly message?: string;
  /** Failure timestamp (epoch ms). */
  readonly failedAtMs: number;
}

/** Discriminated union for all trade outcomes. */
export type TradeResult = TradeResultSuccess | TradeResultFailure;

/** User balance and daily limit snapshot for UI/Discord responses. */
export interface Balance {
  /** Owner of this balance snapshot. */
  readonly userId: DiscordUserId;
  /** Current demo balance in cents. */
  readonly availableCents: UsdCents;
  /** Amount spent by this user in current UTC day in cents. */
  readonly spentTodayCents: UsdCents;
  /** Remaining allowed spend today in cents. */
  readonly remainingDailyLimitCents: UsdCents;
  /** Snapshot timestamp (epoch ms). */
  readonly asOfMs: number;
}

/** Trading abstraction for house wallet now and user wallets later. */
export interface Trader {
  /** Executes one validated trade request. */
  placeTrade(request: TradeRequest): Promise<TradeResult>;
  /** Returns current balance snapshot for a user. */
  getBalance(userId: DiscordUserId): Promise<Balance>;
  /** Returns recent trade results for a user (audit-friendly history). */
  getRecentTrades(userId: DiscordUserId, limit: number): Promise<readonly TradeResult[]>;
}

/** JSON primitive type for strict serializable agent payloads. */
export type JsonPrimitive = string | number | boolean | null;
/** JSON object type (recursive). */
export type JsonObject = { readonly [key: string]: JsonValue };
/** JSON array type (recursive). */
export type JsonArray = readonly JsonValue[];
/** Any JSON-serializable value. */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** Supported AI intents from natural language understanding layer. */
export type AgentIntentType =
  | 'place_bet'
  | 'get_balance'
  | 'get_trade_history'
  | 'query_market';

/**
 * Strict JSON contract produced by AI parser.
 * Must be validated before any execution path.
 */
export type AgentOutput =
  | {
      readonly intent: 'place_bet';
      readonly userId: DiscordUserId;
      readonly marketId: MarketId;
      readonly outcome: Outcome;
      readonly action?: TradeAction;
      readonly amountCents: UsdCents;
      readonly rawText?: string;
    }
  | {
      readonly intent: 'get_balance';
      readonly userId: DiscordUserId;
      readonly rawText?: string;
    }
  | {
      readonly intent: 'get_trade_history';
      readonly userId: DiscordUserId;
      readonly limit?: number;
      readonly rawText?: string;
    }
  | {
      readonly intent: 'query_market';
      readonly userId: DiscordUserId;
      readonly marketId?: MarketId;
      readonly query?: string;
      readonly rawText?: string;
    };
