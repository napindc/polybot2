import {
  AccountLinkChallengeService,
  type AccountLinkChallenge,
  type AccountLinkChallengeStore,
} from './auth/AccountLinkChallengeService';
import {
  AccountLinkPersistenceService,
  type AccountLinkStore,
} from './auth/AccountLinkPersistenceService';
import { AccountLinkVerificationService } from './auth/AccountLinkVerificationService';
import { EvmSignatureVerifier } from './auth/EvmSignatureVerifier';
import { PolymarketReadService, type PolymarketReadProvider } from './read/PolymarketReadService';
import { PolymarketApiReadProvider } from './read/PolymarketApiReadProvider';
import { ActiveMarketIndex } from './read/ActiveMarketIndex';
import { createAiReadExplainer } from './read/aiReadExplainer';
import {
  UserAccountTrader,
  type PolymarketExecutionGateway,
  type ExecuteTradeParams,
  type ExecuteTradeResponse,
} from './trading/UserAccountTrader';

import type { Balance, DiscordUserId, Market, PolymarketAccountId, TradeResult } from './types';
import { ClobClient, Chain, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet as EthersV5Wallet } from '@ethersproject/wallet';

const CLOB_ERROR_PREFIX = '[CLOB Client] request error';
let clobErrorRedactorInstalled = false;

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactSensitiveLogText(input: string, maxLen = 500): string {
  const maskedFields = input
    .replace(/"(POLY_API_KEY|POLY_API_SECRET|POLY_PASSPHRASE|POLY_SIGNATURE|WALLET_PRIVATE_KEY|BOT_API_SECRET|authorization|x-bot-secret)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/\b(POLY_API_KEY|POLY_API_SECRET|POLYMARKET_API_KEY|POLYMARKET_API_SECRET|POLYMARKET_PASSPHRASE|WALLET_PRIVATE_KEY|OPENAI_API_KEY|GEMINI_API_KEY(?:_\d+)?|BOT_API_SECRET)\s*=\s*[^\s\",]+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[a-zA-Z0-9_\-]{10,})\b/g, '[REDACTED]');

  return maskedFields.length > maxLen ? `${maskedFields.slice(0, maxLen)}...` : maskedFields;
}

function sanitizeErrorForLog(error: unknown, maxLen = 500): string {
  if (error instanceof Error) {
    return redactSensitiveLogText(error.message || error.name, maxLen);
  }
  return redactSensitiveLogText(safeStringify(error), maxLen);
}

function isClobAuthErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('invalid signature')
    || normalized.includes('unauthorized/invalid api key')
    || normalized.includes('invalid api key')
    || normalized.includes('http 401')
  );
}

function parseClobSignatureType(rawValue: string | undefined): SignatureType {
  const normalized = (rawValue ?? '').trim().toLowerCase();
  if (!normalized) {
    // Most Polymarket trading setups use a proxy wallet signer model.
    return SignatureType.POLY_PROXY;
  }

  if (normalized === '0' || normalized === 'eoa') {
    return SignatureType.EOA;
  }
  if (normalized === '1' || normalized === 'poly_proxy' || normalized === 'proxy') {
    return SignatureType.POLY_PROXY;
  }
  if (normalized === '2' || normalized === 'poly_gnosis_safe' || normalized === 'gnosis' || normalized === 'safe') {
    return SignatureType.POLY_GNOSIS_SAFE;
  }

  console.warn(`⚠️ Unknown POLYMARKET_SIGNATURE_TYPE="${rawValue}"; defaulting to POLY_PROXY`);
  return SignatureType.POLY_PROXY;
}

function clobSignatureTypeLabel(signatureType: SignatureType): string {
  switch (signatureType) {
    case SignatureType.EOA:
      return 'EOA';
    case SignatureType.POLY_PROXY:
      return 'POLY_PROXY';
    case SignatureType.POLY_GNOSIS_SAFE:
      return 'POLY_GNOSIS_SAFE';
    default:
      return String(signatureType);
  }
}

function installClobErrorRedactor(): void {
  if (clobErrorRedactorInstalled) return;
  clobErrorRedactorInstalled = true;

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    if (args.length > 0 && typeof args[0] === 'string' && args[0].includes(CLOB_ERROR_PREFIX)) {
      const sanitized = args.map((arg) => redactSensitiveLogText(safeStringify(arg)));
      originalConsoleError(...sanitized);
      return;
    }
    originalConsoleError(...args);
  };
}

