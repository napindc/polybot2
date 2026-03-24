/**
 * Intentionally strict and deterministic classifier for Discord routing.
 *
 * Design goals:
 * - Prefer false negatives over false positives.
 * - Escalate to WRITE only for clearly explicit trade requests.
 * - Keep logic easy to audit (no AI/NLP/heuristics beyond simple patterns).
 */

export type MessageIntentPipeline = 'READ' | 'WRITE';

/**
 * Explicit trade-action verbs required for WRITE routing.
 * Word-boundary matching prevents partial-word false positives.
 */
const WRITE_ACTION_VERB_PATTERN = /\b(bet|place|buy|sell|trade)\b/i;

/**
 * "market in $N" is a common trade shorthand: "market in $1 Bitcoin up or down on down".
 * Detected separately since "market" alone would over-match read queries.
 */
const MARKET_IN_TRADE_PATTERN = /\bmarket\s+in\b/i;

/**
 * Explicit monetary references required for WRITE routing.
 * Matches: $5, $ 5, 5$, 5 dollars, 5 usd, 1.50 bucks
 * Also matches N-before-$ e.g. "1$" which users commonly write.
 */
const MONEY_REFERENCE_PATTERN =
	/(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*\$(?!\w))|(\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b)/i;

/**
 * Conservative question marker pattern.
 * Questions are routed to READ by policy, even if they mention trade-like language.
 */
const QUESTION_PATTERN =
	/\?|^\s*(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/i;

/**
 * Explicit non-trade write intents that should still route to WRITE.
 * These commands are user-account scoped and require deterministic handling.
 */
const ACCOUNT_WRITE_PATTERN =
	/\b(balance|portfolio|positions?|trade\s+history|history|connect\s+account|verify|disconnect|status|linked\s+wallet|recent\s+trades?|past\s+\w+\s+trades?|last\s+\w+\s+trades?)\b/i;

/**
 * Classifies an incoming Discord message into READ or WRITE pipeline.
 *
 * Policy:
 * - WRITE only when message contains BOTH:
 *   1) explicit trade action verb, and
 *   2) explicit monetary reference.
 * - Otherwise READ.
 * - Ambiguity defaults to READ.
 */
export function classifyMessageIntent(message: string): MessageIntentPipeline {
	const normalized = message.trim();

	if (normalized.length === 0) {
		return 'READ';
	}

	if (ACCOUNT_WRITE_PATTERN.test(normalized)) {
		return 'WRITE';
	}

	if (QUESTION_PATTERN.test(normalized)) {
		return 'READ';
	}

	const hasWriteActionVerb = WRITE_ACTION_VERB_PATTERN.test(normalized);
	const hasMonetaryReference = MONEY_REFERENCE_PATTERN.test(normalized);
	const hasMarketInTrade = MARKET_IN_TRADE_PATTERN.test(normalized) && hasMonetaryReference;

	if (hasWriteActionVerb && hasMonetaryReference) {
		return 'WRITE';
	}

	if (hasMarketInTrade) {
		return 'WRITE';
	}

	// "sell/exit/close" without a dollar amount = position-close command → WRITE
	// Only when there's content after the verb (a market or team name), not just the word alone.
	const isSellVerb = /\b(sell|exit|close)\b/i.test(normalized);
	if (isSellVerb && !hasMonetaryReference) {
		const afterVerb = normalized.replace(/^.*?\b(?:sell|exit|close)\b\s*/i, '').trim();
		if (afterVerb.length > 3) return 'WRITE';
	}

	return 'READ';
}

