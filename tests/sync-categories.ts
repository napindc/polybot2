/**
 * Auto-sync Polymarket categories and subcategories from the Gamma API.
 *
 * This script:
 *  1. Fetches all tags from `/tags`
 *  2. Fetches the top-level navigation categories via `/events` with known tag slugs
 *  3. Discovers subcategories by examining tags on returned events
 *  4. Outputs a JSON mapping file used by integration tests and the bot itself
 *
 * Usage:   npx tsx tests/sync-categories.ts
 * Output:  tests/data/categories.json
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';

/**
 * Top-level categories visible on polymarket.com navigation bar.
 * These are the primary entry points users see.
 */
const TOP_LEVEL_CATEGORIES = [
	'politics', 'sports', 'crypto', 'finance',
	'geopolitics', 'tech', 'culture', 'world', 'economy',
] as const;

interface TagInfo {
	id: string;
	label: string;
	slug: string;
}

interface CategoryData {
	slug: string;
	label: string;
	eventCount: number;
	subcategories: TagInfo[];
	sampleMarkets: Array<{
		question: string;
		slug: string;
		volume: number;
		status: string;
	}>;
}

interface SyncOutput {
	syncedAt: string;
	allTags: TagInfo[];
	categories: Record<string, CategoryData>;
}

async function fetchJson<T>(url: string): Promise<T> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
	return resp.json() as Promise<T>;
}

async function syncCategories(): Promise<SyncOutput> {
	console.log('📡 Fetching all tags from /tags ...');
	const allTags = await fetchJson<TagInfo[]>(`${GAMMA_API}/tags`);
	console.log(`   Found ${allTags.length} tags`);

	const categories: Record<string, CategoryData> = {};

	for (const catSlug of TOP_LEVEL_CATEGORIES) {
		console.log(`\n🏷️  Syncing category: ${catSlug}`);
		const events = await fetchJson<Array<{
			title?: string;
			slug?: string;
			tags?: TagInfo[];
			markets?: Array<{
				question?: string;
				slug?: string;
				volume?: string | number;
				active?: boolean;
				closed?: boolean;
			}>;
		}>>(`${GAMMA_API}/events?closed=false&tag_slug=${catSlug}&order=volume24hr&ascending=false&limit=50`);

		console.log(`   ${events.length} events`);

		// Collect all sub-tags seen across events in this category
		const subTagMap = new Map<string, TagInfo>();
		const sampleMarkets: CategoryData['sampleMarkets'] = [];

		for (const event of events) {
			if (event.tags) {
				for (const tag of event.tags) {
					// Skip the category itself and generic meta tags
					if (tag.slug === catSlug) continue;
					if (['hide-from-new', 'earn-4', 'featured', 'recurring', 'neg-risk'].includes(tag.slug)) continue;
					if (!subTagMap.has(tag.slug)) {
						subTagMap.set(tag.slug, { id: String(tag.id), label: tag.label, slug: tag.slug });
					}
				}
			}

			// Collect top sample markets for verification
			if (event.markets && sampleMarkets.length < 10) {
				for (const m of event.markets.slice(0, 2)) {
					if (sampleMarkets.length >= 10) break;
					const vol = typeof m.volume === 'number' ? m.volume : parseFloat(String(m.volume ?? '0'));
					sampleMarkets.push({
						question: m.question ?? event.title ?? '',
						slug: m.slug ?? '',
						volume: vol,
						status: m.closed ? 'closed' : m.active !== false ? 'active' : 'paused',
					});
				}
			}
		}

		// Find the tag label for this category
		const catTag = allTags.find(t => t.slug === catSlug);

		categories[catSlug] = {
			slug: catSlug,
			label: catTag?.label ?? catSlug,
			eventCount: events.length,
			subcategories: [...subTagMap.values()].sort((a, b) => a.label.localeCompare(b.label)),
			sampleMarkets,
		};

		console.log(`   ${subTagMap.size} subcategories, ${sampleMarkets.length} sample markets`);
	}

	// Also sync the /sports endpoint for sports subcategories
	console.log('\n⚽ Syncing sports metadata from /sports ...');
	try {
		const sports = await fetchJson<Array<{
			id: number;
			sport: string;
			tags: string;
			series: string;
		}>>(`${GAMMA_API}/sports`);
		console.log(`   ${sports.length} sport entries`);

		// Add sports as subcategories under 'sports' if not already there
		if (categories['sports']) {
			for (const s of sports) {
				const slug = s.sport.toLowerCase();
				if (!categories['sports'].subcategories.find(t => t.slug === slug)) {
					categories['sports'].subcategories.push({
						id: String(s.id),
						label: s.sport.toUpperCase(),
						slug,
					});
				}
			}
		}
	} catch (err) {
		console.log(`   ⚠️  Failed to fetch sports: ${err}`);
	}

	return {
		syncedAt: new Date().toISOString(),
		allTags,
		categories,
	};
}

// ── Main ──

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

async function main() {
	const output = await syncCategories();

	const outDir = join(import.meta.dirname ?? __dirname, 'data');
	mkdirSync(outDir, { recursive: true });

	const outPath = join(outDir, 'categories.json');
	writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
	console.log(`\n✅ Wrote ${outPath}`);

	// Print summary
	console.log('\n═══ Summary ═══');
	for (const [slug, cat] of Object.entries(output.categories)) {
		console.log(`  ${slug}: ${cat.eventCount} events, ${cat.subcategories.length} subcategories`);
	}
	console.log(`  Total tags: ${output.allTags.length}`);
}

main().catch(err => {
	console.error('❌ Sync failed:', err);
	process.exit(1);
});