class InMemoryAccountLinkChallengeStore implements AccountLinkChallengeStore {
  private readonly byDiscordUserId = new Map<DiscordUserId, AccountLinkChallenge>();
  private readonly ownerByNonce = new Map<string, DiscordUserId>();

  public async create(challenge: AccountLinkChallenge): Promise<void> {
    this.byDiscordUserId.set(challenge.discordUserId, challenge);
    this.ownerByNonce.set(challenge.nonce, challenge.discordUserId);
  }

  public async getActive(discordUserId: DiscordUserId): Promise<AccountLinkChallenge | null> {
    return this.byDiscordUserId.get(discordUserId) ?? null;
  }

  public async markUsed(nonce: string): Promise<void> {
    const owner = this.ownerByNonce.get(nonce);
    if (!owner) {
      return;
    }

    const challenge = this.byDiscordUserId.get(owner);
    if (!challenge) {
      return;
    }

    this.byDiscordUserId.set(owner, {
      ...challenge,
      used: true,
    });
  }
}

class InMemoryAccountLinkStore implements AccountLinkStore {
  private readonly links = new Map<DiscordUserId, { accountId: PolymarketAccountId; linkedAtMs: number }>();

  public async link(
    discordUserId: DiscordUserId,
    polymarketAccountId: PolymarketAccountId,
    linkedAtMs: number,
  ): Promise<void> {
    this.links.set(discordUserId, { accountId: polymarketAccountId, linkedAtMs });
  }

  public async getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null> {
    return this.links.get(discordUserId)?.accountId ?? null;
  }

  public async unlink(discordUserId: DiscordUserId): Promise<void> {
    this.links.delete(discordUserId);
  }
}

const MARKET_FIXTURES: readonly Market[] = [
  {
    id: 'market-1' as Market['id'],
    question: 'Will BTC close above $100k by Dec 31, 2026?',
    status: 'active',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.65, 0.35],
    volume: 1500000,
  },
  {
    id: 'market-2' as Market['id'],
    question: 'Will ETH ETF inflows be positive this quarter?',
    status: 'active',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.42, 0.58],
    volume: 800000,
  },
  {
    id: 'market-3' as Market['id'],
    question: 'Will the Fed cut rates in the next meeting?',
    status: 'paused',
    outcomes: ['YES', 'NO'],
    outcomePrices: [0.3, 0.7],
    volume: 2200000,
  },
];

class InMemoryPolymarketReadProvider implements PolymarketReadProvider {
  public async listMarkets(): Promise<readonly Market[]> {
    return MARKET_FIXTURES;
  }

  public async getMarket(marketId: Market['id']): Promise<Market | null> {
    return MARKET_FIXTURES.find((market) => market.id === marketId) ?? null;
  }

  public async searchMarkets(query: string): Promise<readonly Market[]> {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return MARKET_FIXTURES;
    }

    return MARKET_FIXTURES.filter((market) => market.question.toLowerCase().includes(normalized));
  }
}

class ClobPolymarketExecutionGateway implements PolymarketExecutionGateway {
  private static readonly USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  private static readonly RPC_ENDPOINTS = [
    process.env.POLYGON_RPC_URL,
    'https://polygon-bor-rpc.publicnode.com',
    'https://1rpc.io/matic',
  ].filter((value): value is string => Boolean(value && value.length > 0));

  private readonly clobClient: ClobClient;
  private authInvalid = false;

  public constructor() {
    installClobErrorRedactor();

    const privateKey = process.env.WALLET_PRIVATE_KEY;
    const apiKey = process.env.POLYMARKET_API_KEY;
    const apiSecret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;

    const proxyWallet = process.env.POLYMARKET_PROXY_WALLET;
    const signatureType = parseClobSignatureType(process.env.POLYMARKET_SIGNATURE_TYPE);

    if (!privateKey || !apiKey || !apiSecret || !passphrase || !proxyWallet) {
      throw new Error(
        'Missing CLOB credentials. Set WALLET_PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_PASSPHRASE, POLYMARKET_PROXY_WALLET in .env',
      );
    }

    const wallet = new EthersV5Wallet(privateKey);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CLOB client expects ethers v5 Wallet shape
    this.clobClient = new ClobClient(
      'https://clob.polymarket.com',
      Chain.POLYGON,
      wallet as any,
      { key: apiKey, secret: apiSecret, passphrase },
      signatureType,
      proxyWallet,
    );

    const maskedEoa = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
    const maskedProxy = `${proxyWallet.slice(0, 6)}…${proxyWallet.slice(-4)}`;
    console.log(
      `🔗 ClobPolymarketExecutionGateway initialized (EOA: ${maskedEoa}, Proxy: ${maskedProxy}, SignatureType: ${clobSignatureTypeLabel(signatureType)}=${signatureType})`,
    );

    // Ensure USDC allowance is set for exchange contracts (one-time on-chain approval)
    this.ensureAllowance().catch((err) => {
      console.error('⚠️ Failed to set USDC allowance — trades may fail:', sanitizeErrorForLog(err));
    });
  }

