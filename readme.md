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

## Quick Start

```bash
git clone https://github.com/Prithwiraj-CK/polybot2.git
cd polybot2
npm install
```

Create a `.env` file (see [.env.example](.env.example) for all options):

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_GUILD_ID=your_discord_guild_id

GEMINI_API_KEY=your_gemini_api_key

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key

# Polymarket CLOB API (leader's wallet credentials)
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_API_SECRET=your_polymarket_api_secret
POLYMARKET_PASSPHRASE=your_polymarket_passphrase
WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
POLYMARKET_PROXY_WALLET=0xYOUR_PROXY_WALLET
```

Run:

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
@PolyBot bet $5 on up on the current btc 15 min market
@PolyBot sell $5 of up on the current btc 15 min market
@PolyBot buy $5 on yes for "Will BTC hit 100k?"
@PolyBot exit $5 of down on the btc 5 minute market
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
