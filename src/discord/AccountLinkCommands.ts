import { AccountLinkChallengeService } from '../auth/AccountLinkChallengeService';
import { AccountLinkPersistenceService } from '../auth/AccountLinkPersistenceService';
import {
	AccountLinkVerificationService,
	buildSignedLinkMessage,
} from '../auth/AccountLinkVerificationService';
import type { DiscordUserId, PolymarketAccountId } from '../types';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChatInputCommandInteraction,
	SlashCommandBuilder,
} from 'discord.js';
import { sessions } from '../server/authServer';
import crypto from 'crypto';
import type { Trader } from '../types';

export interface AccountLinkCommandDependencies {
	readonly challengeService: AccountLinkChallengeService;
	readonly verificationService: AccountLinkVerificationService;
	readonly persistenceService: AccountLinkPersistenceService;
	readonly trader: Trader;
	readonly nowMs: () => number;
}

/**
 * Handles plain-text account-link commands from Discord.
 *
 * This layer is orchestration + presentation only:
 * - Calls backend auth services.
 * - Returns user-facing strings.
 * - Does not implement crypto, validation, or persistence logic itself.
 */
export async function handleAccountLinkCommand(
	message: string,
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	try {
		const trimmed = message.trim();

		if (/^connect\s+account$/i.test(trimmed)) {
			return handleConnectAccount(discordUserId, deps);
		}

		const verifyMatch = trimmed.match(/^verify\s+(\S+)\s+(\S+)\s+(.+)$/i);
		if (verifyMatch) {
			const polymarketAccountId = verifyMatch[1] as PolymarketAccountId;
			const nonce = verifyMatch[2];
			const signature = verifyMatch[3];
			return handleVerify(discordUserId, polymarketAccountId, nonce, signature, deps);
		}

		if (/^disconnect$/i.test(trimmed)) {
			return handleDisconnect(discordUserId, deps);
		}

		return [
			'Supported commands:',
			'- connect account',
			'- verify <polymarketAccountId> <nonce> <signature>',
			'- disconnect',
		].join('\n');
	} catch {
		return 'Unable to process account-link command right now. Please try again.';
	}
}

async function handleConnectAccount(
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const issued = await deps.challengeService.issueChallenge(discordUserId, deps.nowMs());
	if (!issued.ok) {
		return 'Could not start account connection right now. Please try again.';
	}

	const challengeMessage = buildSignedLinkMessage(issued.challenge);

	return [
		'Sign the exact message below with your wallet using personal_sign, then submit:',
		`verify <polymarketAccountId> ${issued.challenge.nonce} <signature>`,
		'',
		challengeMessage,
	].join('\n');
}

async function handleVerify(
	discordUserId: DiscordUserId,
	polymarketAccountId: PolymarketAccountId,
	nonce: string,
	signature: string,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const verification = await deps.verificationService.verifyLink(
		discordUserId,
		nonce,
		polymarketAccountId,
		signature,
		deps.nowMs(),
	);

	if (!verification.ok) {
		if (verification.errorCode === 'CHALLENGE_INVALID') {
			return 'Challenge is invalid or expired. Please run "connect account" again.';
		}

		return 'Signature verification failed. Please ensure you signed the exact challenge message.';
	}

	const persisted = await deps.persistenceService.persistLink(
		discordUserId,
		polymarketAccountId,
		deps.nowMs(),
	);
	if (!persisted.ok) {
		return 'Account verified, but linking could not be saved right now. Please try again.';
	}

	return 'Your Polymarket account is now connected successfully.';
}

async function handleDisconnect(
	discordUserId: DiscordUserId,
	deps: AccountLinkCommandDependencies,
): Promise<string> {
	const result = await deps.persistenceService.unlink(discordUserId);
	if (!result.ok) {
		if (result.errorCode === 'LINK_NOT_FOUND') {
			return 'No linked Polymarket account was found for your Discord user.';
		}

		return 'Could not disconnect your account right now. Please try again.';
	}

	return 'Your Polymarket account has been disconnected.';
}