  /**
   * Check and set USDC balance allowance for the Polymarket exchange contracts.
   * This is an idempotent operation — if allowance is already max, it's a no-op on-chain.
   */
  private async ensureAllowance(): Promise<void> {
    try {
      const collateralParams = { asset_type: AssetType.COLLATERAL };
      const current = await this.clobClient.getBalanceAllowance(collateralParams) as unknown as Record<string, unknown>;

      // CLOB client may return an HTTP error object instead of { balance, allowance }
      if (typeof current.status === 'number' && current.status >= 400) {
        const errText = String((current.data as Record<string, unknown> | undefined)?.error ?? current.statusText ?? `HTTP ${current.status}`);
        if (isClobAuthErrorText(errText)) {
          this.authInvalid = true;
          console.error('❌ CLOB auth check failed during allowance check: invalid API credentials/signature for configured wallet');
          return;
        }
        console.warn('⚠️ getBalanceAllowance returned error, updating allowance anyway...');
        await this.clobClient.updateBalanceAllowance(collateralParams);
        console.log('✅ USDC allowance updated');
        return;
      }

      const balance = current.balance as string | undefined;
      const allowance = current.allowance as string | undefined;
      console.log(`💰 Current allowance: ${allowance}, balance: ${balance}`);

      // If allowance is very low (or zero), update it
      const allowanceBigInt = BigInt(allowance || '0');
      const threshold = BigInt('1000000000'); // 1000 USDC in 6 decimals
      if (allowanceBigInt < threshold) {
        console.log('🔓 Setting max USDC allowance for Polymarket exchange...');
        await this.clobClient.updateBalanceAllowance(collateralParams);
        console.log('✅ USDC allowance updated successfully');
      } else {
        console.log('✅ USDC allowance already sufficient');
      }
    } catch (err) {
      console.error('⚠️ Allowance check/update error:', sanitizeErrorForLog(err));
      if (isClobAuthErrorText(sanitizeErrorForLog(err))) {
        this.authInvalid = true;
        return;
      }
      // Try to set allowance anyway
      try {
        await this.clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        console.log('✅ USDC allowance updated (fallback)');
      } catch (updateErr) {
        console.error('❌ Could not update allowance:', sanitizeErrorForLog(updateErr));
      }
    }
  }

