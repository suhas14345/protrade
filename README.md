# ProTrade Alpha

Autonomous Indian equities EOD swing-trading system. Generates signals, manages paper positions, and tracks performance — fully automated via Cloud Scheduler.

**Stack**: Firebase Cloud Functions (gen1) · Firestore · React/Vite dashboard · Kite Connect  
**Live**: [suhas-ag.web.app](https://suhas-ag.web.app) · Project `suhas-ag`

## Architecture

```
Cloud Scheduler (cron)
        │
        ▼
   ┌─────────┐       ┌───────────┐
   │ Gateway  │──────▶│Orchestrator│──▶ Fetch ▶ Features ▶ RS Rank ▶ Regime
   │(index.ts)│       │           │──▶ Signals ▶ Risk/Corr ▶ Orders ▶ Fills
   └─────────┘       └───────────┘
        │                                │
        ▼                                ▼
   Dashboard ◀───── Firestore ◀──── All services write here
```

- **Single gateway** Cloud Function routes all actions via `{ "action": "..." }` POST body
- **Stage-barrier orchestrator** runs stages sequentially: FETCH → FEATURES → RS_RANK → REGIME → SIGNALS → RISK → ORDERS
- **6 strategies**: PullbackEOD, BreakoutCloseEOD, MeanReversionEOD, ShortBounceEOD, BearBounceEOD, RSLeaderEOD
- **13-gate risk pipeline**: regime, RS filter, gap risk, drawdown, vol-targeting, ADV, gap stress, sector caps, correlation clusters, etc.

## Quick Start

### Prerequisites
- Node.js v20+
- Firebase CLI: `npm install -g firebase-tools`

### Setup
```bash
# Backend
cd functions && npm install && npm run build

# Dashboard
cd ../dashboard && npm install
```

### Deploy
```bash
# Functions (MUST build first — no predeploy hook)
cd functions && npm run build && cd .. && firebase deploy --only functions

# Dashboard
cd dashboard && npm run build && cd .. && firebase deploy --only hosting
```

### Trigger an EOD Run
```bash
curl -X POST https://us-central1-suhas-ag.cloudfunctions.net/gateway \
  -H "Content-Type: application/json" \
  -d '{"action":"startEod","universe":"nifty500"}'
```

### Run Tests
```bash
cd functions && npx jest --verbose   # 86 tests across 10 suites
```

## Project Structure

```
protrade/
├── functions/                 # Firebase Cloud Functions (TypeScript)
│   ├── src/
│   │   ├── index.ts           # Single gateway entry point (24+ actions)
│   │   ├── middleware.ts       # Auth, rate limiting, validation
│   │   ├── config/runtime.ts   # All trading parameters & thresholds
│   │   ├── models/index.ts     # Firestore document types
│   │   └── services/           # 25+ service modules
│   │       ├── orchestrator.ts # Stage-barrier EOD pipeline
│   │       ├── strategy.ts     # 6 strategy evaluators + 13-gate risk
│   │       ├── marketdata.ts   # Kite Connect data ingestion
│   │       ├── features.ts     # Technical indicator computation
│   │       ├── regime.ts       # Market regime detection
│   │       ├── rsRanking.ts    # Relative strength ranking (0-99)
│   │       ├── paperBroker.ts  # Slippage, fees, fill simulation
│   │       ├── tradeManager.ts # Order → fill → position lifecycle
│   │       └── ...             # alerting, calendar, corrTopN, etc.
│   └── package.json
├── dashboard/                 # React + Vite SPA
│   └── src/App.tsx            # 4 tabs: Dashboard, History, Logs, Settings
├── firebase.json              # Hosting + Functions + Emulator config
└── *.md                       # Documentation
```

## Documentation

| File | Contents |
|------|----------|
| [blueprint.md](blueprint.md) | Architecture, data flow, Firestore schema |
| [STRATEGIES.md](STRATEGIES.md) | All 6 strategies with gates and thresholds |
| [CONTEXT.md](CONTEXT.md) | Current system state and known issues |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |

## Daily Automation

Two Cloud Scheduler jobs drive the system (weekdays IST):

| Job | Schedule | Action |
|-----|----------|--------|
| `kite-auto-renew` | `30 8 * * 1-5` | `scheduledKiteRenew` — headless Kite login via TOTP |
| `daily-eod` | `45 15 * * 1-5` | `scheduledEod` — full pipeline (kill switch + session check first) |

## Key Design Decisions

- **No predeploy hook**: `npm run build` (tsc) must run manually before `firebase deploy`
- **Gen1 functions**: v2 `onSchedule` not discovered by CLI; scheduler uses gateway HTTP POST
- **Paper-first**: All trades are paper until broker adapter is swapped
- **Fail-closed risk**: Missing data → reject signal (never default to permissive)
