import { AccountLinkPersistenceService } from '../auth/AccountLinkPersistenceService';
import { PolymarketReadService } from '../read/PolymarketReadService';
import type { DiscordUserId } from '../types';
import type { ValidationContext } from './validateAgentOutput';
import { getRemainingToday, getSpentToday, isOwnerExempt, DAILY_LIMIT_CENTS } from '../storage/limits';

/**
 * Dependencies required to construct ValidationContext from read-only sources.
 */
export interface BuildValidationContextDependencies {
	readonly accountLinkPersistenceService: AccountLinkPersistenceService;
	readonly polymarketReadService: PolymarketReadService;
}

/**
 * Convenience factory that returns the exact function signature expected by
 * orchestration layers: (discordUserId) => Promise<ValidationContext>.
 */
export function createBuildValidationContext(
	deps: BuildValidationContextDependencies,
): (discordUserId: DiscordUserId) => Promise<ValidationContext> {
	return async (discordUserId: DiscordUserId): Promise<ValidationContext> =>
		buildValidationContext(discordUserId, deps);
}

/**
 * Builds ValidationContext for deterministic write-path validation.
 *
 * Source-of-truth rationale:
 * - Account linkage is read only from AccountLinkPersistenceService.
 * - This is the single construction point for ValidationContext inputs.
 * - Validators consume the produced context without performing their own reads.
 */
export async function buildValidationContext(
	discordUserId: DiscordUserId,
	deps: BuildValidationContextDependencies,
): Promise<ValidationContext> {
	const linkedAccountResult = await deps.accountLinkPersistenceService.getLinkedAccount(discordUserId);

	/**
	 * If the user has no linked account, fall back to the leader's proxy wallet
	 * so all Discord users can trade without needing to /connect.
	 */
	const linkedId = linkedAccountResult.ok ? linkedAccountResult.polymarketAccountId : null;
	const leaderWallet = (process.env.POLYMARKET_PROXY_WALLET ?? null) as import('../types').PolymarketAccountId | null;
	const polymarketAccountId = linkedId ?? leaderWallet;

	/**
	 * ValidationContext currently requires a synchronous marketLookup function.
	 * To preserve that contract, we build a read-only market status snapshot first
	 * using PolymarketReadService and then expose a pure in-memory lookup.
	 */
	const marketStatusIndex = await buildMarketStatusIndex(deps.polymarketReadService);

	// Wire real spend tracking (owner gets full limit, others get actual remaining)
	const remainingDailyLimitCents = isOwnerExempt(discordUserId)
		? DAILY_LIMIT_CENTS
		: await getRemainingToday(discordUserId);
	const spentThisHourCents = isOwnerExempt(discordUserId)
		? 0
		: await getSpentToday(discordUserId);

	return {
		polymarketAccountId,
		remainingDailyLimitCents,
		spentThisHourCents,
		marketLookup: (marketId: string) => marketStatusIndex.get(marketId) ?? null,
	};
}

type MarketStatusProjection = { id: string; status: 'active' | 'closed' | 'paused' };

async function buildMarketStatusIndex(
	polymarketReadService: PolymarketReadService,
): Promise<Map<string, MarketStatusProjection>> {
	try {
		const markets = await polymarketReadService.searchMarketsByText('');
		const index = new Map<string, MarketStatusProjection>();
		for (const market of markets) {
			index.set(market.id, {
				id: market.id,
				status: market.status,
			});
		}

		return index;
	} catch {
		return new Map<string, MarketStatusProjection>();
	}
}