  public async executeTradeForAccount(
    _polymarketAccountId: PolymarketAccountId,
    params: ExecuteTradeParams,
  ): Promise<ExecuteTradeResponse> {
    if (this.authInvalid) {
      throw {
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Polymarket credentials are invalid for this wallet (invalid API key/signature). Regenerate POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_PASSPHRASE for the same WALLET_PRIVATE_KEY/POLYMARKET_PROXY_WALLET pair and restart.',
      };
    }

    const conditionId = String(params.marketId);

    // 1. Resolve token ID for this market
    const tokenId = await this.resolveTokenId(conditionId, params.outcome);

    // 2. Fetch the correct tick size from the CLOB (varies per market: 0.1 / 0.01 / 0.001 / 0.0001)
    const tickSize = await this.clobClient.getTickSize(tokenId);
    console.log(`⏱️  Tick size for token ${tokenId.substring(0, 12)}...: ${tickSize}`);

    // 3. Amount handling
    //    - BUY: CLOB expects dollar amount (USDC to spend)
    //    - SELL: CLOB expects share count (outcome tokens to sell)
    const amountDollars = params.amountCents / 100;
    if (amountDollars < 1) {
      throw { code: 'INVALID_AMOUNT', message: 'Polymarket minimum order size is $1' };
    }

    const side = params.action === 'SELL' ? Side.SELL : Side.BUY;

    // For SELL orders, convert dollar amount → share count using current market price
    let orderAmount = amountDollars;
    if (params.action === 'SELL') {
      // If caller provided an exact share count (e.g. sell-all-position), use it directly
      if (params.sellShares && params.sellShares > 0) {
        orderAmount = Math.floor(params.sellShares * 100) / 100; // round to 2 decimals
        console.log(`🔄 SELL using exact share count: ${orderAmount} shares`);
      } else {
        try {
          const book = await this.clobClient.getOrderBook(tokenId);
          const bids = (book as unknown as { bids?: Array<{ price: string }> }).bids;
          const bestBid = bids && bids.length > 0 ? parseFloat(bids[0].price) : 0;
          if (bestBid > 0) {
            // User wants to receive ~$X, so sell ($X / price) shares
            orderAmount = Math.floor((amountDollars / bestBid) * 100) / 100;
            console.log(
              `🔄 SELL conversion: $${amountDollars} ÷ ${bestBid} (best bid) = ${orderAmount} shares`,
            );
          } else {
            console.warn('⚠️ No bids found in order book, using raw amount as share count');
          }
        } catch (err) {
          console.warn('⚠️ Could not fetch order book for sell conversion, using raw amount:', sanitizeErrorForLog(err));
        }
      }
    }

    // 4. Place the market order via CLOB
    console.log(
      `📤 Placing market order: ${side} ${params.outcome} ${params.action === 'SELL' ? `${orderAmount} shares (~$${amountDollars})` : `$${amountDollars}`} on ${conditionId} (token ${tokenId.substring(0, 12)}... tickSize=${tickSize})`,
    );

    let result: unknown;
    try {
      result = await this.clobClient.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount: orderAmount,
          side,
        },
        { tickSize },
        OrderType.FOK,
      );
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null
            ? JSON.stringify(error)
            : String(error);
      // Redact potential API keys/secrets before logging, then truncate
      const safeMsg = redactSensitiveLogText(errMsg, 120);
      console.error('❌ CLOB order failed:', safeMsg);

