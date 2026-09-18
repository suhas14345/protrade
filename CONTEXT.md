# Live System State & Setup — ProTrade Alpha

Current operational state of the production system and how it's wired. For architecture see
[blueprint.md](blueprint.md); for agent context see [AGENTS.md](AGENTS.md).

_Last verified: 2026‑08‑17._

## Deployment

| | |
|---|---|
| GCP project | `suhas-ag` |
| Region | `us-central1` |
| Node runtime | 20 |
| Gateway | `https://us-central1-suhas-ag.cloudfunctions.net/gateway` |
| Dashboard | `https://suhas-ag.web.app` |
| Deployed functions | `gateway`, `taskDispatcher`, `processSymbolTask`, `orchestrateEodTask`, `orchestrateDeepSyncTask` |

Runtime flags (`config/runtime.ts`): `MODE=PAPER_LIVE`, `PAPER_ONLY=true`, `TRADING_ENABLED=true`,
`KILL_SWITCH=false`.

## Strategies (live)

- **SEPA** (`SepaBreakoutEOD`) — Minervini‑style trend breakout. `SEPA_CONFIG.SEPA_ONLY` is ON
  (env `SEPA_ONLY=0` falls back to the dormant legacy 6‑strategy engine). `MAX_POS=10` leaders.
- **Metals rotation** (`MetalsRotation`) — `GOLDBEES` / `SILVERBEES` momentum sleeve.
  `METALS_CONFIG.ENABLED` ON, `MAX_POS=2`, `ALLOC_PCT=0.30`.

See [STRATEGIES.md](STRATEGIES.md) for the full gate/exit specification.

## Universes

| Universe | Members | Role |
|----------|---------|------|
| `eligible` | ~700 | **Hunt** universe (`DEFAULT_UNIVERSE`) — EOD + morning evaluate signals here; rebuilt nightly by the screener |
| `nifty500` | 504 | **History‑fill** + screener source — daily strict‑delta top‑up |
| `dynamic` | ~50 | Smaller top‑momentum cut of `eligible` (screener output) |
| `liquidnse` | ~1.7k | All‑NSE liquid pool (being adopted as the screener source) |
| `nifty200` / `nifty50` | 200 / 52 | Legacy index sets (nifty50 incl. metals ETFs); no longer the hunt universe |

The hunt runs on `eligible`, which the nightly **screener** (`screenUniverse` / `universeScreen.ts`)
prunes from the source pool (`nifty500`, moving toward `liquidnse`). If `eligible` is empty the hunt
falls back to `nifty500`. Members: `universes/{id}/members/{SYM.NS}`. Metals bars are stored under
`barsD/GOLDBEES` and `barsD/SILVERBEES` (no `.NS`).

## Cloud Scheduler jobs (weekdays, Asia/Kolkata)

| Job | Schedule | Body | State |
|-----|----------|------|-------|
| `kite-auto-renew` | `30 8 * * 1-5` | `{"action":"scheduledKiteRenew"}` | ENABLED |
| `eod-scan` | `30 16 * * 1-5` | `{"action":"scheduledEod"}` | ENABLED |
| `history-fill-500` | `30 18 * * 1-5` | `{"action":"startDeepSync","universe":"nifty500","days":0}` | ENABLED |
| `screen-universe` | `30 19 * * 1-5` | `{"action":"scheduledScreen"}` | ENABLED |
| `stale-cleanup` | `0 2 * * *` | `{"action":"cleanupStale"}` | ENABLED |
| `morning-fill` | `15 9 * * 1-5` | `{"action":"scheduledMorning"}` | **PAUSED** (retired) |

`history-fill-500` uses `days=0` = **strict delta** (fetches each symbol from its last stored
bar → today), so it self‑heals gaps of any length instead of a fixed 5‑day window. It runs at
18:30 (after the 16:30 EOD) to avoid the single‑running‑job 409.

## Daily cycle

```
08:30  kite-auto-renew   → refresh Kite session
16:30  eod-scan (eligible):
         per symbol: FETCH today's bar
                   → FILL  prior‑day ACCEPTED orders at today's OPEN   ← next‑open fills land here
                   → FEATURES → SIGNALS
         finalize: RS_RANK → CORR → ORDERS (create tomorrow's orders)
18:30  history-fill-500  → strict‑delta top‑up of all 504 (feeds the screener)
02:00  stale-cleanup     → retention
```

Fills are **inside** the EOD run because the day's bar only exists after the fetch; the old
09:15 morning job ran before the bar was available and left orders stranded `ACCEPTED`.

## Data coverage

- Equities: ~2019‑01 → present (~7.6 yr daily bars).
- `GOLDBEES`: ~2015‑01 → present; `SILVERBEES`: ~2022‑02 → present (real ETF‑age limits).
- 494/498 nifty500 non‑subset symbols current; 4 fail Kite instrument‑token resolution
  (`AKZOINDIA`, `GSPL`, `GUJGASLTD`, `JBCHEPHARM`) — renamed/mismatched tickers.

## Auth for admin/REST scripts

Firestore & Cloud Scheduler REST calls need a Google OAuth access token minted from the local
Firebase CLI credentials (`~/.config/configstore/firebase-tools.json`, `tokens.refresh_token`)
against `https://oauth2.googleapis.com/token`. Tokens last ~1 hour. **Never commit or log** the
client secret, refresh token, or any Kite credential/TOTP seed.

## Critical build requirement

`firebase.json` has **no** `predeploy` hook — always:

```bash
cd functions && npm run build && cd .. && firebase deploy --only functions --project suhas-ag
```

Forgetting `npm run build` ships stale JavaScript.
