import { callAI as callGemini, hasAIKeys as hasGeminiKeys, sanitize } from './aiClient';
import type { ReadExplainerInput } from '../discord/DiscordMessageRouter';

/**
 * System prompt for the READ-mode AI assistant.
 */
export const READ_SYSTEM_PROMPT = [
	'You are a helpful Polymarket assistant inside a Discord server.',
	'You answer user questions about prediction markets, odds, market status, and general Polymarket concepts.',
	'You are given factual market data as context — use it when relevant.',
	'Be concise, accurate, and conversational. Keep responses under 300 words.',
	'You have NO ability to execute trades, access wallets, or modify anything.',
	'If the user asks you to place a trade or wants to bet, show them the correct command format based on the market type:',
	'  • For sports/esports matchups: \"bet $[amount] on [team A] vs [team B] on [team you want to bet on]\" — e.g. \"bet $5 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers\" or \"bet $5 on Missouri Tigers vs Miami Hurricanes on Miami Hurricanes\".',
	'  • For other markets (politics, crypto, etc.): \"bet $[amount] on [market description] yes\" or \"bet $[amount] on [market description] no\".',
	'IMPORTANT: For sports matchups, ALWAYS show two separate example commands with the actual team names from the market data, and include both the matchup and selected team. Example: \"To bet, type: **bet $5 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers** or **bet $5 on Missouri Tigers vs Miami Hurricanes on Miami Hurricanes**\". NEVER use [outcome] placeholders — always fill in the real team names.',
	'Never fabricate market data.',
	'IMPORTANT: For sports/esports queries (teams, players, matches), the search returns the top active markets from that league or sport.',
	'RULE: If sample markets are provided (even just 1), you MUST present them clearly as what is available. NEVER say "could not find" or "could not find" when markets are shown - that is confusing and wrong.',
	'RULE: Only say you could not find a market if search matches = 0 AND no sample markets are listed at all.',
	'If the found market question uses different phrasing or abbreviations than the user query (e.g. user says "G2 Ares vs WW Team" but market says "Will G2 win on 2026-03-03"), present the market anyway - it is the closest Polymarket has for that matchup.',
	'Do NOT fabricate results or show random unrelated markets when there are no search matches.',
	'Format responses for Discord (markdown is OK, no HTML).',
	'IMPORTANT: Whenever you include any links in your response, surround them with angle brackets like <https://example.com> to suppress Discord embeds.',
	'Do NOT include any Olympus or Polymarket links in your response — they are appended automatically after your answer.',
].join(' ');

/**
 * Creates an AI-powered read explainer using OpenAI (primary) with Gemini fallback.
 * No backend, no database, no auth required.
 */
export function createAiReadExplainer(): (input: ReadExplainerInput) => Promise<string> {
	return async (input: ReadExplainerInput): Promise<string> => {
		if (input.sampleMarketSummaries.length > 0) {
			const deterministic = buildDeterministicMarketBrief(input);
			const olympusLinks = buildOlympusLinks(input);
			return olympusLinks ? `${deterministic}\n\n${olympusLinks}` : deterministic;
		}

		if (!hasGeminiKeys()) {
			return fallbackExplainer(input);
		}

		const contextBlock = buildMarketContext(input);
		const fullPrompt = READ_SYSTEM_PROMPT + '\n\nCurrent market context:\n' + contextBlock;

		const text = await callGemini({
			contents: sanitize(input.message, 500),
			systemInstruction: fullPrompt,
			temperature: 0.4,
			maxOutputTokens: 500,
		});

		if (!text) {
			return fallbackExplainer(input);
		}

		// Append Olympus links deterministically — don't rely on AI to include them
		const olympusLinks = buildOlympusLinks(input);
		return olympusLinks ? `${text}\n\n${olympusLinks}` : text;
	};
}

function toPercent(value: number | undefined): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.round((value as number) * 100);
}