      if (errMsg.includes('insufficient') || errMsg.includes('balance')) {
        throw { code: 'INVALID_AMOUNT', message: 'Insufficient balance on Polymarket' };
      }
      if (errMsg.includes('not found') || errMsg.includes('404')) {
        throw { code: 'INVALID_MARKET', message: 'Market not found on CLOB' };
      }
      if (errMsg.includes('not accepting')) {
        throw { code: 'MARKET_NOT_ACTIVE', message: 'Market is not accepting orders' };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: errMsg };
    }

    const resultObj = result as Record<string, unknown>;
    const logSafe = { status: resultObj.status, success: resultObj.success, orderID: resultObj.orderID, data: resultObj.data };
    console.log('📥 Order result:', JSON.stringify(logSafe));

    // CLOB client may return HTTP error responses (e.g. 400) without throwing
    const httpStatus = typeof resultObj.status === 'number' ? resultObj.status : null;
    const dataError = (resultObj.data as Record<string, unknown> | undefined)?.error as string | undefined;

    if (httpStatus && httpStatus >= 400) {
      const errText = dataError ?? String(resultObj.statusText ?? `HTTP ${httpStatus}`);
      console.error(`❌ CLOB returned HTTP ${httpStatus}:`, errText);

      if (isClobAuthErrorText(errText) || httpStatus === 401) {
        this.authInvalid = true;
        throw {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Polymarket rejected the request due to invalid API key/signature. Regenerate POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_PASSPHRASE for the configured wallet, then restart the bot.',
        };
      }

      if (errText.includes('balance') || errText.includes('allowance') || errText.includes('insufficient')) {
        if (params.action === 'SELL') {
          throw {
            code: 'INVALID_AMOUNT',
            message: 'Insufficient position size for this outcome on the selected market. Use an exact market/outcome close command.',
          };
        }
        throw { code: 'INVALID_AMOUNT', message: 'Insufficient USDC balance on Polymarket. Deposit funds first.' };
      }
      if (errText.includes('not found') || httpStatus === 404) {
        throw { code: 'INVALID_MARKET', message: 'Market not found on CLOB' };
      }
      if (params.action === 'SELL' && httpStatus === 400) {
        throw {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Sell order was rejected (HTTP 400). This usually means wrong market/outcome selection or no immediately fillable bids.',
        };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: errText };
    }

    const success = resultObj.success as boolean | undefined;
    const status = typeof resultObj.status === 'string' ? resultObj.status : undefined;
    const errorMsg = resultObj.errorMsg as string | undefined;

    // Check if order actually filled
    if (success === false || (status && status !== 'matched' && status !== 'delayed')) {
      const reason = String(errorMsg || status || 'Order was not filled');
      console.error('❌ Order not filled:', reason);
      // Provide a more helpful message for FOK unmatched orders
      if (!reason || reason.toLowerCase().includes('unmatched') || reason.toLowerCase().includes('unfilled')) {
        throw { code: 'UPSTREAM_UNAVAILABLE', message: 'Order not filled — no match available right now. Try again in a moment.' };
      }
      throw { code: 'UPSTREAM_UNAVAILABLE', message: reason };
    }

    // Extract transaction hash or order ID
    const txHashes = resultObj.transactionsHashes as string[] | undefined;
    const tradeId =
      txHashes?.[0] ??
      (resultObj.orderID as string | undefined) ??
      params.idempotencyKey;

    return {
      tradeId: String(tradeId),
      executedAtMs: Date.now(),
    };
  }

  /**
   * Resolves the CLOB token ID and tick size for a given conditionId + outcome.
   * Tries CLOB getMarket first, falls back to Gamma clobTokenIds.
   */
  private async resolveTokenId(conditionId: string, outcome: 'YES' | 'NO'): Promise<string> {
    // Map YES/NO to the market's actual outcome labels
    // Timed up/down markets use "Up"/"Down"; standard markets use "Yes"/"No"
    const desiredOutcomes =
      outcome === 'YES' ? ['up', 'yes'] : ['down', 'no'];

    try {
      const clobMarket = await this.clobClient.getMarket(conditionId);
      const raw = clobMarket as Record<string, unknown>;
      const tokens = raw.tokens as
        | Array<{ token_id: string; outcome: string }>
        | undefined;

      if (tokens && tokens.length > 0) {
        const match = tokens.find((t) =>
          desiredOutcomes.includes(t.outcome.toLowerCase()),
        );
        return match
          ? match.token_id
          : outcome === 'YES' ? tokens[0].token_id : tokens[1].token_id;
      }
    } catch {
      console.warn('CLOB getMarket failed for', conditionId, '- trying Gamma fallback');
    }

    // Fallback: query Gamma API for clobTokenIds
    const gammaResp = await fetch(
      `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(conditionId)}`,
    );
    if (gammaResp.ok) {
      const markets = (await gammaResp.json()) as Array<{
        clobTokenIds?: string;
        outcomes?: string;
      }>;
      if (markets.length > 0) {
        const m = markets[0];
        const tokenIds: string[] = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
        const outcomeNames: string[] = m.outcomes ? JSON.parse(m.outcomes) : [];
        if (tokenIds.length >= 2) {
          const idx = outcomeNames.findIndex((o) =>
            desiredOutcomes.includes(o.toLowerCase()),
          );
          return idx >= 0 ? tokenIds[idx] : (outcome === 'YES' ? tokenIds[0] : tokenIds[1]);
        }
      }
    }

    throw { code: 'INVALID_MARKET', message: `Could not resolve token for ${conditionId} outcome ${outcome}` };
  }

  public async getBalanceForAccount(polymarketAccountId: PolymarketAccountId): Promise<Balance> {
    try {
      const safeCents = await this.readOnchainUsdcCents(polymarketAccountId);

      return {
        userId: String(polymarketAccountId) as Balance['userId'],
        availableCents: safeCents as Balance['availableCents'],
        spentTodayCents: 0 as Balance['spentTodayCents'],
        remainingDailyLimitCents: 500 as Balance['remainingDailyLimitCents'],
        asOfMs: Date.now(),
      };
    } catch (error) {
      console.error('Failed to read Polymarket public value:', sanitizeErrorForLog(error));
    }

    return {
      userId: String(polymarketAccountId) as Balance['userId'],
      availableCents: 0 as Balance['availableCents'],
      spentTodayCents: 0 as Balance['spentTodayCents'],
      remainingDailyLimitCents: 500 as Balance['remainingDailyLimitCents'],
      asOfMs: Date.now(),
    };
  }

  private async readOnchainUsdcCents(account: PolymarketAccountId): Promise<number> {
    const addressHex = String(account).toLowerCase().replace(/^0x/, '');
    if (addressHex.length !== 40) {
      throw new Error('Invalid account address for USDC balance lookup');
    }

    const data = `0x70a08231000000000000000000000000${addressHex}`;

    let lastError: unknown;
    for (const endpoint of ClobPolymarketExecutionGateway.RPC_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_call',
            params: [{ to: ClobPolymarketExecutionGateway.USDC_CONTRACT, data }, 'latest'],
            id: 1,
          }),
        });

        if (!response.ok) {
          throw new Error(`RPC ${endpoint} returned ${response.status}`);
        }

        const payload = (await response.json()) as { result?: string; error?: { message?: string } };
        if (payload.error) {
          throw new Error(payload.error.message || `RPC ${endpoint} returned error`);
        }
        if (!payload.result || !payload.result.startsWith('0x')) {
          throw new Error(`RPC ${endpoint} returned invalid result`);
        }

        const raw = BigInt(payload.result);
        const cents = raw / 10_000n; // USDC 6 decimals -> cents
        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        return Number(cents > maxSafe ? maxSafe : cents);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('No Polygon RPC endpoints available');
  }

  public async getRecentTradesForAccount(
    polymarketAccountId: PolymarketAccountId,
    limit: number,
  ): Promise<readonly TradeResult[]> {
    try {
      const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 5)));
      const encodedUser = encodeURIComponent(polymarketAccountId);
      const response = await fetch(`https://data-api.polymarket.com/trades?user=${encodedUser}&limit=${safeLimit}`);

      if (!response.ok) {
        throw new Error(`trades endpoint failed with status ${response.status}`);
      }

      const rows = (await response.json()) as Array<{
        transactionHash?: string;
        conditionId?: string;
        outcome?: string;
        size?: number;
        price?: number;
        timestamp?: number;
      }>;

      return rows.slice(0, safeLimit).map((row, index) => {
        const outcomeRaw = (row.outcome || '').toLowerCase();
        const normalizedOutcome: 'YES' | 'NO' =
          outcomeRaw === 'no' || outcomeRaw === 'down' ? 'NO' : 'YES';

        const size = Number.isFinite(row.size) ? Number(row.size) : 0;
        const price = Number.isFinite(row.price) ? Number(row.price) : 0;
        const amountCents = Math.max(0, Math.round(size * price * 100));
        const executedAtMs = row.timestamp ? row.timestamp * 1000 : Date.now();

        return {
          ok: true as const,
          tradeId: row.transactionHash || `trade:${index}:${executedAtMs}`,
          userId: String(polymarketAccountId) as unknown as DiscordUserId,
          marketId: (row.conditionId || 'unknown-market') as Market['id'],
          outcome: normalizedOutcome,
          amountCents: amountCents as Balance['availableCents'],
          executedAtMs,
        };
      });
    } catch (error) {
      console.error('Failed to read Polymarket recent trades:', error);
      return [];
    }
  }
}

