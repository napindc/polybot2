import type { DiscordUserId, PolymarketAccountId } from '../types';

/**
 * Storage boundary for final Discord ↔ Polymarket linkage.
 *
 * Contract notes:
 * - One linked Polymarket account per Discord user.
 * - Re-linking the same Discord user overwrites prior mapping.
 */
export interface AccountLinkStore {
	link(
		discordUserId: DiscordUserId,
		polymarketAccountId: PolymarketAccountId,
		linkedAtMs: number,
	): Promise<void>;
	getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null>;
	unlink(discordUserId: DiscordUserId): Promise<void>;
}

export type PersistenceErrorCode = 'STORE_ERROR' | 'LINK_NOT_FOUND';

export type PersistLinkResult =
	| {
			readonly ok: true;
			readonly discordUserId: DiscordUserId;
			readonly polymarketAccountId: PolymarketAccountId;
			readonly linkedAtMs: number;
		}
	| { readonly ok: false; readonly errorCode: PersistenceErrorCode };

export type GetLinkedAccountResult =
	| { readonly ok: true; readonly polymarketAccountId: PolymarketAccountId }
	| { readonly ok: false; readonly errorCode: PersistenceErrorCode };

export type UnlinkResult =
	| {
			readonly ok: true;
			readonly discordUserId: DiscordUserId;
		}
	| { readonly ok: false; readonly errorCode: PersistenceErrorCode };

/**
 * Final account-link persistence service.
 *
 * Single source of truth rationale:
 * - This service is the canonical owner of persisted account linkage state.
 * - Other layers must read linkage from this source instead of caching linkage logic.
 * - Validation context construction reads from this source to populate
 *   `ValidationContext.polymarketAccountId` deterministically.
 */
export class AccountLinkPersistenceService {
	public constructor(private readonly store: AccountLinkStore) {}

	/**
	 * Persists (or overwrites) the linked account for a Discord user.
	 *
	 * Overwrite semantics enforce exactly one linked Polymarket account per Discord user.
	 */
	public async persistLink(
		discordUserId: DiscordUserId,
		polymarketAccountId: PolymarketAccountId,
		nowMs: number,
	): Promise<PersistLinkResult> {
		try {
			await this.store.link(discordUserId, polymarketAccountId, nowMs);
			return {
				ok: true,
				discordUserId,
				polymarketAccountId,
				linkedAtMs: nowMs,
			};
		} catch (err) {
			console.error('❌ AccountLinkPersistenceService.persistLink error:', err);
			return {
				ok: false,
				errorCode: 'STORE_ERROR',
			};
		}
	}

	/**
	 * Loads linked account for a Discord user.
	 */
	public async getLinkedAccount(discordUserId: DiscordUserId): Promise<GetLinkedAccountResult> {
		try {
			const polymarketAccountId = await this.store.getLinkedAccount(discordUserId);
			if (polymarketAccountId === null) {
				return {
					ok: false,
					errorCode: 'LINK_NOT_FOUND',
				};
			}

			return {
				ok: true,
				polymarketAccountId,
			};
		} catch {
			return {
				ok: false,
				errorCode: 'STORE_ERROR',
			};
		}
	}

	/**
	 * Removes linked account mapping for a Discord user.
	 *
	 * Existence is checked first so unlink can return deterministic LINK_NOT_FOUND.
	 */
	public async unlink(discordUserId: DiscordUserId): Promise<UnlinkResult> {
		try {
			const existing = await this.store.getLinkedAccount(discordUserId);
			if (existing === null) {
				return {
					ok: false,
					errorCode: 'LINK_NOT_FOUND',
				};
			}

			await this.store.unlink(discordUserId);
			return {
				ok: true,
				discordUserId,
			};
		} catch {
			return {
				ok: false,
				errorCode: 'STORE_ERROR',
			};
		}
	}
}

