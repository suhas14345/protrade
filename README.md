# ProTrade Alpha

Autonomous Indian‑equities **EOD swing‑trading** system. It fetches daily bars, hunts
signals, sizes and places **paper** orders, fills them at the next open, and manages
positions to exit — fully automated via Cloud Scheduler.

- **Stack:** Firebase Cloud Functions (gen1) · Firestore · React/Vite dashboard · Kite Connect
- **Live:** [suhas-ag.web.app](https://suhas-ag.web.app) · GCP project `suhas-ag` · region `us-central1`
- **Mode:** `PAPER_LIVE` / `PAPER_ONLY` — no real money is traded.

> **Live strategies today:** **SEPA** (Minervini‑style breakout, `SepaBreakoutEOD`) +
> **ATH‑Pullback** (buy leaders on a dip into support, `ATHPullbackEOD`) on equities, plus a 2‑ETF
> **Metals rotation** sleeve (`MetalsRotation` on `GOLDBEES`/`SILVERBEES`).
> A legacy 6‑strategy engine still exists in the code but is **gated OFF** by default
> (`SEPA_ONLY`). See [STRATEGIES.md](STRATEGIES.md).

## Architecture

```
Cloud Scheduler (cron, IST)
        │  POST {"action": "..."}
        ▼
   ┌──────────┐      Cloud Tasks       ┌──────────────────┐
   │ gateway   │ ───fan‑out per symbol─▶│ processSymbolTask │
   │ (index.ts)│                        └──────────────────┘
   └──────────┘   FETCH ▶ FILL ▶ FEATURES ▶ SIGNALS ▶ (finalize: RS ▶ CORR ▶ ORDERS)
        │
        ▼
   Firestore ◀── all services read/write ──▶ Dashboard (suhas-ag.web.app)
```

- **Single gateway** HTTP function routes every operation via a `{ "action": "..." }` POST body.
- **Orchestrator** fans work out to per‑symbol Cloud Tasks; a finalize step runs once all symbols report in.
- **Fills are folded into the EOD run** (the `FILL` stage) — each symbol fills the *previous*
  day's `ACCEPTED` orders at *today's* just‑fetched open, then hunts today for tomorrow.
- **Hunt universe:** `eligible` (`DEFAULT_UNIVERSE`, ~700 — the dynamic trend‑template pool the
  nightly screener prunes from `nifty500`/`liquidnse`; env `DEFAULT_UNIVERSE` overrides). If
  `eligible` is empty the hunt falls back to `nifty500`. **History‑fill universe:** `nifty500` (504).

## Daily automation (Cloud Scheduler, weekdays, Asia/Kolkata)

| Job | Schedule | Action | Purpose |
|-----|----------|--------|---------|
| `kite-auto-renew` | `30 8 * * 1-5` | `scheduledKiteRenew` | Headless Kite session renewal (TOTP) |
| `eod-scan` | `30 16 * * 1-5` | `scheduledEod` | Full EOD pipeline on **`eligible`** (fetch → fill → hunt) |
| `history-fill-500` | `30 18 * * 1-5` | `startDeepSync` (nifty500, `days=0`) | Strict‑delta history top‑up for the full 500 |
| `quote-fill` | `45 18 * * 1-5` | `scheduledQuoteFill` (liquidnse) | Cheap batched‑quote daily bar top‑up for the all‑NSE liquid pool |
| `screen-universe` | `30 19 * * 1-5` | `scheduledScreen` | Rebuild `eligible`/`dynamic` from the source pool |
| `stale-cleanup` | `0 2 * * *` | `cleanupStale` | Retention cleanup |

> The `.pubsub.schedule()` functions in `index.ts` are **not** deployed by the Firebase CLI
> (gen1 quirk). The real schedules are the Cloud Scheduler jobs above, which POST to the gateway.

## Notifications — daily Telegram digest

At the end of each **EOD run** (after `eod-scan` finalizes, ~16:30 IST) the system sends a plain‑text
**daily digest** to a Telegram chat. It's a **no‑op unless enabled** in Firestore `settings/telegram`,
and it only fires for EOD runs (not deep‑syncs). It summarizes account equity, P&L, open positions,
and the day's activity ([snapshot.ts](functions/src/services/snapshot.ts) `formatSnapshotText`).

Sample:

```
ProTrade snapshot — 20260918
Health [OK]

Equity ₹10,32,450 | Cash ₹4,10,000 | Deployed ₹6,22,450
Realized ₹12,300 | Unrealized ₹8,150
Total P&L ₹20,450

Active trades (2):
  CUPID.NS (SepaBreakoutEOD) x120 @ ₹412 -> ₹438  ₹3,120 (+6.3%)  stop ₹383
  GOLDBEES (MetalsRotation) x599 @ ₹126 -> ₹129  ₹1,797 (+2.4%)  stop ₹94

Today: 711 signals (12 approved; SepaBreakoutEOD:11, MetalsRotation:1), 3 orders, 2 entries / 1 exits filled
```

**Enable:** Dashboard → Settings → *Telegram Daily Digest* → paste bot token + chat ID → enable →
**Send Test**. Config is stored in `settings/telegram` `{botToken, chatId, enabled}`; the bot token is
kept server‑side and never displayed back. Manual resend: POST `{"action":"sendDigest"}` (optional `"date"`).
Gateway actions: `getTelegramSettings`, `updateTelegram`, `testTelegram`, `sendDigest`.

## Quick start

Prerequisites: Node 22 (matches `engines.node` / the deployed `nodejs22` runtime), Firebase CLI (`npm i -g firebase-tools`).

```bash
# Backend
cd functions && npm install && npm run build

# Dashboard
cd ../dashboard && npm install
```

### Deploy

```bash
# Functions — MUST build first; firebase.json has NO predeploy hook.
# --force skips the interactive Artifact Registry cleanup-policy prompt that otherwise hangs the deploy.
cd functions && npm run build && cd .. && firebase deploy --only functions --project suhas-ag --force

# Dashboard
cd dashboard && npm run build && cd .. && firebase deploy --only hosting --project suhas-ag
```

Only 5 functions deploy: `gateway`, `taskDispatcher`, `processSymbolTask`, `orchestrateEodTask`, `orchestrateDeepSyncTask`.

### Trigger an EOD run

```bash
curl -X POST https://us-central1-suhas-ag.cloudfunctions.net/gateway \
  -H "Content-Type: application/json" \
  -d '{"action":"scheduledEod"}'
```

### Tests

```bash
cd functions && npx jest            # 297 tests across 26 suites
npm run validate-rules              # static rule/guardrail checks
```

## Project structure

```
protrade/
├── functions/                      # Firebase Cloud Functions (TypeScript)
│   ├── src/
│   │   ├── index.ts                # Single gateway entry point (all actions)
│   │   ├── config/runtime.ts       # RUNTIME/SEPA/METALS config + all thresholds
│   │   ├── services/
│   │   │   ├── orchestrator.ts     # EOD/deep‑sync fan‑out + per‑symbol FETCH▶FILL▶FEATURES▶SIGNALS
│   │   │   ├── strategy.ts         # SEPA + Metals evaluators (+ dormant legacy strategies)
│   │   │   ├── marketdata.ts       # Kite ingestion; strict‑delta + deep‑sync fetch
│   │   │   ├── paperBroker.ts      # order placement, slippage/fees, open‑fill simulation
│   │   │   ├── features.ts, regime.ts, rsRanking.ts, corrTopN.ts
│   │   │   ├── tradeManager.ts, historicalBackfill.ts, cleanupStale.ts, resetState.ts
│   │   │   └── ...                 # alerting, calendar, reporting, diag, etc.
│   │   └── backtest/               # emulator‑replay backtester (see its README)
│   └── .agent/workflows/           # agent workflows (regression‑first)
├── dashboard/                      # React + Vite SPA
├── firebase.json
├── ind_nifty{50,200,500}list.csv   # NSE universe constituent lists
└── *.md                            # docs (see below)
```

## Documentation

| File | Contents |
|------|----------|
| [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) | **Full technical spec** — architecture, functions, gateway API, data model, strategies, config |
| [AGENTS.md](AGENTS.md) | **Agent context** — tooling, deploy, schedulers, universes, gotchas |
| [CONTEXT.md](CONTEXT.md) | Live system state + operational setup (auth, universes, data) |
| [STRATEGIES.md](STRATEGIES.md) | Current live strategies (SEPA + Metals) and the dormant legacy set |
| [blueprint.md](blueprint.md) | Architecture reference + Firestore schema |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |
| [functions/src/backtest/README.md](functions/src/backtest/README.md) | Backtest/replay engine design |

## Key design decisions

- **No predeploy hook** — always `npm run build` before `firebase deploy`, or you ship stale JS.
- **Gen1 functions** — v2/`pubsub.schedule` schedules aren't discovered by the CLI; Cloud Scheduler POSTs to the gateway instead.
- **Paper‑first** — every trade is paper until a broker adapter is swapped in.
- **Fail‑closed risk** — missing data rejects a signal rather than defaulting to permissive.
- **Fill‑in‑EOD** — next‑open fills run inside the evening EOD (after the bar exists), not a pre‑open job.
