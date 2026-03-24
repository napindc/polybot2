import type { DiscordUserId } from '../types';

/**
 * Fixed challenge TTL used to limit replay window.
 */
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * One-time challenge used during account-link flow.
 *
 * Replay-attack prevention fields:
 * - `nonce` uniquely identifies the challenge attempt.
 * - `expiresAtMs` bounds validity to a short window.
 * - `used` enforces one-time consumption semantics.
 */
export interface AccountLinkChallenge {
	readonly discordUserId: DiscordUserId;
	readonly nonce: string;
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
	readonly used: boolean;
}

/**
 * Store contract for persisting short-lived link challenges.
 * I/O implementation details are injected and remain outside this service.
 */
export interface AccountLinkChallengeStore {
	create(challenge: AccountLinkChallenge): Promise<void>;
	getActive(discordUserId: DiscordUserId): Promise<AccountLinkChallenge | null>;
	markUsed(nonce: string): Promise<void>;
}

export type IssueChallengeResult =
	| { readonly ok: true; readonly challenge: AccountLinkChallenge }
	| { readonly ok: false; readonly errorCode: 'STORE_ERROR' };

export type ValidateChallengeResult =
	| { readonly ok: true; readonly challenge: AccountLinkChallenge }
	| {
			readonly ok: false;
			readonly errorCode:
				| 'CHALLENGE_NOT_FOUND'
				| 'NONCE_MISMATCH'
				| 'CHALLENGE_EXPIRED'
				| 'CHALLENGE_ALREADY_USED'
				| 'STORE_ERROR';
		};

export type ConsumeChallengeResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly errorCode: 'STORE_ERROR' };

/**
 * Issues and validates short-lived account-link challenges.
 *
 * This service contains only deterministic challenge lifecycle logic.
 * It does not perform signature verification, wallet access, or Discord transport handling.
 */
export class AccountLinkChallengeService {
	public constructor(
		private readonly store: AccountLinkChallengeStore,
		private readonly ttlMs: number = DEFAULT_CHALLENGE_TTL_MS,
	) {}

	/**
	 * Issues a challenge for a Discord user.
	 *
	 * Single-active policy:
	 * - If a non-expired, unused challenge already exists, return it.
	 * - Otherwise create a new challenge.
	 */
	public async issueChallenge(
		discordUserId: DiscordUserId,
		nowMs: number,
	): Promise<IssueChallengeResult> {
		try {
			const existing = await this.store.getActive(discordUserId);
			if (existing && !existing.used && existing.expiresAtMs > nowMs) {
				return { ok: true, challenge: existing };
			}

			const challenge: AccountLinkChallenge = {
				discordUserId,
				nonce: createNonce(),
				issuedAtMs: nowMs,
				expiresAtMs: nowMs + this.ttlMs,
				used: false,
			};

			await this.store.create(challenge);
			return { ok: true, challenge };
		} catch {
			return { ok: false, errorCode: 'STORE_ERROR' };
		}
	}

	/**
	 * Validates an incoming nonce for a Discord user without consuming the challenge.
	 *
	 * Replay-attack prevention:
	 * - Requires matching challenge record and nonce.
	 * - Rejects expired challenges.
	 * - Rejects already-used challenges.
	 *
	 * Consumption is intentionally separate so callers can perform additional
	 * deterministic checks (e.g., signature verification) before one-time use is enforced.
	 */
	public async validateWithoutConsume(
		discordUserId: DiscordUserId,
		nonce: string,
		nowMs: number,
	): Promise<ValidateChallengeResult> {
		try {
			const challenge = await this.store.getActive(discordUserId);
			if (!challenge) {
				return { ok: false, errorCode: 'CHALLENGE_NOT_FOUND' };
			}

			if (challenge.nonce !== nonce) {
				return { ok: false, errorCode: 'NONCE_MISMATCH' };
			}

			if (challenge.expiresAtMs <= nowMs) {
				return { ok: false, errorCode: 'CHALLENGE_EXPIRED' };
			}

			if (challenge.used) {
				return { ok: false, errorCode: 'CHALLENGE_ALREADY_USED' };
			}

			return { ok: true, challenge };
		} catch {
			return { ok: false, errorCode: 'STORE_ERROR' };
		}
	}

	/**
	 * Consumes a challenge after all external ownership checks succeed.
	 *
	 * Separating consume from validation prevents challenge burn on failed
	 * signature verification attempts and reduces avoidable denial-of-service risk.
	 */
	public async consumeChallenge(nonce: string): Promise<ConsumeChallengeResult> {
		try {
			await this.store.markUsed(nonce);
			return { ok: true };
		} catch {
			return { ok: false, errorCode: 'STORE_ERROR' };
		}
	}

	/**
	 * Backward-compatible helper that validates and consumes in one call.
	 * New verification flow should prefer validateWithoutConsume + consumeChallenge.
	 */
	public async validateChallenge(
		discordUserId: DiscordUserId,
		nonce: string,
		nowMs: number,
	): Promise<ValidateChallengeResult> {
		const validation = await this.validateWithoutConsume(discordUserId, nonce, nowMs);
		if (!validation.ok) {
			return validation;
		}

		const consumed = await this.consumeChallenge(nonce);
		if (!consumed.ok) {
			return { ok: false, errorCode: 'STORE_ERROR' };
		}

		return {
			ok: true,
			challenge: {
				...validation.challenge,
				used: true,
			},
		};
	}
}

/**
 * Deterministic nonce constructor.
 *
 * Nonce is generated using cryptographically strong randomness to prevent
 * predictable challenge values and reduce replay/race attack surface.
 */
function createNonce(): string {
	const cryptoApi = globalThis as { crypto?: { randomUUID?: () => string } };
	if (typeof cryptoApi.crypto?.randomUUID !== 'function') {
		throw new Error('Secure random UUID generation is unavailable');
	}

	return cryptoApi.crypto.randomUUID();
}

