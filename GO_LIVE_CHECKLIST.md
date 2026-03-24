# Go-Live Checklist

Status as of 2026-02-26:

| Mode | Status |
|------|--------|
| **AI Assistant (READ)** | **✅ Ready** — live Polymarket API + Gemini explainer |
| **Wallet-Linked Trading (WRITE)** | **⚠️ Needs Supabase backend** |

---

## READ Mode — Go-Live Requirements

All items complete. This mode can be deployed with just `DISCORD_BOT_TOKEN` and `GEMINI_API_KEY`.

- [x] `PolymarketApiReadProvider` — live Polymarket Gamma API (public, no auth)
- [x] `aiReadExplainer` — Gemini-powered conversational responses
- [x] Static fallback when Gemini is unavailable or rate-limited
- [x] Conservative classifier defaults to READ
- [x] Key rotation across multiple Gemini API keys

---

## WRITE Mode — Blocking Items (Supabase Backend)

### 1. Supabase Integration

- [ ] **`account_links` table** — Replace `InMemoryAccountLinkStore` with Supabase-backed persistence.
- [ ] **`challenges` table** — Replace `InMemoryAccountLinkChallengeStore` with Supabase table + row-level TTL/expiry.
- [ ] **`trades` table** — Persist trade logs for audit trail and spend tracking.
- [ ] **Spend tracking queries** — Replace `DAILY_LIMIT_CENTS_STUB` and `SPENT_THIS_HOUR_CENTS_STUB` in `buildValidationContext.ts` with aggregation queries on the `trades` table.
- [ ] Install `@supabase/supabase-js` and wire Supabase client in `wire.ts`.

### 2. Real Polymarket Execution API

- [ ] **PolymarketExecutionGateway** — Implement against the live Polymarket order API (replace `StubPolymarketExecutionGateway`).
  - `executeTradeForAccount()` → submit order, return trade ID
  - `getBalanceForAccount()` → fetch real balance
  - `getRecentTradesForAccount()` → fetch trade history
- [ ] Handle Polymarket API rate limits, retries, and transient failures.

### 3. Environment & Configuration

- [ ] Validate required env vars on startup (`DISCORD_BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, Polymarket API credentials). Fail fast with clear error messages if missing.
- [ ] Add `.env.example` documenting all required/optional variables.

### 4. Graceful Shutdown

- [ ] Handle `SIGINT` / `SIGTERM` — destroy Discord client, flush pending writes, close Supabase connections.

---

## Should-Fix (High Priority)

### 5. Error Observability

- [ ] Add structured logging (e.g., pino) throughout service layers — especially trade execution, signature verification, and validation failures.
- [ ] Log trade audit trail: who, what market, how much, result, timestamp.

### 6. Rate Limiting & Abuse Prevention

- [ ] Per-user Discord command rate limiting (prevent challenge spam, rapid-fire trade attempts).
- [ ] Consider per-IP or per-account Polymarket API rate budgets.

### 7. Tests

- [ ] Unit tests for pure functions: `classifyMessageIntent`, `validateAgentOutput`, `buildTradeRequest`, `buildSignedLinkMessage`.
- [ ] Integration tests for account-link lifecycle (challenge → verify → persist → disconnect).
- [ ] Integration tests for WRITE pipeline (parse → validate → build → execute).
- [ ] Mock-based tests for `DiscordMessageRouter` orchestration.

---

## Nice-to-Have (Post-Launch)

### 8. Slash Commands

- [ ] Register Discord slash commands (`/connect`, `/verify`, `/disconnect`, `/trade`, `/markets`) for better UX and discoverability.

### 9. Multi-Market Support

- [ ] Support non-binary markets if Polymarket adds them.

### 10. Admin Dashboard

- [ ] Admin commands or web dashboard for monitoring linked accounts, trade volume, error rates.

---

## Already Done ✅

- [x] Branded type system (`DiscordUserId`, `PolymarketAccountId`, `MarketId`, `UsdCents`)
- [x] Result union pattern (no unchecked exceptions across boundaries)
- [x] EIP-191 challenge-response account linking with `crypto.randomUUID()` nonces
- [x] Challenge consumption after signature verification (no DoS vector)
- [x] Conservative READ/WRITE classifier (defaults ambiguous to READ)
- [x] Deterministic validation with injected context (pure, testable)
- [x] Deterministic idempotency keys (5-min time buckets)
- [x] Discord message routing with user-facing error mapping
- [x] Account link commands (connect / verify / disconnect)
- [x] Wire/DI barrel with live READ + stubbed WRITE
- [x] Live Polymarket Gamma API read provider
- [x] AI-powered read explainer with OpenAI
- [x] OpenAI fallback for when API is unavailable
- [x] Zero compile errors across entire workspace
- [x] Docs match current codebase (Supabase noted as future backend)
