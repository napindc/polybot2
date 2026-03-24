import type { DiscordUserId } from '../types';
import { getRedis } from './redisClient';

/**
 * Per-user daily spend limit in cents ($5.00).
 */
export const DAILY_LIMIT_CENTS = 500;

/**
 * Owner Discord user ID — exempt from daily spend limits.
 * Must be set via OWNER_DISCORD_ID env var. No hardcoded fallback (security).
 */
const OWNER_DISCORD_ID: string | undefined = process.env.OWNER_DISCORD_ID;

/**
 * Returns true if the given Discord user is the bot owner,
 * who is exempt from daily spend limits (for testing).
 * Returns false if OWNER_DISCORD_ID is not configured.
 */
export function isOwnerExempt(discordUserId: DiscordUserId): boolean {
	return OWNER_DISCORD_ID !== undefined && discordUserId === OWNER_DISCORD_ID;
}

/** Redis key prefix for spend tracking. */
const REDIS_PREFIX = 'polybot:spend';

/** TTL for Redis spend keys — 48 hours covers today + yesterday. */
const REDIS_TTL_SECONDS = 48 * 60 * 60;

/**
 * UTC date string used as the key for a daily spend bucket.
 * Format: "YYYY-MM-DD"
 */
function utcDateKey(): string {
	return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  In-memory fallback (used when REDIS_URL is not set)               */
/* ------------------------------------------------------------------ */

const spendLedger = new Map<DiscordUserId, Map<string, number>>();

function evictStaleEntries(userMap: Map<string, number>): void {
	const today = utcDateKey();
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	for (const key of userMap.keys()) {
		if (key !== today && key !== yesterday) {
			userMap.delete(key);
		}
	}
}

function memGetSpent(discordUserId: DiscordUserId): number {
	const dayKey = utcDateKey();
	const userMap = spendLedger.get(discordUserId);
	if (!userMap) return 0;
	evictStaleEntries(userMap);
	return userMap.get(dayKey) ?? 0;
}

function memRecordSpend(discordUserId: DiscordUserId, amountCents: number): void {
	const dayKey = utcDateKey();
	let userMap = spendLedger.get(discordUserId);
	if (!userMap) {
		userMap = new Map<string, number>();
		spendLedger.set(discordUserId, userMap);
	}
	const current = userMap.get(dayKey) ?? 0;
	userMap.set(dayKey, current + amountCents);
}

/* ------------------------------------------------------------------ */
/*  Redis-backed spend tracking                                       */
/* ------------------------------------------------------------------ */

function redisKey(discordUserId: DiscordUserId): string {
	return `${REDIS_PREFIX}:${discordUserId}:${utcDateKey()}`;
}

/**
 * Returns the cents the user has spent today.
 * Uses Redis when available, falls back to in-memory.
 */
export async function getSpentToday(discordUserId: DiscordUserId): Promise<number> {
	const redis = getRedis();
	if (!redis) return memGetSpent(discordUserId);

	const val = await redis.get(redisKey(discordUserId));
	return val ? parseInt(val, 10) : 0;
}

/**
 * Returns how many cents the user can still spend today.
 */
export async function getRemainingToday(discordUserId: DiscordUserId): Promise<number> {
	return Math.max(0, DAILY_LIMIT_CENTS - await getSpentToday(discordUserId));
}

/**
 * Returns true if the user can spend `amountCents` within today's limit.
 */
export async function canSpend(discordUserId: DiscordUserId, amountCents: number): Promise<boolean> {
	return (await getSpentToday(discordUserId)) + amountCents <= DAILY_LIMIT_CENTS;
}

/**
 * Records a confirmed spend for the user today.
 * Only call this after a trade has been successfully executed.
 */
export async function recordSpend(discordUserId: DiscordUserId, amountCents: number): Promise<void> {
	const redis = getRedis();
	if (!redis) {
		memRecordSpend(discordUserId, amountCents);
		return;
	}

	const key = redisKey(discordUserId);
	await redis.incrby(key, amountCents);
	await redis.expire(key, REDIS_TTL_SECONDS);
}

/**
 * Atomic check-and-record using a Redis Lua script.
 * Returns true and records the spend if within limit,
 * or returns false without recording if it would exceed the daily limit.
 *
 * Falls back to in-memory check-and-record when Redis is unavailable.
 */
const TRY_SPEND_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', key) or '0')
if current + amount > limit then
  return 0
end
redis.call('INCRBY', key, amount)
redis.call('EXPIRE', key, ttl)
return 1
`;

export async function trySpend(discordUserId: DiscordUserId, amountCents: number): Promise<boolean> {
	const redis = getRedis();
	if (!redis) {
		if (memGetSpent(discordUserId) + amountCents > DAILY_LIMIT_CENTS) return false;
		memRecordSpend(discordUserId, amountCents);
		return true;
	}

	const result = await redis.eval(
		TRY_SPEND_LUA,
		1,
		redisKey(discordUserId),
		String(amountCents),
		String(DAILY_LIMIT_CENTS),
		String(REDIS_TTL_SECONDS),
	);
	return result === 1;
}
