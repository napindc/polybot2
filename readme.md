# PolyBot — Polymarket Discord Bot

A Discord bot that queries [Polymarket](https://polymarket.com) prediction markets and executes real on-chain trades — all from Discord. **No login or wallet setup required for users.**

**@mention the bot** in any channel to ask about markets or place trades. It fetches real-time odds from Polymarket's APIs and responds conversationally using Google Gemini.

## Features

- **Natural language market search** — Ask `"what are the odds on BTC going up?"` and get live prices for matching markets
- **Live market data** — Prices, volume, and status pulled from the Polymarket Gamma API
- **AI-powered responses** — Gemini generates conversational answers with market context
- **Real trade execution** — BUY and SELL orders via Polymarket's CLOB API with Gnosis Safe signing
- **No login required** — All users trade through the leader's wallet; no account linking needed
- **Wallet balance lookup** — Any user can check any Polymarket wallet's balance and positions by providing an address
- **Timed market support** — Auto-resolves current BTC/ETH 5m and 15m up/down windows
- **Deterministic fallback** — Common trade patterns (`bet $5 on up`, `sell $5 of down`) work via regex without AI
- **Graceful degradation** — Falls back to structured data responses when AI quota is exhausted
- **Multi-key rotation** — Supports up to 6 Gemini API keys with automatic failover on rate limits
- **Security hardened** — Masked wallet logs, per-user cooldowns, daily spend limits

## Setup Guide

### 1. Clone & Install

```bash
git clone https://github.com/Prithwiraj-CK/polybot2.git
cd polybot2
npm install
```

### 2. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. Under **Bot** → click **Reset Token** → copy the token → this is your `DISCORD_BOT_TOKEN`
3. Under **General Information** → copy the **Application ID** → this is your `DISCORD_CLIENT_ID`
4. Enable **Message Content Intent** under Bot → Privileged Gateway Intents
5. Invite the bot to your server using the OAuth2 URL Generator (scopes: `bot`, `applications.commands`; permissions: Send Messages, Read Messages, Embed Links, Use Slash Commands)
6. Right-click your Discord server → **Copy Server ID** (enable Developer Mode in Discord settings first) → this is your `DISCORD_GUILD_ID`

### 3. Set Up the Leader's Polymarket Wallet

All users trade through a single leader-controlled wallet. You need a Polymarket account with USDC deposited.

1. **Create/export wallet** — Use MetaMask or similar. Export the private key → this is your `WALLET_PRIVATE_KEY` (prefix with `0x`)
2. **Find your proxy wallet** — After depositing on Polymarket, go to your Polymarket account settings to find your proxy/safe wallet address → this is your `POLYMARKET_PROXY_WALLET`
3. **Generate CLOB API credentials** — Use the Polymarket CLOB API's `/auth/api-key` endpoint (or their SDK) to generate:
    click on profile >settings >builder codes
   - `POLYMARKET_API_KEY`
   - `POLYMARKET_API_SECRET`
   - `POLYMARKET_PASSPHRASE`

### 4. Get AI API Keys

The bot uses OpenAI (primary) and Google Gemini (fallback) for conversational responses and intent parsing.

- **OpenAI** — Get a key from [OpenAI Platform](https://platform.openai.com/api-keys) → this is your `OPENAI_API_KEY`. Uses `gpt-4o-mini` by default (cheap, fast, great structured output).
- **Gemini** *(fallback)* — Get a key from [Google AI Studio](https://aistudio.google.com/apikey). You can add up to 6 keys (`GEMINI_API_KEY` through `GEMINI_API_KEY_6`) for automatic rate-limit rotation. Used when OpenAI is unavailable or rate-limited.

### 5. Configure `.env`

Create a `.env` file in the project root with all your credentials:

```env
# Discord
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_GUILD_ID=your_discord_guild_id

# AI Keys — OpenAI is primary, Gemini is fallback (at least one required)
OPENAI_API_KEY=your_openai_api_key
GEMINI_API_KEY=your_gemini_api_key
# GEMINI_API_KEY_2=optional_second_key
# GEMINI_API_KEY_3=optional_third_key

# Polymarket CLOB API (leader's wallet credentials)
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_API_SECRET=your_polymarket_api_secret
POLYMARKET_PASSPHRASE=your_polymarket_passphrase
WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
POLYMARKET_PROXY_WALLET=0xYOUR_PROXY_WALLET
# Optional: EOA | POLY_PROXY | POLY_GNOSIS_SAFE (or 0/1/2). Default: POLY_PROXY
POLYMARKET_SIGNATURE_TYPE=POLY_PROXY

# Owner Discord user ID — exempt from $5/day spend limit (right-click your profile → Copy User ID)
OWNER_DISCORD_ID=your_discord_user_id

# Redis (optional — without this, daily spend limits reset on bot restart)
# REDIS_URL=rediss://default:password@your-redis-host:6379
```

### Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | Bot authentication token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | ✅ | Bot's application/client ID |
| `DISCORD_GUILD_ID` | ✅ | Target Discord server ID |
| `WALLET_PRIVATE_KEY` | ✅ | EOA private key that controls the Polymarket proxy wallet |
| `POLYMARKET_PROXY_WALLET` | ✅ | Polymarket proxy/safe wallet address (where trades execute) |
| `POLYMARKET_API_KEY` | ✅ | CLOB API key (generated via Polymarket API) |
| `POLYMARKET_API_SECRET` | ✅ | CLOB API secret |
| `POLYMARKET_PASSPHRASE` | ✅ | CLOB API passphrase |
| `POLYMARKET_SIGNATURE_TYPE` | ❌ | Signing mode for CLOB orders (`EOA`, `POLY_PROXY`, or `POLY_GNOSIS_SAFE`). Default is `POLY_PROXY`. |
| `OPENAI_API_KEY` | ✅ | OpenAI API key — primary AI provider (uses `gpt-4o-mini` by default) |
| `GEMINI_API_KEY` | ✅ | Google Gemini AI key (fallback when OpenAI is unavailable) |
| `GEMINI_API_KEY_2` … `_6` | ❌ | Additional Gemini keys for rate-limit rotation |
| `OWNER_DISCORD_ID` | ❌ | Bot owner's Discord user ID (exempt from $5/day spend limit) |
| `REDIS_URL` | ❌ | Redis connection string for persistent spend tracking. Without this, spend limits use in-memory storage and reset on restart. [Upstash](https://upstash.com) works well. |
| `AUTH_BASE_URL` | ❌ | Base URL for the auth server (default: `http://localhost:3001`). Only needed if using the wallet-link flow. |

### 6. Run

```bash
npx tsx src/index.ts
```

The bot will log in and respond to @mentions in the configured server.

## Usage

### Market Queries (READ)
```
@PolyBot what are the odds on the next US election?
@PolyBot tell me about Bitcoin markets
@PolyBot show me trending crypto markets
```

### Trading (WRITE) — No Login Required
All trades execute through the leader's Polymarket wallet. Each user has a $5/day spending limit.

```
@PolyBot bet $5 on Missouri Tigers vs Miami Hurricanes on Missouri Tigers
@PolyBot buy $5 on bitcoin 15 minute up
@PolyBot buy $5 on "Will BTC hit 100k?" yes
@PolyBot sell $5 of bitcoin 5 minute down
```

### Wallet Balance & Positions
Any user can check any wallet's balance by including a `0x` address:

```
@PolyBot balance 0xYOUR_PROXY_WALLET_ADDRESS
@PolyBot what's my balance              ← shows the trading wallet + daily spend limit
```

### Slash Commands
```
/status    — Show the trading wallet address
/balance   — View USDC balance, positions, and daily spend limit
```

## How It Works

```
User @mentions bot → Message Router → READ or WRITE pipeline

READ (default):
  1. Direct lookup: detect Polymarket URL or condition ID → instant match
  2. Extract keywords + predict slugs (AI or regex fallback)
  3. Parallel search: slug candidates + events text_query (via Promise.all)
  4. Merge, deduplicate, and rank with TF-IDF scoring
  5. Sports-aware fallback: series-based search with fuzzy team matching
  6. Generate conversational response (Gemini)
  7. Reply in Discord

WRITE (trade commands):
  1. Parse intent via AI or deterministic regex fallback
  2. Resolve timed market slug if applicable
  3. Validate deterministically (market, amount, limits)
  4. All trades go through the leader's wallet (no per-user linking)
  5. Execute BUY/SELL order via CLOB API (Fill-or-Kill)
  6. Reply with trade confirmation or error

BALANCE (wallet lookup):
  1. Detect 0x address in message (optional)
  2. If address provided → fetch that wallet's public data
  3. If no address → show trading wallet + daily spend info
  4. Uses public Polymarket APIs + Polygon RPC (no auth needed)
```

## What Gemini Does

Gemini is used for **three things**, all non-authoritative:

| Use | File | What happens without it |
|-----|------|------------------------|
| **Keyword extraction + slug prediction** | `PolymarketApiReadProvider.ts` | Falls back to regex prefix stripping |
| **Conversational responses** | `aiReadExplainer.ts` | Falls back to structured data template |
| **Intent parsing** (WRITE) | `intentParser.ts` | Deterministic regex handles common patterns |

**Gemini is untrusted.** All AI output passes through deterministic validation before any action is taken.

## Project Structure

```
src/
├── index.ts                 # Discord client, @mention handler, per-user cooldown
├── wire.ts                  # Dependency injection + ClobPolymarketExecutionGateway
├── types.ts                 # Branded types (MarketId, UsdCents, TradeAction, etc.)
│
├── read/                    # READ pipeline
│   ├── aiClient.ts          # Shared AI client with 6-key rotation
│   ├── PolymarketApiReadProvider.ts  # Gamma API client + multi-strategy search pipeline
│   ├── PolymarketReadService.ts      # Service layer
│   └── aiReadExplainer.ts   # AI response generator + fallback
│
├── discord/                 # Discord layer
│   ├── DiscordMessageRouter.ts    # Routes READ/WRITE, balance lookup, trade fallback
│   ├── classifyMessageIntent.ts   # Regex classifier (no AI)
│   └── AccountLinkCommands.ts     # Slash commands: /status, /balance
│
├── agent/                   # AI intent parsing
│   └── intentParser.ts      # Gemini → structured JSON (BUY/SELL action)
│
├── backend/                 # Deterministic validation
│   ├── validateAgentOutput.ts     # Pure precondition checks
│   ├── buildTradeRequest.ts       # Trade assembly + idempotency
│   └── buildValidationContext.ts  # Context construction (falls back to leader wallet)
│
├── auth/                    # EVM wallet linking (legacy, not user-facing)
│   ├── AccountLinkChallengeService.ts
│   ├── AccountLinkVerificationService.ts
│   ├── AccountLinkPersistenceService.ts
│   ├── EvmSignatureVerifier.ts
│   └── polymarketAuth.ts
│
├── trading/                 # Trade execution
│   └── UserAccountTrader.ts # Executes BUY/SELL via CLOB gateway
│
├── storage/                 # Persistence
│   ├── limits.ts            # Per-user daily spend tracking ($5/day)
│   └── redisClient.ts       # Redis client (optional, falls back to in-memory)
│
├── server/                  # Auth HTTP server
│   └── authServer.ts        # Express server for wallet-link flow
│
public/                      # Web UI
├── connect.html
└── trade-confirm.html

tests/                       # Integration tests (Vitest, real Gamma API)
├── integration/
│   ├── search.test.ts       # API-level search tests
│   ├── top-result-quality.test.ts  # End-to-end top result correctness
│   ├── comprehensive-search.test.ts  # Full coverage across all categories
│   └── bot-search.test.ts   # Bot-level search integration
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ES2022, strict mode) |
| Discord | discord.js v14 |
| AI | Google Gemini via `@google/genai` SDK |
| Trade Execution | `@polymarket/clob-client` + `@polymarket/order-utils` |
| Market Data | Polymarket Gamma API (public, no auth) |
| Wallet/Signing | ethers v6 (Gnosis Safe signature type) |
| Auth Server | Express v5, CORS-restricted |
| Persistence | Redis via ioredis (optional in-memory fallback) |
| Testing | Vitest v4 (integration tests against real Gamma API) |
| Config | dotenv |

## Security

- All credentials loaded from environment variables — no hardcoded secrets
- Wallet addresses masked in all log output
- CORS restricted to configured origins on auth server
- Per-user 5-second command cooldown
- $5/day per-user spend limit with atomic enforcement
- Sell orders bypass spend limits (returns funds)
- Order result logs sanitized to `status`/`success`/`orderID` only
- All users trade through a single leader wallet — no per-user key management

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full file map, data flows, CLOB execution details, and design principles.