function formatVolume(value: number): string {
	if (!Number.isFinite(value)) {
		return '$0';
	}
	if (value >= 1_000_000) {
		return `$${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `$${(value / 1_000).toFixed(0)}K`;
	}
	return `$${Math.round(value)}`;
}

function buildDeterministicMarketBrief(input: ReadExplainerInput): string {
	const top = input.sampleMarketSummaries[0];
	if (!top) {
		return fallbackExplainer(input);
	}

	const firstOutcome = top.outcomes[0] ?? 'YES';
	const secondOutcome = top.outcomes[1] ?? 'NO';
	const firstPct = toPercent(top.outcomePrices[0]);
	const secondPct = toPercent(top.outcomePrices[1]);
	const spread = Math.abs(firstPct - secondPct);
	const leader = firstPct >= secondPct ? firstOutcome : secondOutcome;
	const status = top.status === 'active' ? 'Active' : top.status;
	const volume = formatVolume(top.volume);

	const isMatchup = /\bvs\b|\bversus\b/i.test(input.message)
		|| /\bvs\b|\bversus\b/i.test(top.question)
		|| top.outcomes.length === 2;

	const parts: string[] = [];
	parts.push(`Market brief for your query:`);
	parts.push(`- Status: **${status}**`);
	parts.push(`- Current odds: **${firstOutcome} ${firstPct}%** vs **${secondOutcome} ${secondPct}%**`);
	parts.push(`- Lean: **${leader}** by **${spread} pts**`);
	parts.push(`- Volume: **${volume}**`);

	if (isMatchup) {
		parts.push('');
		parts.push('To place a bet on this market:');
		parts.push(`- **bet $5 on ${firstOutcome} vs ${secondOutcome} on ${firstOutcome}**`);
		parts.push(`- **bet $5 on ${firstOutcome} vs ${secondOutcome} on ${secondOutcome}**`);
	} else {
		parts.push('');
		parts.push('To place a bet on this market:');
		parts.push(`- **bet $5 on ${top.question} yes**`);
		parts.push(`- **bet $5 on ${top.question} no**`);
	}

	return parts.join('\n');
}

/**
 * Builds a compact market-context string for the system prompt.
 * Keeps token usage low while giving the model enough to be useful.
 */
function buildMarketContext(input: ReadExplainerInput): string {
	const lines: string[] = [];

	lines.push(`Live markets: ${input.liveMarketCount}`);
	lines.push(`Search matches for user query: ${input.searchResultsCount}`);

	if (input.sampleMarketSummaries.length > 0) {
		lines.push('');
		lines.push('Sample markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => `${o}: ${Math.round((summary.outcomePrices[i] ?? 0) * 100)}%`).join(', ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			const olympusLink = '';
			lines.push(`- [${summary.status}] "${summary.question}" (${priceInfo}) vol=${vol}${olympusLink}`);
		}
	}

	return lines.join('\n');
}

/**
 * Graceful fallback when Gemini is unavailable or rate-limited.
 * Returns basic factual data without AI generation.
 */
function fallbackExplainer(input: ReadExplainerInput): string {
	const parts: string[] = [];

	parts.push(`I found **${input.liveMarketCount}** live markets`);
	if (input.searchResultsCount > 0) {
		parts.push(` and **${input.searchResultsCount}** matching your query`);
	}
	parts.push('.');

	if (input.sampleMarketSummaries.length > 0) {
		parts.push('\n\nHere are some markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => {
				const pct = Math.round((summary.outcomePrices[i] ?? 0) * 100);
				return `${o}: ${pct}%`;
			}).join(' / ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			parts.push(`\n• **${summary.question}** — ${priceInfo} (Vol: ${vol})`);
		}
	}

	// Append Olympus links deterministically
	const olympusLinks = buildOlympusLinks(input);
	if (olympusLinks) {
		parts.push(`\n\n${olympusLinks}`);
	}

	return parts.join('');
}

/**
 * Builds Olympus links block appended after AI or fallback responses.
 * Guarantees links are always present regardless of AI token limits.
 */
function buildOlympusLinks(input: ReadExplainerInput): string {
	const links: string[] = [];
	const queryTerms = input.message
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 4 && !new Set(['tell', 'about', 'what', 'show', 'market', 'odds', 'game', 'markets']).has(w));

	for (const summary of input.sampleMarketSummaries) {
		const hay = `${summary.question} ${summary.slug ?? ''} ${summary.eventSlug ?? ''}`
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ');
		const overlap = queryTerms.filter((t) => hay.includes(t)).length;
		if (queryTerms.length > 0 && overlap < Math.min(2, queryTerms.length)) {
			continue;
		}

		// Prefer the parent event slug (e.g. lol-jdg-blg-2026-03-04) — that is the
		// correct Olympus URL path. The market-level slug is an internal Gamma ID
		// that does not match the Olympus/Polymarket URL.
		const linkSlug = summary.eventSlug ?? summary.slug;
		if (linkSlug) {
			// Use angle brackets to suppress Discord embeds
			links.push(`<https://olympusx.app/app/market/${linkSlug}>`);
		}
	}
	return links.length > 0 ? `View on Olympus:\n${links.join('\n')}` : '';
}
