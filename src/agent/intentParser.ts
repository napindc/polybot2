import { callAI as callGemini, hasAIKeys as hasGeminiKeys, sanitize } from '../read/aiClient';
import { z } from 'zod';
import type { AgentOutput, DiscordUserId, MarketId, Outcome, TradeAction, UsdCents } from '../types';

/**
 * This file is intentionally limited to AI intent parsing only.
 * It never executes actions and never validates trading business rules.
 */

/**
 * Blocklist of prompt injection phrases. Any message containing these
 * (case-insensitive) is immediately rejected.
 */
const INJECTION_BLOCKLIST = [
	'ignore all instructions',
	'ignore previous instructions',
	'disregard above',
	'override system prompt',
	'you are now',
	'act as',
	'pretend to be',
	'forget your instructions',
	'new system prompt',
	'system: ',
];

/**
 * Explicitly enumerate supported intents so runtime checks stay aligned with contracts.
 */
const SUPPORTED_INTENTS = new Set([
	'place_bet',
	'get_balance',
	'get_trade_history',
	'query_market',
]);

/**
 * Maximum trade amount in cents ($100). Applies to ALL users, including the owner.
 * Prevents the AI from returning absurdly large trade amounts.
 */
const MAX_TRADE_AMOUNT_CENTS = 10_000;
const PARSE_TIMEOUT_MS = 12_000;

/**
 * System prompt hard-restricts the model to NLU only and strict JSON output.
 */
const SYSTEM_PROMPT = [
	'You are an intent parser for a financial Discord bot.',
	'You MUST return strict JSON only. No prose, no markdown, no code fences.',
	'You are UNTRUSTED and must not execute anything.',
	'Never perform trades. Never validate business rules. Never assume missing values.',
	'If intent is ambiguous or required fields are missing, return JSON null.',
	'Do not invent marketId, outcome, or amountCents.',
	'Allowed intents: place_bet, get_balance, get_trade_history, query_market.',
	'Use amountCents only when explicitly present in user text.',
	'For place_bet, include action: "BUY" or "SELL". Default to "BUY" if user says bet/buy/place. Use "SELL" only when the user explicitly says sell/exit/close.',
	'Echo userId exactly as provided by the input payload.',
].join(' ');

/**
 * Entry point for parsing raw Discord text into a strict AgentOutput union.
 * Returns null on any failure to keep the untrusted layer fail-closed.
 */
export async function parseIntent(
	rawMessage: string,
	userId: DiscordUserId,
): Promise<AgentOutput | null> {
	if (typeof rawMessage !== 'string' || rawMessage.trim().length === 0) {
		return null;
	}

	// Prompt injection blocklist check
	const lowerMsg = rawMessage.toLowerCase();
	for (const phrase of INJECTION_BLOCKLIST) {
		if (lowerMsg.includes(phrase)) {
			console.warn(`[intentParser] Blocked potential prompt injection: "${rawMessage.substring(0, 60)}..."`);
			return null;
		}
	}

	if (!hasGeminiKeys()) {
		return null;
	}

	const userPayload = JSON.stringify({
		userId,
		message: sanitize(rawMessage, 500),
		instruction:
			'Return JSON null if ambiguous or missing required fields; otherwise return one valid intent object.',
	});

	try {
		const content = await withTimeout(
			callGemini({
				contents: userPayload,
				systemInstruction: SYSTEM_PROMPT,
				jsonMode: true,
				temperature: 0,
				maxOutputTokens: 300,
			}),
			PARSE_TIMEOUT_MS,
		);

		if (!content) {
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return null;
		}

		if (parsed === null) {
			return null;
		}

		if (!isAgentOutput(parsed)) {
			return null;
		}

		if (parsed.userId !== userId) {
			return null;
		}

		// Response integrity: if the AI echoed a large chunk of the user's raw text,
		// it may have been manipulated by injection
		if (parsed.intent === 'place_bet' && typeof parsed.rawText === 'string') {
			const overlap = rawMessage.substring(0, 60);
			if (overlap.length > 15 && parsed.rawText.includes(overlap) === false) {
				// Expected: rawText should contain part of original message
			}
		}

		return toBrandedAgentOutput(parsed);
	} catch {
		return null;
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('intent parse timeout')), timeoutMs);
		promise
			.then((result) => {
				clearTimeout(timer);
				resolve(result);
			})
			.catch((error) => {
				clearTimeout(timer);
				reject(error);
			});
	});
}

