import { verifyMessage } from 'ethers';
import type { SignatureVerifier } from './AccountLinkVerificationService';

/**
 * EVM signature verifier for personal_sign (EIP-191) message signatures.
 *
 * Boundary:
 * - Performs cryptographic verification only.
 * - No challenge, transport, identity mapping, or environment concerns.
 */
export class EvmSignatureVerifier implements SignatureVerifier {
	/**
	 * Verifies that the provided signature recovers exactly to the claimed account.
	 *
	 * Security rules preserved:
	 * - Uses ethers.verifyMessage for EIP-191 handling.
	 * - Does not mutate message/signature/accountId.
	 * - Catches all errors and returns false.
	 */
	public async verify(message: string, signature: string, accountId: string): Promise<boolean> {
		try {
			const recoveredAddress = verifyMessage(message, signature);
			return recoveredAddress.toLowerCase() === accountId.toLowerCase();
		} catch {
			return false;
		}
	}
}

