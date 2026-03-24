import Redis from 'ioredis';

/**
 * Singleton Redis client for PolyBot persistence.
 *
 * Reads REDIS_URL from environment. If not set, exports null
 * and consumers fall back to in-memory storage.
 */

let redis: Redis | null = null;
let redisDisabledForSession = false;

function isTransientRedisNetworkError(err: unknown): boolean {
	const value = err as { code?: string; message?: string } | undefined;
	const code = value?.code ?? '';
	const msg = (value?.message ?? '').toLowerCase();
	return (
		['EACCES', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(code) ||
		msg.includes('eacces') ||
		msg.includes('econnreset') ||
		msg.includes('timeout') ||
		msg.includes('connect')
	);
}

function disableRedisForSession(reason: unknown): void {
	if (redisDisabledForSession) return;
	redisDisabledForSession = true;
	if (redis) {
		redis.disconnect(false);
		redis = null;
	}
	const message = reason instanceof Error ? reason.message : String(reason);
	console.warn(`⚠️  Redis disabled for this process; using in-memory storage. Reason: ${message}`);
}

export function getRedis(): Redis | null {
	if (redis) return redis;
	if (redisDisabledForSession) return null;

	const url = process.env.REDIS_URL;
	if (!url) {
		console.log('⚠️  REDIS_URL not set — using in-memory storage (data lost on restart)');
		return null;
	}

	try {
		redis = new Redis(url, {
			maxRetriesPerRequest: 1,
			retryStrategy(times) {
				if (times > 2) return null; // fail fast and fall back to in-memory
				return Math.min(times * 200, 2000);
			},
			// Connect eagerly to avoid first-command race conditions where callers
			// issue Redis operations before the socket is writable.
			lazyConnect: false,
			// Queue early commands briefly during initial connect instead of failing
			// immediately with "Stream isn't writeable".
			enableOfflineQueue: true,
			connectTimeout: 5000,
		});

		redis.on('connect', () => console.log('🟢 Redis connected'));
		redis.on('error', (err) => {
			console.error('🔴 Redis error:', err.message);
			if (isTransientRedisNetworkError(err)) {
				disableRedisForSession(err);
			}
		});

		return redis;
	} catch (err) {
		console.error('🔴 Failed to create Redis client:', err);
		return null;
	}
}

/**
 * Cache-or-fetch pattern: tries Redis first, falls back to fetcher.
 * Stores result in Redis with the given TTL (in seconds).
 * If Redis is unavailable, always calls the fetcher directly.
 */
export async function getOrFetch<T>(
	key: string,
	fetcher: () => Promise<T>,
	ttlSeconds: number = 30,
): Promise<T> {
	const r = getRedis();
	if (r) {
		try {
			const cached = await r.get(key);
			if (cached) {
				console.log(`[cache] hit: ${key}`);
				return JSON.parse(cached) as T;
			}
		} catch {
			// Redis read failed — fall through to fetcher
		}
	}

	const data = await fetcher();

	// Store in cache (non-blocking, best-effort)
	if (r) {
		r.setex(key, ttlSeconds, JSON.stringify(data)).catch(() => { });
	}

	return data;
}

/**
 * Invalidate all keys matching a glob pattern.
 */
export async function invalidateCache(pattern: string): Promise<void> {
	const r = getRedis();
	if (!r) return;

	try {
		const stream = r.scanStream({ match: pattern, count: 100 });
		const keys: string[] = [];
		stream.on('data', (batch: string[]) => keys.push(...batch));
		await new Promise<void>((resolve) => stream.on('end', resolve));
		if (keys.length > 0) await r.del(...keys);
	} catch {
		// best-effort
	}
}
