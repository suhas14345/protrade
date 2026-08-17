# Backtest / walk-forward engine (`functions/src/backtest`)

A **faithful** historical backtester for protrade. It reuses the *exact* production
stage functions (features, regime, RS ranking, signals, risk gates, paper broker,
trade manager) so **backtest and live cannot diverge**.

## Why this design (emulator-replay hybrid)

The trading logic is ~85% coupled to Firestore reads/writes, and the live pipeline
dispatches per-symbol work through **Cloud Tasks** (`taskClient.enqueueDispatch`),
which the local emulator does not execute. So the engine:

1. Runs against the **Firestore emulator** (never production — the runner hard-guards this).
2. Calls the real stage functions **synchronously, in the orchestrator's order**,
   bypassing only the async task queue:

   `doOpenFillSimulation` → `doManageTrades` → `doComputeFeatures` (index + each symbol)
   → `doComputeRegime` → `doComputeRsRanking` → `doEvaluateSignals` → `doPlaceOrders`.

That reuses 100% of the decision + fill math while replacing only the plumbing.

## The equity-loop fix (important)

While building this I found that production code **never writes realised P&L back
into `config/account.equity`** — `aggregateStats.updateEquityCurve()` only snapshots
the static seeded value. Consequence in live: the **drawdown circuit-breaker** and
**volatility-targeting** gates never see real equity movement (drawdown reads as 0).

The engine therefore closes the loop itself: a cash ledger tracks every fill, open
positions are marked to market at each close, and `equity / peakEquity / equityEMA25 /
portfolioRealizedVol` are written back to `config/account` each day so the risk gates
respond correctly during replay. **Consider applying the same fix to live.**

## Files

| File | Role |
|------|------|
| `metrics.ts` | Pure metrics: CAGR, Sharpe, Sortino, max drawdown, win %, profit factor, expectancy. No Firebase deps. |
| `syntheticData.ts` | Deterministic OHLCV generator for engine validation (no broker data needed). |
| `seed.ts` | Seeds calendar, universe members, `config/account`, and `barsD` into the emulator. |
| `engine.ts` | The synchronous day-by-day replay driver + cash/P&L loop + equity write-back. |
| `run.ts` | CLI: seed → replay → metrics report. |

## Running (Increment 1 — synthetic validation, no credentials)

```powershell
cd functions
npm run build
# In another terminal: start the Firestore emulator
firebase emulators:start --only firestore    # or: npm run serve
# Then:
node lib/backtest/run.js --start 2023-01-01 --end 2024-01-01 --warmup 130 --symbols 8 --clear
```

Synthetic data only proves the **machinery** (replay + P&L + metrics reconcile).
It says nothing about real edge.

## Increment 2 — real-edge validation (needs Kite login)

Swap synthetic bars for a real Kite historical backfill by passing a `bars` map to
`seedBacktest(...)` (keyed by symbol and `^NSEI`). This requires an interactive Kite
login; the API key/secret/TOTP are never stored or logged.

## Honest caveats

- **Survivorship bias**: the tradable set is today's membership, not point-in-time.
  Real backtests will read optimistic until point-in-time membership is sourced.
- `event-calendar` is not seeded, so the earnings-block gate fails open (no blocks).
- Trades are recorded per exit fill (a partial + final exit count as two records).
- Better data makes the *test* trustworthy; it does not by itself raise returns.
