# Non-Negotiable System Rules for Financial Discord Bot

These rules are strictly enforced in deterministic backend code (not prompts). All are mandatory and subject to audit.

## System Rules (Enforced in Code)

### 1. Shared Wallet Trading Model
- All users trade through a single leader-controlled Polymarket wallet (`POLYMARKET_PROXY_WALLET`).
- **No login, wallet connection, or account linking required** for users to trade.
- Users are identified by their Discord user ID for spend tracking.
- The leader's wallet credentials are managed server-side via environment variables.

### 2. Per-User Daily Spending Limits
- Each user is limited to a maximum of **$5** in total BUY orders per 24-hour UTC period.
- All BUY attempts exceeding this limit are rejected with clear feedback to the user.
- Enforced via atomic `trySpend()` to prevent TOCTOU race conditions.
- SELL orders are exempt from spend limits (they return funds, not spend them).
- Limits are tracked per Discord user ID via Redis (with in-memory fallback).
- The bot owner (`OWNER_DISCORD_ID`) is exempt from spend limits for testing.

### 3. Market Validation
- Only allow trades on valid, active, and supported Polymarket markets.
- Reject trades on closed, paused, or unsupported markets.
- Validate market existence and status before any trade is executed.
- Timed up/down markets (BTC/ETH 5m/15m) are resolved by computing the current time-window slug.

### 4. Amount Validation
- Only accept trade amounts that are positive and meet the **$5 minimum** (Polymarket enforced).
- Reject zero, negative, or non-numeric amounts.
- BUY amounts must not cause the user to exceed their daily cap.
- For SELL orders, the amount represents shares to sell (not dollars).

### 5. AI Output Validation
- All AI agent outputs (intents and parameters) are strictly validated for correctness, completeness, and safety before execution.
- No action is taken on ambiguous, incomplete, or malformed AI outputs.
- Only whitelisted, explicitly supported intents are allowed (`place_bet`, `get_balance`, `get_trade_history`).
- A deterministic regex fallback handles common trade patterns without AI involvement.

### 6. Rate Limiting
- **Per-user cooldown**: 5-second minimum between Discord commands.
- **Message deduplication**: processed message IDs tracked to prevent double-execution.
- **Gemini key rotation**: rate-limited keys automatically disabled for 60s; up to 6 keys supported.
- Users exceeding cooldowns receive clear feedback.

### 7. Abuse Prevention
- Daily spend limits cap financial exposure per user.
- Cooldown enforcement prevents command spam.
- Auth server session store is size-capped (10,000 max) to prevent memory exhaustion.
- Expired sessions are purged every 5 minutes.

### 8. Logging and Auditability
- All trade executions are logged with order status, trade ID, and timestamp.
- Wallet addresses are **masked** in all log output (`0xf7eB…60aB` format).
- Order results are sanitized — only `status`, `success`, and `orderID` are logged.
- Error messages are truncated to 200 characters to prevent log injection.

### 9. Error Transparency to Users
- All errors (validation, limits, system failures) are communicated to users in clear, actionable language.
- Never expose sensitive system details, stack traces, or internal error codes to users.
- Distinct error messages for: invalid amount, market not found, market not active, rate limited, limit exceeded, upstream unavailable, internal error.

### 10. Search Pipeline Design Principles
- **Shared stopwords only**: All search paths use the single `COMMON_STOPWORDS` constant. Domain-specific terms (`game`, `match`, `win`, `score`) are NOT in the shared set — they are meaningful in sports/esports queries.
- **Parallel search**: Slug candidates and events `text_query` run concurrently via `Promise.all()`. Never run them sequentially.
- **TF-IDF scoring**: All result ranking uses IDF-weighted keyword matching. Rare keywords score higher than common ones.
- **Direct lookup first**: Polymarket URLs and condition IDs are resolved before any search logic runs.
- **AI for all queries ≥ 2 words**: AI keyword extraction and slug prediction is called for all non-trivial queries, including vs-queries. Only single-word queries bypass AI.
- **No early exits during search**: Multiple strategies are tried and their results merged. A single strategy returning results does NOT prevent others from running.
- **Conservative stopword removal**: When in doubt, do NOT add a word to the shared stopword list. False negatives (missing a result) are worse than false positives (extra noise in keywords).

---

## Security Rules (Enforced in Code)

### 10. Secret Management
- **Zero hardcoded secrets** — all credentials loaded exclusively from `process.env`.
- `.env` is in `.gitignore` and has been scrubbed from git history.
- `.env.example` documents all required/optional variables without real values.

### 11. Wallet & Address Security
- Wallet addresses are never displayed in full to Discord users — only short form (`0x1234...abcd`).
- Wallet addresses are masked in all server-side logs.
- Private keys are never logged, transmitted, or exposed in any output.
- Users can query any public wallet's balance/positions (read-only, no auth needed).

### 12. Trade Execution Security
- Orders use `SignatureType.POLY_GNOSIS_SAFE` (type 2) for Gnosis Safe proxy wallet signing.
- Fill-or-Kill (FOK) order type ensures complete fill or no execution.
- ethers v6 `_signTypedData` shimmed for CLOB client compatibility.
- All trades execute through the server-side leader wallet — user private keys are never involved.

---

## AI Agent: Forbidden Actions

The AI agent is NEVER allowed to:
- Execute trades, modify balances, or perform any state-changing action.
- Access, generate, or handle private keys, wallet credentials, or sensitive data.
- Bypass or override any system-enforced rules or limits.
- Return intents or parameters outside the explicitly supported set.
- Interact directly with external APIs or databases.

All AI output is treated as **untrusted input** and passes through deterministic validation.

---

## Discord Bot: Forbidden Actions

The Discord bot is NEVER allowed to:
- Store or transmit private keys, wallet credentials, or sensitive financial data in messages.
- Display full wallet addresses to users (use short form only).
- Bypass backend validation, limits, or safety checks.
- Log full API responses, system prompts, or unsanitized error objects.
- Execute more than one trade per user within the cooldown window.
- Allow spend-limit bypass through concurrent requests (atomic `trySpend` enforced).
