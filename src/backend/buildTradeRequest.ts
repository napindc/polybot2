import type { AgentOutput, Market, TradeRequest, UserIdentity } from '../types';

/**
 * Fixed idempotency window used to bucket otherwise-identical requests.
 * Same (user + market + outcome + amount + bucket) yields the same key.
 */
const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Inputs required to build a TradeRequest after deterministic validation succeeded.
 *
 * This layer receives fully prepared data from upstream components and performs
 * structural assembly only. It does not perform business-rule enforcement.
 */
export interface BuildTradeRequestContext {
	/** Bound Discord↔Polymarket identity resolved upstream. */
	readonly identity: UserIdentity;
	/** Already-resolved market object provided by upstream lookup. */
	readonly market: Market;
	/** Injected current time in epoch milliseconds; never call Date.now() here. */
	readonly nowMs: number;
}

/**
 * Builds a TradeRequest from validated intent + resolved context.
 *
 * Why no rules are enforced here:
 * - Validation happens in dedicated deterministic validators upstream.
 * - Keeping this function as a pure assembler preserves testability and separation of concerns.
 * - Execution layers receive a normalized request shape with no side effects.
 */
export function buildTradeRequest(
	agentOutput: AgentOutput,
	context: BuildTradeRequestContext,
): TradeRequest {
	/**
	 * Explicitly fail if this builder is called with a non-trade intent.
	 * Upstream routing should prevent this, but this guard keeps the contract strict.
	 */
	if (agentOutput.intent !== 'place_bet') {
		throw new Error('buildTradeRequest requires intent "place_bet"');
	}

	const idempotencyKey = createDeterministicIdempotencyKey({
		identity: context.identity,
		marketId: context.market.id,
		outcome: agentOutput.outcome,
		amountCents: agentOutput.amountCents,
		nowMs: context.nowMs,
		windowMs: IDEMPOTENCY_WINDOW_MS,
	});

	return {
		/**
		 * TradeRequest carries bound user identity directly under `identity`.
		 */
		identity: context.identity,
		market: context.market,
		outcome: agentOutput.outcome,
		action: agentOutput.action ?? 'BUY',
		amountCents: agentOutput.amountCents,
		idempotencyKey,
		requestedAtMs: context.nowMs,
	};
}

interface IdempotencyKeyInput {
	readonly identity: UserIdentity;
	readonly marketId: TradeRequest['market']['id'];
	readonly outcome: TradeRequest['outcome'];
	readonly amountCents: TradeRequest['amountCents'];
	readonly nowMs: number;
	readonly windowMs: number;
}

/**
 * Produces a deterministic key for deduplication across retries in the same time window.
 * No randomness, no I/O, no cryptographic dependency.
 */
function createDeterministicIdempotencyKey(input: IdempotencyKeyInput): string {
	const bucket = Math.floor(input.nowMs / input.windowMs);
	return [
		input.identity.discordUserId,
		input.identity.polymarketAccountId,
		input.marketId,
		input.outcome,
		input.amountCents,
		bucket,
	].join(':');
}