export const accountLinkChallengeService = new AccountLinkChallengeService(
  new InMemoryAccountLinkChallengeStore(),
);

export const accountLinkPersistenceService = new AccountLinkPersistenceService(
  new InMemoryAccountLinkStore(),
);

export const accountLinkVerificationService = new AccountLinkVerificationService(
  accountLinkChallengeService,
  new EvmSignatureVerifier(),
);

/**
 * READ pipeline — works without any backend.
 * Uses the live Polymarket Gamma API (public, no auth) for market data
 * and AI (OpenAI primary, Gemini fallback) for conversational responses.
 */
export const readService = new PolymarketReadService(new PolymarketApiReadProvider());
export const activeMarketIndex = new ActiveMarketIndex(
  readService,
  Number(process.env.MARKET_INDEX_REFRESH_MS ?? 60_000) || 60_000,
);
export const aiReadExplainer = createAiReadExplainer();

/**
 * WRITE pipeline — all users trade via leader's wallet.
 * No external persistence needed.
 */
export const trader = new UserAccountTrader(
  new ClobPolymarketExecutionGateway(),
  async (discordUserId: DiscordUserId) => {
    const linked = await accountLinkPersistenceService.getLinkedAccount(discordUserId);
    if (linked.ok) {
      return linked.polymarketAccountId;
    }
    // Fall back to leader's proxy wallet so all users can trade
    return (process.env.POLYMARKET_PROXY_WALLET as PolymarketAccountId) ?? null;
  },
);