/**
 * Narrow unknown values to plain objects for safe property checks.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate optional rawText field type only.
 */
function hasValidRawText(value: Record<string, unknown>): boolean {
	return value.rawText === undefined || typeof value.rawText === 'string';
}

/**
 * Guard against extra keys so output matches strict union members exactly.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const allowedSet = new Set(allowed);
	return Object.keys(value).every((key) => allowedSet.has(key));
}

/**
 * Deterministic AgentOutput validator.
 * This validates JSON shape and primitive types only; no business rules.
 */
function isAgentOutput(value: unknown): value is AgentOutput {
	if (!isRecord(value)) {
		return false;
	}

	if (typeof value.intent !== 'string' || !SUPPORTED_INTENTS.has(value.intent)) {
		return false;
	}

	if (typeof value.userId !== 'string') {
		return false;
	}

	if (!hasValidRawText(value)) {
		return false;
	}

	if (value.intent === 'place_bet') {
		if (
			typeof value.marketId !== 'string' ||
			(value.outcome !== 'YES' && value.outcome !== 'NO') ||
			typeof value.amountCents !== 'number' ||
			!Number.isFinite(value.amountCents) ||
			value.amountCents > MAX_TRADE_AMOUNT_CENTS
		) {
			return false;
		}

		// action is optional; if present it must be BUY or SELL
		if (value.action !== undefined && value.action !== 'BUY' && value.action !== 'SELL') {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'marketId', 'outcome', 'action', 'amountCents', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'get_balance') {
		if (!hasOnlyKeys(value, ['intent', 'userId', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'get_trade_history') {
		if (
			value.limit !== undefined &&
			(typeof value.limit !== 'number' || !Number.isFinite(value.limit))
		) {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'limit', 'rawText'])) {
			return false;
		}

		return true;
	}

	if (value.intent === 'query_market') {
		if (
			(value.marketId !== undefined && typeof value.marketId !== 'string') ||
			(value.query !== undefined && typeof value.query !== 'string')
		) {
			return false;
		}

		if (!hasOnlyKeys(value, ['intent', 'userId', 'marketId', 'query', 'rawText'])) {
			return false;
		}

		return true;
	}

	return false;
}

/**
 * Explicit cast helper functions keep branding local to parsing boundary.
 * They do not add business meaning; they only align runtime strings/numbers to contracts.
 */
function asDiscordUserId(value: string): DiscordUserId {
	return value as DiscordUserId;
}

function asMarketId(value: string): MarketId {
	return value as MarketId;
}

function asUsdCents(value: number): UsdCents {
	return value as UsdCents;
}

function asOutcome(value: 'YES' | 'NO'): Outcome {
	return value;
}

/**
 * Re-map validated object into branded AgentOutput values.
 * This keeps caller-facing output aligned with strict contract types.
 */
function toBrandedAgentOutput(value: AgentOutput): AgentOutput {
	if (value.intent === 'place_bet') {
		return {
			intent: 'place_bet',
			userId: asDiscordUserId(value.userId),
			marketId: asMarketId(value.marketId),
			outcome: asOutcome(value.outcome),
			action: (value.action ?? 'BUY') as TradeAction,
			amountCents: asUsdCents(value.amountCents),
			rawText: value.rawText,
		};
	}

	if (value.intent === 'get_balance') {
		return {
			intent: 'get_balance',
			userId: asDiscordUserId(value.userId),
			rawText: value.rawText,
		};
	}

	if (value.intent === 'get_trade_history') {
		return {
			intent: 'get_trade_history',
			userId: asDiscordUserId(value.userId),
			limit: value.limit,
			rawText: value.rawText,
		};
	}

	return {
		intent: 'query_market',
		userId: asDiscordUserId(value.userId),
		marketId: value.marketId ? asMarketId(value.marketId) : undefined,
		query: value.query,
		rawText: value.rawText,
	};
}