export async function handleAccountLinkSlashCommand(
	interaction: ChatInputCommandInteraction,
	deps: AccountLinkCommandDependencies,
): Promise<void> {
	try {
		if (!interaction.deferred && !interaction.replied) {
			await interaction.deferReply({ ephemeral: true });
		}

		const respond = async (content: string): Promise<void> => {
			if (interaction.deferred) {
				await interaction.editReply(content);
				return;
			}
			if (interaction.replied) {
				await interaction.followUp({ content, ephemeral: true });
				return;
			}
			await interaction.reply({ content, ephemeral: true });
		};

		const discordUserId = interaction.user.id as DiscordUserId;
		switch (interaction.commandName) {
			case 'connect': {
				// Create a session for the web-based wallet link flow
				const sessionId = crypto.randomUUID();
				const nonce = crypto.randomUUID();
				const expiresAtMs = Date.now() + 10 * 60 * 1000;

				const challengeMessage = [
					'PolyBot Wallet Link',
					`Discord User: ${discordUserId}`,
					`Nonce: ${nonce}`,
					`Expires: ${new Date(expiresAtMs).toISOString()}`,
				].join('\n');

				sessions.set(sessionId, {
					sessionId,
					discordUserId,
					nonce,
					challengeMessage,
					expiresAtMs,
					used: false,
				});

				const authUrl = `${process.env.AUTH_BASE_URL || 'http://localhost:3001'}/connect?session=${sessionId}`;

				const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
					new ButtonBuilder()
						.setLabel('🔗 Connect Wallet')
						.setStyle(ButtonStyle.Link)
						.setURL(authUrl),
				);

				if (interaction.deferred) {
					await interaction.editReply({
						content: 'Click the button below to connect your Polymarket wallet.\nThe link expires in 10 minutes.',
						components: [row],
					});
				} else {
					await interaction.reply({
						content: 'Click the button below to connect your Polymarket wallet.\nThe link expires in 10 minutes.',
						components: [row],
						ephemeral: true,
					});
				}
				break;
			}
			case 'verify': {
				const polymarketAccountId = interaction.options
					.getString('polymarket_account_id', true) as PolymarketAccountId;
				const nonce = interaction.options.getString('nonce', true);
				const signature = interaction.options.getString('signature', true);
				const response = await handleVerify(
					discordUserId,
					polymarketAccountId,
					nonce,
					signature,
					deps,
				);
				await respond(response);
				break;
			}
			case 'disconnect': {
				const response = await handleDisconnect(discordUserId, deps);
				await respond(response);
				break;
			}
			case 'status': {
				const linked = await deps.persistenceService.getLinkedAccount(discordUserId);
				const addr = linked.ok ? linked.polymarketAccountId : (process.env.POLYMARKET_PROXY_WALLET ?? null);
				if (!addr) {
					await respond('❌ No trading wallet configured. Please contact an admin.');
				} else {
					const short = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
					await respond(
						`✅ **Trading Wallet**\n` +
						`Address: \`${short}\`\n\n` +
						`[View on Polygonscan](https://polygonscan.com/address/${addr})`,
					);
				}
				break;
			}
			case 'balance': {
				const linked = await deps.persistenceService.getLinkedAccount(discordUserId);
				const balanceAddr = linked.ok ? linked.polymarketAccountId : (process.env.POLYMARKET_PROXY_WALLET ?? null);
				if (!balanceAddr) {
					await respond('❌ No trading wallet configured. Please contact an admin.');
					break;
				}

				const balance = await deps.trader.getBalance(discordUserId);
				const cashDollars = (balance.availableCents / 100).toFixed(2);
				const linkedAddress = balanceAddr;

				let publicPositionValueDollars = '0.00';
				try {
					const valueResp = await fetch(
						`https://data-api.polymarket.com/value?user=${encodeURIComponent(linkedAddress)}`,
					);
					if (valueResp.ok) {
						const valueRows = (await valueResp.json()) as Array<{ value?: number }>;
						const usdValue = valueRows?.[0]?.value ?? 0;
						publicPositionValueDollars = usdValue.toFixed(2);
					}
				} catch {
					publicPositionValueDollars = '0.00';
				}

				let openPositionsCount = 0;
				try {
					const positionsResp = await fetch(
						`https://data-api.polymarket.com/positions?user=${encodeURIComponent(linkedAddress)}&sizeThreshold=.1`,
					);
					if (positionsResp.ok) {
						const positions = (await positionsResp.json()) as unknown[];
						openPositionsCount = Array.isArray(positions) ? positions.length : 0;
					}
				} catch {
					openPositionsCount = 0;
				}

				await respond(
					`💰 **Your Balance**\n` +
					`Wallet: \`${linkedAddress}\`\n` +
					`Cash (USDC, on-chain): **$${cashDollars}**\n` +
					`Position value (public): **$${publicPositionValueDollars}**\n` +
					`Open positions: **${openPositionsCount}**\n\n` +
					`Note: App numbers can differ slightly due to indexing delays and account-state timing.`,
				);
				break;
			}
			default:
				await respond('Unsupported command.');
		}
	} catch (error) {
		console.error('handleAccountLinkSlashCommand failed:', error);
		if (interaction.deferred) {
			await interaction.editReply('Unable to process account-link command right now. Please try again.');
			return;
		}
		if (!interaction.replied) {
			await interaction.reply({
				content: 'Unable to process account-link command right now. Please try again.',
				ephemeral: true,
			});
			return;
		}
		await interaction.followUp({
			content: 'Unable to process account-link command right now. Please try again.',
			ephemeral: true,
		});
	}
}

export const connectCommand = new SlashCommandBuilder()
	.setName('connect')
	.setDescription('Connect your Polymarket account');

export const verifyCommand = new SlashCommandBuilder()
	.setName('verify')
	.setDescription('Verify your Polymarket account')
	.addStringOption(option =>
		option.setName('polymarket_account_id')
			.setDescription('Your Polymarket account ID')
			.setRequired(true))
	.addStringOption(option =>
		option.setName('nonce')
			.setDescription('The nonce provided by the bot')
			.setRequired(true))
	.addStringOption(option =>
		option.setName('signature')
			.setDescription('The signature from your wallet')
			.setRequired(true));

export const disconnectCommand = new SlashCommandBuilder()
	.setName('disconnect')
	.setDescription('Disconnect your Polymarket account');

export const statusCommand = new SlashCommandBuilder()
	.setName('status')
	.setDescription('Show your linked Polymarket wallet address');

export const balanceCommand = new SlashCommandBuilder()
	.setName('balance')
	.setDescription('Show your current balance');

export const commands = [statusCommand, balanceCommand];

