# System Context — ProTrade Alpha V3.1

## Current State

| Component | Status | Notes |
|-----------|--------|-------|
| Gateway (index.ts) | ✅ Live | 24+ actions, single HTTPS endpoint |
| Orchestrator | ✅ Live | Stage barriers, idempotency, 30min timeout |
| Market Data (Kite) | ✅ Live | Kite Connect primary, session management |
| Features Pipeline | ✅ Live | EMA, RSI, ATR, BB, VDU, gap risk, liquidity |
| RS Ranking | ✅ Live | 0-99 percentile across universe |
| Regime Detection | ✅ Live | 5 states, 3-bar hysteresis, breadth confirm |
| Strategy Engine | ✅ Live | 6 strategies (bull + bear + neutral) |
| Risk Pipeline | ✅ Live | 13 gates, fail-closed correlation |
| Paper Broker | ✅ Live | Slippage model, Indian fees, gap-through-stop |
| Dashboard | ✅ Live | 4 tabs (Dashboard, History, Logs, Settings) |
| Settings Tab | ✅ Live | Kite credentials, auto-renewal test |
| Scheduler Actions | ✅ Deployed | scheduledKiteRenew, scheduledEod in gateway |
| Cloud Scheduler | ⚠️ Not Created | Jobs need manual setup in GCP Console |
| Kite Auto-Renewal | ⚠️ TOTP Issue | Correct TOTP secret (base32 seed) needed |
| Tests | ✅ 86 pass | 10 suites, all green |

## Deployment

- **Project**: suhas-ag
- **Region**: us-central1
- **Gateway**: `https://us-central1-suhas-ag.cloudfunctions.net/gateway`
- **Dashboard**: `https://suhas-ag.web.app`
- **Node runtime**: 20

## Architecture

- Firebase Cloud Functions gen1 (single `gateway` HTTPS function, 540s timeout)
- Firestore for all persistent state
- React + Vite SPA on Firebase Hosting
- Kite Connect for market data and broker API
- Cloud Scheduler (HTTP POST to gateway) for daily automation

## Known Issues

1. **Cloud Scheduler not created** — Two cron jobs needed in GCP Console:
   - `kite-auto-renew`: `30 8 * * 1-5` Asia/Kolkata → `{"action":"scheduledKiteRenew"}`
   - `daily-eod`: `45 15 * * 1-5` Asia/Kolkata → `{"action":"scheduledEod"}`

2. **Kite TOTP secret** — Auto-renewal fails. User must provide the base32 seed string from Kite's 2FA setup (not the 6-digit code). Account may be locked after failed attempts.

3. **No gcloud CLI** — Cannot create scheduler jobs programmatically; must use GCP Console.

4. **Calendar collection** — `CalendarService.syncFromIndexData()` not yet seeded; fallback to numeric date subtraction (fragile for weekends/holidays).

5. **Node 20 deprecation** — Runtime deprecates 2026-04-30; plan upgrade.

## Critical Build Requirement

`firebase.json` has NO `predeploy` hook. Always run:
```bash
cd functions && npm run build && cd .. && firebase deploy --only functions
```
Forgetting `npm run build` deploys stale JavaScript.
