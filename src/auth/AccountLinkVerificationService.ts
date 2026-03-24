import { AccountLinkChallengeService, type AccountLinkChallenge } from './AccountLinkChallengeService';
import type { DiscordUserId, PolymarketAccountId } from '../types';

/**
 * Verifies that a signature proves control of a claimed Polymarket account.
 *
 * Trust boundary:
 * - This interface encapsulates crypto/wallet-specific verification logic.
 * - This service only orchestrates deterministic flow around that verifier.
 */
export interface SignatureVerifier {
	verify(message: string, signature: string, accountId: string): Promise<boolean>;
}

export type VerifyLinkResult =
	| {
			readonly ok: true;
			readonly discordUserId: DiscordUserId;
			readonly polymarketAccountId: PolymarketAccountId;
		}
	| {
			readonly ok: false;
			readonly errorCode: 'CHALLENGE_INVALID' | 'SIGNATURE_INVALID';
		};

/**
 * Verifies account-link ownership proofs using challenge + signature.
 *
 * Scope and boundaries:
 * - Does not generate challenges (handled by AccountLinkChallengeService).
 * - Does not persist final account mappings.
 * - Does not handle Discord transport concerns.
 */
export class AccountLinkVerificationService {
	public constructor(
		private readonly challengeService: AccountLinkChallengeService,
		private readonly signatureVerifier: SignatureVerifier,
	) {}

	/**
	 * Validates challenge state, reconstructs exact signed message, then verifies signature.
	 * Success is returned only when both challenge validation and signature verification pass.
	 */
	public async verifyLink(
		discordUserId: DiscordUserId,
		nonce: string,
		polymarketAccountId: PolymarketAccountId,
		signature: string,
		nowMs: number,
	): Promise<VerifyLinkResult> {
		try {
			const challengeValidation = await this.challengeService.validateWithoutConsume(
				discordUserId,
				nonce,
				nowMs,
			);
			if (!challengeValidation.ok) {
				return {
					ok: false,
					errorCode: 'CHALLENGE_INVALID',
				};
			}

			const message = buildSignedLinkMessage(challengeValidation.challenge);
			const signatureIsValid = await this.signatureVerifier.verify(
				message,
				signature,
				polymarketAccountId,
			);

			if (!signatureIsValid) {
				return {
					ok: false,
					errorCode: 'SIGNATURE_INVALID',
				};
			}

			const consumeResult = await this.challengeService.consumeChallenge(challengeValidation.challenge.nonce);
			if (!consumeResult.ok) {
				return {
					ok: false,
					errorCode: 'CHALLENGE_INVALID',
				};
			}

			return {
				ok: true,
				discordUserId,
				polymarketAccountId,
			};
		} catch {
			return {
				ok: false,
				errorCode: 'SIGNATURE_INVALID',
			};
		}
	}
}

/**
 * Reconstructs the exact message that must be signed by the wallet owner.
 *
 * Deterministic message construction is required so verifier and signer are aligned,
 * and so replay windows are bounded by the embedded challenge timestamps.
 */
export function buildSignedLinkMessage(
	challenge: AccountLinkChallenge,
): string {
	return [
		'Polymarket Account Link Challenge',
		`Discord User: ${challenge.discordUserId}`,
		`Nonce: ${challenge.nonce}`,
		`Issued At (ms): ${challenge.issuedAtMs}`,
		`Expires At (ms): ${challenge.expiresAtMs}`,
	].join('\n');
}

