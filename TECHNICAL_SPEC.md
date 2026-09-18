# ProTrade Alpha — Technical Specification

Authoritative technical reference for **ProTrade Alpha** (GCP project `suhas-ag`): an autonomous,
**paper** EOD swing-trading system for NSE equities. This document describes the architecture,
Cloud Functions, gateway API, data model, strategies, scheduling, and integrations as implemented
in code.

- **Mode:** `MODE=PAPER_LIVE`, `PAPER_ONLY=true`, `TRADING_ENABLED=true` — **no real orders**.
- **Stack:** Firebase Cloud Functions (gen1, `nodejs22`) · Firestore (Native) · React/Vite dashboard · Kite Connect.
- **Region:** `us-central1` · **Timezone (schedules):** `Asia/Kolkata`.
- Companion docs: [AGENTS.md](AGENTS.md) (agent ops), [CONTEXT.md](CONTEXT.md) (live state),
  [blueprint.md](blueprint.md) (design), [STRATEGIES.md](STRATEGIES.md), [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 1. System overview

ProTrade runs a nightly loop: refresh the Kite session → fetch daily bars → fill the prior day's
next-open paper orders → compute features/indicators → detect market regime → evaluate strategy
signals → rank relative strength & correlation → size and place paper orders for the next open →
manage open positions to exit → report and notify.

Everything is driven through a **single HTTP gateway** function via `{ "action": "..." }` POST
bodies. Heavy per-symbol work fans out over **Cloud Tasks**. Scheduling is external
(**Cloud Scheduler** jobs that POST actions to the gateway).

```
Cloud Scheduler (cron, IST)
      │  POST {"action":"..."}
      ▼
 ┌──────────┐   Cloud Tasks (per-symbol fan-out)   ┌───────────────────┐
 │  gateway  │ ───────────────────────────────────▶│  processSymbolTask │
 │ (index.ts)│                                      └───────────────────┘
 └────┬─────┘   FETCH ▶ FILL ▶ FEATURES ▶ SIGNALS
      │         finalize: RS_RANK ▶ CORR ▶ ORDERS ▶ manage ▶ report ▶ digest
      ▼
  Firestore (Native)  ◀── all services read/write ──▶  Dashboard (suhas-ag.web.app)
```

---

## 2. Technical architecture

### 2.1 Components

| Component | Tech | Role |
|-----------|------|------|
| Gateway | Cloud Function (HTTPS) | Single entry point; routes every `action` to a service |
| Task workers | Cloud Functions (Task Queue) | Per-symbol and orchestration fan-out |
| Datastore | Firestore (Native) | Bars, features, signals, orders, portfolio, config, jobs |
| Scheduler | Cloud Scheduler | Cron jobs POST actions to the gateway |
| Dashboard | React + Vite (Firebase Hosting) | Ops UI, settings, monitoring |
| Market data / broker | Kite Connect (Zerodha) | Historical bars, quotes, session auth |
| Notifications | Telegram Bot API | Daily EOD digest |

### 2.2 Deployment shape (gen1 quirk)

Only **5 functions deploy** (see [firebase.json](firebase.json), `functions/package.json` `main = lib/index.js`):
`gateway`, `taskDispatcher`, `processSymbolTask`, `orchestrateEodTask`, `orchestrateDeepSyncTask`.

`functions.pubsub.schedule(...)` definitions compile but are **not** deployed by the Firebase CLI.
The real schedules are **Cloud Scheduler jobs** that POST `{"action":"..."}` to the gateway
(see §8). Always `npm run build` before deploy (no predeploy hook); deploy with `--force` to skip
the interactive Artifact Registry cleanup prompt.

### 2.3 EOD pipeline (per run)

1. **Dispatch** — `orchestrateEodTask` reads the hunt universe, seeds `jobs/{jobId}` with
   `counts.total`, and enqueues one `processSymbolTask` per symbol (serialized ~350 ms + jitter to
   respect the Kite 3 req/s limit). Metals ETFs are appended regardless of universe.
2. **Per-symbol stages** (`processSymbolTask`), each idempotent via `idempotency/{jobId}_{symbol}_{stage}`:
   - `FETCH` — strict-delta fetch of new daily bars (`lastBar+1 → runDate`).
   - `FILL` — (EOD only) fill the *previous* day's `ACCEPTED` paper orders at *today's* just-fetched open.
   - `FEATURES` — compute indicators for the day.
   - `SIGNALS` — evaluate strategies; write qualified signals + watchlist.
3. **Finalize** — once `counts.done + counts.failed >= counts.total`: `RS_RANK` → `CORR` →
   `ORDERS` (create next-day orders) → `manageTrades` (queue exits) → `generateJobReport` →
   `signalCritic` → **Telegram digest**.

### 2.4 Concurrency & idempotency guardrails

- **Kite rate limit:** ≤ 3 req/s per API key; fetches serialized at 350 ms + 0–500 ms jitter.
  Never `Promise.all()` Kite fetches.
- **One job at a time:** the gateway returns **409** if any `jobs` doc is `RUNNING`.
- **Idempotent stages:** sentinels in `idempotency/*` and `signals/{dateId}/status/*` make retries safe.
- **Fail-closed:** missing features/regime/correlation ⇒ reject the signal (never default permissive).

---

## 3. Cloud Functions

| Function | Trigger | Responsibility |
|----------|---------|----------------|
| `gateway` | HTTPS | Validate + route `{action}` (see [middleware.ts](functions/src/middleware.ts)); most logic lives behind it |
| `taskDispatcher` | Task Queue | Enqueue per-symbol tasks with pacing/retry |
| `processSymbolTask` | Task Queue | Per-symbol `FETCH ▶ FILL ▶ FEATURES ▶ SIGNALS` |
| `orchestrateEodTask` | Task Queue | EOD fan-out + finalize barrier |
| `orchestrateDeepSyncTask` | Task Queue | Historical/deep-sync fan-out (data only) |

Request validation and (optional) API-key auth are in [middleware.ts](functions/src/middleware.ts)
(`validateRequest` allow-list + `validateApiKey`; `SECURITY_CONFIG.REQUIRE_AUTH` gates the key).

---

## 4. Gateway API (actions)

All requests: `POST` JSON `{ "action": "<name>", ...params }` to the gateway URL. Actions must be
in the `KNOWN_ACTIONS` allow-list ([middleware.ts](functions/src/middleware.ts)).

### 4.1 Pipeline / jobs
| Action | Purpose |
|--------|---------|
| `startEod` | Kick off an EOD run |
| `startDeepSync` | Historical backfill / gap heal (`universe`, `days`; `days=0` = strict delta) |
| `terminate` | Force-fail a job (`jobId`) |
| `orchestrateEod` / `orchestrateDeepSync` / `processSymbol` | Internal orchestration entry points |
| `fetchCandles` · `computeFeatures` · `evaluateSignals` · `computeRsRanking` · `computeCorrTopN` · `manageTrades` | Single-stage manual triggers |

### 4.2 Scheduled entry points (called by Cloud Scheduler)
| Action | Purpose |
|--------|---------|
| `scheduledEod` | Holiday-guarded EOD run |
| `scheduledKiteRenew` | Kite session auto-renew (TOTP); `{manual:true}` bypasses the breaker |
| `scheduledScreen` | Rebuild `eligible`/`dynamic` universes (`source`) |
| `scheduledQuoteFill` | Batched-quote daily bar top-up (`universe`) |
| `scheduledMorning` | **Retired** (job deleted; fills run in the EOD `FILL` stage) |
| `startMorningExecution` | Legacy morning execution entry |

### 4.3 Kite session
| Action | Purpose |
|--------|---------|
| `getKiteSettings` | Masked creds + `status`/`lastError`/`lastAutoRenew`/`renewFailCount`/`autoRenewDisabled` |
| `updateCredentials` | Save creds (re-arms the auto-renew circuit breaker) |
| `updateToken` | Manual OAuth `request_token` → session |
| `validateTotpSecret` | **Offline** base32 check + local OTP (zero Kite attempts) |
| `checkHealth` | Live Kite `getProfile` health probe |

### 4.4 Universe & data
| Action | Purpose |
|--------|---------|
| `screenUniverse` | Prune source pool → `universes/eligible` (+ `dynamic`) |
| `buildNseUniverse` · `filterLiquidUniverse` | Build `allnse` / `liquidnse` from Kite instruments |
| `fillDailyQuotes` | Batched-quote bar top-up |
| `backfillHistorical` | Resumable historical backfill |
| `seedUniverse` | Seed universe members from CSV |
| `syncNseHolidays` · `syncCorporateEvents` | Calendar / corporate-action sync |

### 4.5 Fundamentals
`ingestFundamentals`, `syncFundamentals`, `getFundamentalsQuality`, `updateFundamentalsSettings`,
`getFundamentalsSettings` (EODHD-backed quality flags).

### 4.6 Ops / diagnostics / notifications
| Action | Purpose |
|--------|---------|
| `systemHealth` · `diagnostics` · `probeInventory` | Health & inventory snapshots |
| `auditJobs` · `auditSignals` · `sweepStuckJobs` · `getAlerts` | Job/signal audits, stuck-job sweep, alerts |
| `snapshot` · `downloadReport` · `watchlistStats` | Daily snapshot, run report, watchlist stats |
| `resetTradingState` · `cleanupStale` | State reset, retention cleanup |
| `getTelegramSettings` · `updateTelegram` · `testTelegram` · `sendDigest` | Telegram config + digest |

---

## 5. Services layer (`functions/src/services/`)

| Module | Responsibility |
|--------|----------------|
| `orchestrator.ts` | Job lifecycle, fan-out, stage barrier, finalize |
| `marketdata.ts` | Kite ingestion; strict-delta + deep-sync fetch; batched quotes; session update |
| `kite_automation.ts` | Headless TOTP login, auto-renew + circuit breaker, `validateTotpSecret` |
| `features.ts` | Per-symbol indicators (SMA/EMA/RSI/ATR/52w-high/RS inputs) |
| `regime.ts` | Market regime (index trend/breadth) |
| `strategy.ts` | SEPA + ATH-Pullback + Metals evaluators; VCP watchlist; legacy strategies (gated) |
| `rsRanking.ts` | Relative-strength ranking / `rsScore` percentile |
| `corrTopN.ts` | Correlation cap inputs (fail-closed) |
| `paperBroker.ts` | Order creation, slippage/fees, next-open fill simulation |
| `tradeManager.ts` | Exit management (stops, trailing lock, trend breaks) |
| `portfolioEquity.ts` | Derived equity (initial + Σrealized + Σ open MTM), position marks |
| `snapshot.ts` | Daily snapshot assembly + `formatSnapshotText` |
| `telegram.ts` | Telegram send + daily digest |
| `reporting.ts` · `journal.ts` · `aggregateStats.ts` | Run reports, daily analytics, stats |
| `signalCritic.ts` · `outcomeEvaluator.ts` | Signal QA + outcome scoring |
| `alerting.ts` | Alert records (`alerts` collection) |
| `calendar.ts` · `scheduler.ts` | Trading-day/holiday logic, schedule helpers |
| `universe.ts` · `universeScreen.ts` | Universe seeding + dynamic screener |
| `historicalBackfill.ts` · `barCache.ts` · `weeklyFeatureEngine.ts` | Backfill, bar caching, weekly bars |
| `fundamentals.ts` · `earningsQuality.ts` · `eodhdAdapter.ts` · `eventCalendar.ts` · `eventSync.ts` | Fundamentals + events |
| `reconciliation.ts` · `safety.ts` · `regCheck.ts` · `maintenance.ts` · `cleanupStale.ts` · `resetState.ts` | Reconciliation, staleness guards, rule validation, maintenance |
| `logger.ts` · `tasks.ts` · `diag.ts` | Structured logging, Cloud Tasks client, diagnostics |

---

## 6. Data model (Firestore, Native)

Document IDs use `YYYYMMDD` (`dateId`) for daily data. NSE symbols use the `.NS` suffix; metals
ETFs (`GOLDBEES`/`SILVERBEES`) are bare.

### 6.1 Market data
| Path | Contents |
|------|----------|
| `barsD/{symbol}` → `days/{YYYYMMDD}` | Daily OHLCV; parent doc: `lastUpdated`, `type` |
| `barsW/{symbol}` → `weeks/{weekId}` | Weekly bars (weekly feature engine) |
| `features/{symbol}` → `days/{dateId}` | Indicators + `rsScore`/`rsRank126`; parent doc: ATH/meta |

### 6.2 Signals & execution
| Path | Contents |
|------|----------|
| `regime/{dateId}` | Market regime for the day |
| `signals/{dateId}` → `items/{signalId}` | Evaluated signals; `status/{jobId_symbol}` = per-symbol sentinels |
| `watchlist/{dateId}` → `items/{SYM_strategy}` | Pre-breakout VCP watchlist (buy-ready) |
| `corrTopN/{dateId}` → `symbols/{symbol}` | Correlation inputs |
| `paperOrders/{dateId}` → `items/{orderId}` | Paper orders (ACCEPTED → FILLED) |
| `paperFills/{dateId}` → `items` | Fill records |

### 6.3 Portfolio & account
| Path | Contents |
|------|----------|
| `portfolio/default/positions/{symbol}` | Open/closed positions (`qty`, `avgEntryPrice`, `status`, `strategy`, `currentPrice`, `unrealizedPnl`, stop) |
| `portfolio/default/trades/{id}` | Realized-trade ledger |
| `config/account` | Account state incl. immutable `initialEquity` (equity is **derived**, not anchored) |

### 6.4 Universes & calendar
| Path | Contents |
|------|----------|
| `universes/{id}/members/{SYM}` | Members of `eligible`, `dynamic`, `nifty50/200/500`, `liquidnse`, `allnse` |
| `calendar/{dateId}` | `isTradingDay`, prev-trading-date links |
| `earnings/{symbol}` · `corporateActions/{symbol}` | Event calendar |

### 6.5 Jobs, config, ops
| Path | Contents |
|------|----------|
| `jobs/{jobId}` (+ `audit`, `reports/final`) | Job state: `type`, `stage`, `status`, `counts{total,done,failed}`, timestamps |
| `idempotency/{key}` | Stage-completion sentinels |
| `settings/kite` · `settings/telegram` · `settings/fundamentals` | Credentials/config (secrets never returned raw) |
| `alerts/{id}` · `critic/{dateId}` | Alerts + signal-critic results |
| `fundamentalsRaw/{symbol}` · `fundamentalsQuality/{symbol}` | Fundamentals |
| `logs/{dateId}/entries` · `system_errors` · `scheduler_log` | Structured logs |
| `journals/system/dailyReports/{dateId}` | Daily analytics journal |

---

## 7. Strategies

Live daily config runs on the hunt universe `eligible` plus the metals sleeve. Toggles in
[config/runtime.ts](functions/src/config/runtime.ts).

### 7.1 SEPA — `SepaBreakoutEOD` (equities, BUY)
Minervini trend-template + RS leadership + VCP breakout. Key gates (`SEPA_CONFIG`):
trend template (`close > SMA50 > SMA150 > SMA200`, 200-SMA rising), within `HI_PROX_ALIGNED` (25%)
of the 52-week high, **RS `rsScore ≥ RS_MIN_RATING` (70)** (falls back to `rsRank126 ≤ RS_TOP` on
warmup), VCP contraction/volume dry-up. Risk `RISK_PCT` 1.25%, hard stop 7%, trailing lock at +15%
(trail 20%), `MAX_POS` 10, equity-curve throttle at 6% drawdown. `IGNORE_REGIME_GATE` default ON
(paper study). Capital book `BOOK_PCT` 0.70.

### 7.2 ATH-Pullback — `ATHPullbackEOD` (equities, BUY) — default ON
Buys leaders near all-time highs on an orderly pullback into the 50-SMA buy zone (inverse of the
SEPA breakout). `ATH_CONFIG`: 3–15% below 52w-high, `RS_TOP` 60, support band around SMA50, RSI
40–58, 10% stop, risk 1%, `MAX_POS` 5. Shares the equity capital book with SEPA
(`EQUITY_STRATEGIES = ['SepaBreakoutEOD','ATHPullbackEOD']`). Disable with `ATH=0`.

### 7.3 Metals rotation — `MetalsRotation` (ETFs, BUY) — default ON
Trend-follower on `GOLDBEES`/`SILVERBEES` (`METALS_CONFIG`): trend gate `close > SMA200`, positive
risk-adjusted 126d momentum (skip 21d), `MAX_POS` 2, sleeve budget `ALLOC_PCT` 30%, wide 25% stop.
Exempt from equity liquidity/RS gates; appended to dispatch regardless of universe.

### 7.4 Legacy multi-strategy path
A dormant 6-strategy engine remains in `strategy.ts`, **gated OFF** by `SEPA_CONFIG.SEPA_ONLY`
(default ON). Set `SEPA_ONLY=0` to re-enable.

### 7.5 Capital & risk
Equity strategies share one book (`BOOK_PCT` 0.70); metals gets the rest (`ALLOC_PCT` 0.30) — the
buying-power gate caps combined gross deployed ≤ 100% (no implicit leverage). Equity is **derived**
(`initialEquity + Σrealized + Σ open MTM`), never anchored on `peakEquity`/`equity`.
`KILL_SWITCH` and `MAX_DAILY_NEW_ENTRIES` (5) are additional global guards.

---

## 8. Scheduling (Cloud Scheduler, Asia/Kolkata, Mon–Fri)

| Job | Cron | Action | Purpose |
|-----|------|--------|---------|
| `kite-auto-renew` | `30 8 * * 1-5` | `scheduledKiteRenew` | Renew Kite session (TOTP) before market data runs |
| `eod-scan` | `30 16 * * 1-5` | `scheduledEod` | Full EOD pipeline on `eligible` |
| `history-fill-500` | `30 18 * * 1-5` | `startDeepSync` (nifty500, `days=0`) | Strict-delta bar top-up for the screener source |
| `quote-fill` | `45 18 * * 1-5` | `scheduledQuoteFill` (liquidnse) | Cheap batched-quote daily top-up (all-NSE liquid pool) |
| `screen-universe` | `30 19 * * 1-5` | `scheduledScreen` (source=liquidnse) | Rebuild `eligible`/`dynamic` |
| `stale-cleanup` | `0 2 * * *` | `cleanupStale` | Retention cleanup (daily) |

Kite tokens expire daily ~07:30 IST, so `kite-auto-renew` (08:30) precedes the data jobs.
`morning-fill` (09:15) was retired and deleted — next-open fills run inside the EOD `FILL` stage.

---

## 9. Kite integration & session auth

- **Credentials + state** live in `settings/kite`: inputs `apiKey`, `apiSecret`, `userId`,
  `password`, `totpSecret` (base32 **seed**, not a 6-digit code); state `accessToken`, `status`,
  `lastError`, `lastAutoRenew`, `renewFailCount`, `autoRenewDisabled`.
- **Auto-renew** (`kite_automation.ts`): headless `api/login → api/twofa (TOTP) → OAuth redirect →
  request_token → generateSession` → fresh `accessToken`.
- **Circuit breaker:** after `KITE_MAX_RENEW_FAILURES` (default 2) consecutive failures,
  `autoRenewDisabled=true` + CRITICAL `SESSION_EXPIRED` alert; scheduled renew then skips (won't
  burn Kite attempts; Zerodha locks after ~5 fails). A manual renew (`{manual:true}`) bypasses it;
  success or `updateCredentials`/`updateToken` re-arms it.
- **Offline validation:** `validateTotpSecret` checks base32 format and generates the current OTP
  locally — **zero Kite attempts** — for compare-against-authenticator before a live renewal.
- **Fetch semantics:** no `forceDays` ⇒ strict delta (`lastBar+1 → runDate`, skips if current);
  `forceDays=N` ⇒ fixed N-day window. Tail gaps self-heal on the next EOD/fill; holes behind newer
  bars need `startDeepSync days=N`.

---

## 10. Notifications — Telegram daily digest

Sent once at **EOD finalize** (after `generateJobReport`) via `telegram.ts sendDailyDigest →
snapshot.ts formatSnapshotText`. **No-op unless `settings/telegram.enabled`**; EOD runs only.
Contents: critic health tag, equity/cash/deployed, realized/unrealized/total P&L, open positions
(entry→current, P&L, stop), and the day's signal/order/fill counts. Config via Dashboard → Settings;
bot token stored server-side and never logged/returned. Actions: `getTelegramSettings`,
`updateTelegram`, `testTelegram`, `sendDigest`. See [README](README.md#notifications--daily-telegram-digest).

---

## 11. Configuration reference ([config/runtime.ts](functions/src/config/runtime.ts))

| Key | Default | Meaning |
|-----|---------|---------|
| `MODE` | `PAPER_LIVE` | Operating mode |
| `PAPER_ONLY` / `TRADING_ENABLED` | `true` / `true` | Paper enforcement / master enable |
| `KILL_SWITCH` | `false` | Emergency halt on all new entries |
| `MAX_DATA_STALENESS_MINUTES` | `300` | Reject bars staler than this |
| `MAX_DAILY_NEW_ENTRIES` | `5` | Cap on new entries/day |
| `DEFAULT_UNIVERSE` | `eligible` | Hunt universe (env override) |
| `SEPA_CONFIG.SEPA_ONLY` | ON | Run SEPA path (else legacy) |
| `SEPA_CONFIG.RS_MIN_RATING` / `HI_PROX_ALIGNED` | `70` / `0.25` | RS gate / near-high band |
| `SEPA_CONFIG.RISK_PCT` / `HARD_STOP_PCT` / `MAX_POS` | `0.0125` / `0.07` / `10` | SEPA sizing/risk |
| `SEPA_CONFIG.BOOK_PCT` | `0.70` | Shared equity capital book |
| `ATH_CONFIG.ENABLED` | ON (`ATH=0` off) | ATH-Pullback sleeve |
| `METALS_CONFIG.ENABLED` / `ALLOC_PCT` / `MAX_POS` | ON / `0.30` / `2` | Metals sleeve |
| `KITE_MAX_RENEW_FAILURES` | `2` | Auto-renew circuit-breaker threshold (env) |
| `SECURITY_CONFIG.REQUIRE_AUTH` | (env) | Gateway API-key gate |

---

## 12. Build · test · deploy

```bash
cd functions
npm run build                 # tsc → lib/ (REQUIRED before deploy; no predeploy hook)
npx jest                      # full suite (297 tests / 26 suites)
npm run validate-rules        # static guardrail checks (regCheck.ts)
firebase deploy --only functions --project suhas-ag --force   # --force: skip AR cleanup prompt

# Dashboard
cd dashboard && npm run build && cd .. && firebase deploy --only hosting --project suhas-ag
```

Requires Node 22 (matches `engines.node` / the deployed `nodejs22` runtime).

---

## 13. Security

- **Paper-only:** no real orders (`PAPER_ONLY`, `MODE=PAPER_LIVE`).
- **Secrets** (Kite api key/secret, password, TOTP seed, Telegram bot token, OAuth refresh token):
  stored in Firestore `settings/*`; **never logged or returned raw** (`getKiteSettings`/
  `getTelegramSettings` mask them). Admin REST scripts mint short-lived OAuth tokens from the local
  Firebase CLI credentials.
- **Gateway** validates every action against an allow-list; optional API-key auth via
  `SECURITY_CONFIG.REQUIRE_AUTH`. CORS permits all origins for the dashboard.
- **Account safety:** offline TOTP validation + renewal circuit breaker prevent Zerodha lockout.
</content>
</invoke>
