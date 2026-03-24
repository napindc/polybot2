import { describe, expect, it } from 'vitest';
import { DiscordMessageRouter } from '../../src/discord/DiscordMessageRouter';
import type { DiscordMessageRouterDependencies } from '../../src/discord/DiscordMessageRouter';
import type { Market } from '../../src/types';

function depsForTest(market: Market): DiscordMessageRouterDependencies {
	return {
		readService: {
			searchMarketsByText: async () => [market],
			searchMarketsByTextWithLimit: async () => [market],
			getMarketById: async () => market,
			summarizeMarket: async () => null,
			getLiveMarketCount: async () => 1,
			getMarket: async () => market,
		} as any,
		trader: {
			placeTrade: async () => ({ ok: true, tradeId: 't1', executedAtMs: Date.now() }),
			getRecentTrades: async () => [],
		} as any,
		buildValidationContext: async () => ({
			polymarketAccountId: '0xabc' as any,
			remainingDailyLimitCents: 10000,
			spentThisHourCents: 0,
			marketLookup: () => ({ id: market.id, status: 'active' as const }),
		}),
		nowMs: () => Date.now(),
	};
}

describe('sports unresolved outcome guidance', () => {
	it('suggests team-based completion when command has matchup but no selected side', async () => {
		const market: Market = {
			id: 'm1' as any,
			question: 'Missouri Tigers vs Miami Hurricanes',
			outcomes: ['YES', 'NO'],
			outcomePrices: [0.46, 0.55],
			status: 'active',
			volume: 1000,
		};

		const router = new DiscordMessageRouter(depsForTest(market));
		const result = await router.routeMessage('bet $2 on Missouri Tigers vs Miami Hurricanes', 'u1' as any);

		expect(result.type).toBe('text');
		if (result.type === 'text') {
			expect(result.content).toContain('I found the matchup, but I still need which side you want.');
			expect(result.content).toContain('bet $2 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers');
			expect(result.content).toContain('bet $2 on Missouri Tigers vs Miami Hurricanes on Miami Hurricanes');
		}
	});

	it('prefers exact matchup market over unrelated market sharing mascot words', async () => {
		const wrongMarket = {
			id: 'm-wrong' as any,
			question: 'Detroit Tigers vs Philadelphia Phillies',
			outcomes: ['DETROIT TIGERS', 'PHILADELPHIA PHILLIES'],
			outcomePrices: [0.4, 0.6],
			status: 'active',
			volume: 1000,
		} as unknown as Market;
		const rightMarket = {
			id: 'm-right' as any,
			question: 'Missouri Tigers vs Miami Hurricanes',
			outcomes: ['MISSOURI TIGERS', 'MIAMI HURRICANES'],
			outcomePrices: [0.46, 0.55],
			status: 'active',
			volume: 1500,
		} as unknown as Market;

		const deps = depsForTest(rightMarket);
		(deps.readService.searchMarketsByText as any) = async () => [wrongMarket, rightMarket];

		const router = new DiscordMessageRouter(deps);
		const result = await router.routeMessage(
			'bet $2 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers',
			'u1' as any,
		);

		expect(result.type).toBe('confirm');
		if (result.type === 'confirm') {
			expect(result.marketQuestion).toBe('Missouri Tigers vs Miami Hurricanes');
			expect(result.outcomeLabel).toBe('MISSOURI TIGERS');
		}
	});

	it('maps selected team to YES/NO when matched sports market is binary', async () => {
		const binaryMarket = {
			id: 'm-binary' as any,
			question: 'Missouri Tigers vs Miami Hurricanes',
			outcomes: ['YES', 'NO'],
			outcomePrices: [0.46, 0.55],
			status: 'active',
			volume: 1500,
		} as unknown as Market;

		const router = new DiscordMessageRouter(depsForTest(binaryMarket));
		const result = await router.routeMessage(
			'bet $2 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers',
			'u1' as any,
		);

		expect(result.type).toBe('confirm');
		if (result.type === 'confirm') {
			expect(result.marketQuestion).toBe('Missouri Tigers vs Miami Hurricanes');
			expect(result.outcome).toBe('YES');
		}
	});
});
