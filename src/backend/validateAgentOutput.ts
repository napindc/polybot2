import type { AgentOutput, PolymarketAccountId } from '../types';

/**
 * Deterministic hourly spend ceiling used by validation preconditions.
 * This constant is evaluated without clocks or side effects in this pure module.
 */
const HOURLY_LIMIT_CENTS = 500;

/**
 * Internal-only validation error codes returned by this module.
 * This layer intentionally does not format user-facing messages.
 */
export type ValidationErrorCode =
	| 'ACCOUNT_NOT_CONNECTED'
	| 'INVALID_MARKET'
	| 'MARKET_NOT_ACTIVE'
	| 'INVALID_AMOUNT'
	| 'LIMIT_EXCEEDED';

/**
 * Deterministic validation error payload.
 */
export interface ValidationError {
	readonly code: ValidationErrorCode;
}

/**
 * Pure validation result contract.
 */
export type ValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: ValidationError };

/**
 * Inputs required by deterministic validation.
 * Identity linking is resolved by another layer and injected here as data.
 */
export interface ValidationContext {
	/**
	 * Validation data is injected instead of fetched here so this module stays pure,
	 * deterministic, and easy to test with controlled inputs.
	 */
	/**
	 * Linked Polymarket account for the requesting user.
	 * Null means no account is connected.
	 */
	readonly polymarketAccountId: PolymarketAccountId | null;
	/**
	 * Remaining user spending capacity for the current daily window.
	 * Included as injected context for future deterministic checks.
	 */
	readonly remainingDailyLimitCents: number;
	/**
	 * Amount spent by the user in the current rolling hour.
	 * Included as injected context for future deterministic checks.
	 */
	readonly spentThisHourCents: number;
	/**
	 * Market lookup function is injected so validation does not perform I/O.
	 * This preserves separation of concerns by keeping data access outside this file.
	 */
	readonly marketLookup: (
		marketId: string,
	) => { id: string; status: 'active' | 'closed' | 'paused' } | null;
}

/**
 * Validates whether an AI-parsed action is allowed to proceed to execution layers.
 *
 * Why this rule belongs in this layer:
 * - It is a deterministic precondition for trade execution.
 * - It prevents unsafe transitions from parsed intent to execution path.
 * - It keeps auth/trading/storage concerns separated by consuming only injected context.
 */
export function validateAgentOutput(
	agentOutput: AgentOutput,
	context: ValidationContext,
): ValidationResult {
	if (agentOutput.intent === 'place_bet' && context.polymarketAccountId === null) {
		return {
			ok: false,
			error: {
				code: 'ACCOUNT_NOT_CONNECTED',
			},
		};
	}

	if (agentOutput.intent === 'place_bet') {
		/**
		 * Market validation belongs in this deterministic layer because execution must
		 * never proceed with unknown or inactive markets, and this check is a pure
		 * precondition using injected lookup data (no I/O in this function).
		 */
		const market = context.marketLookup(agentOutput.marketId);
		if (market === null) {
			return {
				ok: false,
				error: {
					code: 'INVALID_MARKET',
				},
			};
		}

		if (market.status !== 'active') {
			return {
				ok: false,
				error: {
					code: 'MARKET_NOT_ACTIVE',
				},
			};
		}
	}

	if (agentOutput.intent === 'place_bet') {
		/**
		 * Amount validation belongs here because it is a deterministic precondition
		 * for execution safety and can be evaluated from injected context only.
		 * Keeping it here preserves purity and prevents invalid amounts from reaching
		 * downstream execution layers.
		 */
		if (!Number.isInteger(agentOutput.amountCents)) {
			return {
				ok: false,
				error: {
					code: 'INVALID_AMOUNT',
				},
			};
		}

		if (agentOutput.amountCents <= 0) {
			return {
				ok: false,
				error: {
					code: 'INVALID_AMOUNT',
				},
			};
		}

		if (agentOutput.amountCents > context.remainingDailyLimitCents) {
			return {
				ok: false,
				error: {
					code: 'LIMIT_EXCEEDED',
				},
			};
		}
	}

	if (agentOutput.intent === 'place_bet') {
		/**
		 * Hourly limit enforcement belongs in deterministic validation because it is
		 * a pure precondition gate that prevents over-limit requests from reaching
		 * execution layers, using only injected spend context and request amount.
		 */
		if (context.spentThisHourCents + agentOutput.amountCents > HOURLY_LIMIT_CENTS) {
			return {
				ok: false,
				error: {
					code: 'LIMIT_EXCEEDED',
				},
			};
		}
	}

	return { ok: true };
}
