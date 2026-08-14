# HANDOFF — Backtest engine + Kite TOTP fixes (resume from here)

**Date:** 2026-08-14
**Repo:** `suhas14345/protrade` (private) — working copy at `c:\openapi\protrade`
**Goal driving this work:** Build a *faithful* historical backtest/walk-forward engine that
reuses the REAL strategy/risk/regime/fill logic so **backtest and live cannot diverge**. This
is the critical missing piece for evaluating the user's revised target of **40%+/yr** returns.

---

## 1. TL;DR — what is DONE vs PENDING

### DONE (committed to working tree, compiles clean — `npx tsc` exit 0)
- **Backtest engine** built under `functions/src/backtest/` (5 modules + README + validation).
- **Pure-logic validation PASSED** — 20/20 checks via `node lib/backtest/validate.js`
  (metrics math + deterministic synthetic generator). No Firebase needed for this.
- **Kite TOTP fixes** applied:
  - (a) `middleware.ts` `checkKiteHealth` doc-path bug fixed (`config/kiteSession` → `settings/kite`).
  - (b) `index.ts` new native `scheduledKiteRenew` pubsub schedule (auto-provisions Cloud Scheduler on deploy).
- **Dependencies installed** (`functions/node_modules`, 780 pkgs) after a flaky-registry fight.

### PENDING (blocked on infra or user action — pick up here)
1. **Full emulator replay run** — BLOCKED on this machine by missing `firebase-tools` +
   only Java 8 present (emulator needs Java 11+). See §5. This is the next concrete step.
2. **Increment 2: real Kite historical backfill** — needs the user's interactive Kite login
   (never store/log apiKey/apiSecret/TOTP). See §6.
3. **Survivorship bias** — backtest uses *today's* universe membership, not point-in-time.
   Results will read optimistic until point-in-time membership is sourced. See §7.
4. **(Optional) Live equity-loop fix** — see §4 CRITICAL BUG. The backtest works around it,
   but LIVE still has it. Recommend fixing in `paperBroker`/`aggregateStats`.
5. **(Optional) Native schedules for EOD + morning** — only `scheduledKiteRenew` was made
   native; EOD/morning still rely on manually-created GCP Scheduler jobs (see index.ts comment).

---

## 2. Files created / changed in THIS session

### New — backtest engine (`functions/src/backtest/`)
| File | Purpose |
|------|---------|
| `metrics.ts` | Pure metrics: CAGR, Sharpe, Sortino, max drawdown, MAR, win%, profit factor, expectancy, `formatReport`. No Firebase deps. |
| `syntheticData.ts` | Deterministic (mulberry32) OHLCV generator + `tradingDates()` weekend-skip. For engine validation without broker data. |
| `seed.ts` | `seedBacktest()` writes calendar (reuses `CalendarService.seedCalendar`), `universes/{id}/members`, `config/account`, `barsD/{sym}/days` (incl. `^NSEI`). Accepts optional real `bars` map for Increment 2. |
| `engine.ts` | `runReplay()` — the synchronous day-by-day driver + cash/PnL ledger + equity write-back. Sets `RUNTIME_CONFIG.MODE='REPLAY'`. |
| `run.ts` | CLI: seed → replay → metrics. HARD emulator guard (refuses non-local `FIRESTORE_EMULATOR_HOST`). |
| `validate.ts` | Standalone 20-check validation of metrics + generator. Run `node lib/backtest/validate.js`. |
| `README.md` | Design rationale, the equity-loop finding, honest caveats. |

### Changed — Kite TOTP
| File | Change |
|------|--------|
| `functions/src/middleware.ts` | `checkKiteHealth` now reads `settings/kite` (was never-written `config/kiteSession`); added `status==='ERROR'` check. NOTE: this fn is currently UNUSED (gateway wires the marketdata.ts version) — correctness hygiene only. |
| `functions/src/index.ts` | Added `export const scheduledKiteRenew = functions.runWith(v1Options).pubsub.schedule('30 8 * * 1-5').timeZone('Asia/Kolkata').onRun(...)` calling `autoRenewKiteSessionHandler`. Replaced the old "create Scheduler manually" comment (kept EOD/morning note). |

---

## 3. Backtest architecture (WHY it is built this way)

- The live pipeline dispatches per-symbol work through **Cloud Tasks**
  (`taskClient.enqueueDispatch('processSymbolTask', ...)`), which the **local emulator does
  not execute**. So a faithful backtest **cannot** just call `runEodLogic`.
- Trading logic is **~85% coupled to Firestore** reads/writes → pure extraction rejected.
- **Chosen path = emulator-replay hybrid:** run against the Firestore emulator and call the
  REAL stage functions **synchronously, in the orchestrator's order**, bypassing only the
  async queue. This reuses 100% of decision + fill math (zero divergence).

**Per-day stage order in `engine.ts runReplay()`** (matches the orchestrator):
```
doOpenFillSimulation(each sym)   // fills PREVIOUS day's ACCEPTED orders at today's OPEN
applyFills(...)                  // (backtest-only) reconcile fills into cash ledger + closed trades
doManageTrades(dateId, jobId)    // mark positions vs today's CLOSE -> queues exits for tomorrow
doComputeFeatures(^NSEI + each)  // features
doComputeRegime(...)             // regime (TREND/RANGE/BEAR/HIGH_VOL/TRANSITION)
doComputeRsRanking(...)          // relative-strength ranks
doEvaluateSignals(each sym)      // signals + 13-gate risk approval
doPlaceOrders(dateId, jobId)     // approved signals -> ACCEPTED entry orders (fill tomorrow at open)
markToMarket(...)                // (backtest-only) equity = cash + open MTM at close
// then write equity/peakEquity/equityEMA25/portfolioRealizedVol back to config/account
```

**Real stage function signatures (verified):**
- `features.ts` `doComputeFeatures(jobId, symbol, runDate)`
- `regime.ts` `doComputeRegime(date, jobId?, providedIndexSymbol?, universeId='nifty500')`
- `rsRanking.ts` `doComputeRsRanking(dateId, jobId?, universeId='nifty500')`
- `strategy.ts` `doEvaluateSignals(jobId, symbol, runDate, forceRegime?, universeId='nifty500')`
- `tradeManager.ts` `doManageTrades(dateId, jobId)`
- `paperBroker.ts` `doPlaceOrders(dateId, jobId?)` and `doOpenFillSimulation(jobId, runDate, symbol)`

**Firestore data shapes the seeder writes:**
- `calendar/{dateId}`: `{ dateId, isTradingDay, tradingIndex, prevTradingDateId? , nextTradingDateId? }`
- `universes/{universeId}/members/{symbol}`: doc id === symbol (index `^NSEI` excluded from members)
- `config/account`: `{ equity, baseRiskPct:0.005, maxOpenRiskR:6, maxPositions:10, strategyRiskWeights{...}, peakEquity }`
- `barsD/{symbol}/days/{dateId}`: `{ open, high, low, close, volume, dateId, timestamp(Timestamp) }`
- Index symbol is **`^NSEI`** (constant `INDEX_SYMBOL` in `seed.ts`).

**Runtime toggles relevant to replay** (`config/runtime.ts`): `RUNTIME_CONFIG.MODE` set to
`'REPLAY'` by the engine (disables market-hours guard in orchestrator + staleness in safety.ts).
`TRADING_ENABLED=true`, `KILL_SWITCH=false` already.

---

## 4. CRITICAL BUG discovered (affects LIVE, not just backtest)

**Account equity is never updated from realized P&L.**
- `paperBroker.doOpenFillSimulation` marks exited positions `CLOSED` and records the exit fill,
  but **never computes realizedPnl into `config/account.equity`**.
- `aggregateStats.updateEquityCurve()` merely **snapshots** the static seeded equity
  (`1000000`, from `maintenance.ts seedConfig`).
- **Consequence in LIVE:** the drawdown circuit-breaker (`strategy.ts computeDrawdownMultiplier`,
  halts at 20% DD) and the vol-targeting gate see a **flat equity curve / DD always 0** →
  effectively dead code.

The **backtest closes this loop itself** (cash ledger + mark-to-market + daily write-back of
`equity/peakEquity/equityEMA25/portfolioRealizedVol`). **Recommend applying the same fix to
LIVE** so those risk gates actually function. The fee/slippage model IS real and good
(`paperBroker computeSlippageBps` + `computeFeeEstimate` = full Indian STT/stamp/GST/brokerage
+ sqrt market-impact slippage).

---

## 5. HOW TO RUN THE FULL REPLAY (the immediate next step)

Prereqs this machine is MISSING (install on the resume machine):
- **firebase-tools** (`npm i -g firebase-tools` or add as devDep) — NOT installed here, not a dep.
- **Java 11+** — only `jdk1.8.0_491` (Java 8) is present; the Firestore emulator needs 11+.
  Point `JAVA_HOME` at a JDK 11/17 before starting the emulator.

Steps:
```powershell
cd c:\openapi\protrade\functions
npm run build                                   # tsc -> lib/
# terminal A: start ONLY the firestore emulator (port 8081 per firebase.json)
firebase emulators:start --only firestore
# terminal B: run the backtest against the emulator
node lib/backtest/run.js --start 2023-01-01 --end 2024-01-01 --warmup 130 --symbols 8 --clear
```
CLI flags (`run.ts`): `--start --end --warmup <days> --symbols <n> --equity <inr> --universe <id> --clear`.
The runner sets `FIRESTORE_EMULATOR_HOST=localhost:8081` and hard-refuses any non-local host.

**Expected first result:** a metrics report (CAGR/Sharpe/maxDD/win%/PF). With SYNTHETIC data
this only proves the MACHINERY (replay + PnL + metrics reconcile) — it says NOTHING about edge.

If features throw "insufficient data": increase `--warmup` (needs ≥25 bars; 130 gives EMA/RS
stability) or widen the date range so warm-up < trading days.

---

## 6. Increment 2 — real Kite historical backfill (needs USER)

- Swap synthetic bars for real history by passing a `bars` map (keyed by symbol + `^NSEI`) to
  `seedBacktest({ ..., bars })`. Shape per bar matches `SyntheticBar` in `syntheticData.ts`.
- Source: Kite `getHistoricalData` (see `marketdata.ts fetchFromKite` for the existing call
  pattern + instrument-token lookup via `getNSEInstrumentsMap`). ~40 min for 5yr × 500 symbols.
- **Requires interactive Kite login.** NEVER store/log apiKey/apiSecret/TOTP. The auto-renew
  path (`kite_automation.ts`) can mint an access token into `settings/kite`; a backfill script
  can then read it. Alternatively do a one-off manual login.

---

## 7. Honest framing (carry this forward — user demands intellectual honesty)

- Better data/backtesting makes the TEST trustworthy; it will NOT by itself turn ~13% into 40%.
- Steady 40%/yr exceeds nearly every documented track record (Renaissance Medallion ~39% net is
  the ceiling). Honest expectation: **15–25%/yr avg across a cycle, 25–40% drawdowns, occasional
  40%+ years.** Measure, don't assert.
- **Survivorship bias is PRESENT and unaddressed** — the tradable set is today's Nifty 500, not
  point-in-time membership. Flag this in any result summary.
- Grounded facts that hold: momentum premium is real (AQR: 212 yrs, 40 countries; Jegadeesh-
  Titman ~1%/mo) but crashes hard (−73% in 2009); most day traders lose (Brazil study: 97% lose
  over 300+ days). Retracted earlier folklore (specific champion return figures, "80% is
  psychology" stats) as unverified.

---

## 8. Reference baseline (sm-experiment, superseded but useful)

Separate Python prototype at `c:\openapi\sm-experiment`. Best in-sample result (to sanity-check
against): **MA 50/200 cross** — 870 trades, 45.3% win, PF 2.42, Sharpe 1.01, CAGR 13.5%,
MaxDD −19.6%, TotRet 266.1%, MAR 0.69. Run: `py tools/run_all_strategies.py --universe nifty500 --start 2015-01-01`.

---

## 9. Environment gotchas

- Node here is **v24** (package.json engines wants 20 → warns only, builds fine).
- Corporate npm registry `artifacts.mastercard.int` is **flaky** — installs time out. If deps go
  missing: kill node procs, `Remove-Item node_modules -Recurse -Force`, then
  `npm install --fetch-timeout=600000 --fetch-retries=8 --fetch-retry-maxtimeout=180000 --no-audit --no-fund`.
- `protrade` is OUTSIDE the VS Code workspace (workspace = `sm-experiment`), so the workspace
  grep/file tools can't see it — use terminal `Select-String` / read files by absolute path.
- Build script is plain `tsc` (`npm run build`); outputs to `functions/lib/`.

---

## 10. ⚠️ TRANSFER TO THE OTHER MACHINE (do this FIRST or work is lost)

All changes are **uncommitted** in the working tree at `c:\openapi\protrade`. To resume
elsewhere you MUST move them across. Two options:

**Option A — git (recommended):** from this machine, commit + push, then pull on the other.
```powershell
cd c:\openapi\protrade
git add functions/src/backtest functions/src/index.ts functions/src/middleware.ts HANDOFF_BACKTEST.md
git commit -m "Add faithful backtest engine + Kite TOTP scheduled renew + health-check doc-path fix"
git push        # confirm branch/remote first: git status ; git remote -v
```
> NOTE: `functions/lib/**` also shows as modified — that is compiled `tsc` output (the repo
> tracks `lib/`). You can include it or just rebuild on the other side with `npm run build`.
> Do NOT commit `functions/node_modules` (should be gitignored).

**Option B — no git:** copy the source files listed in §2 (`functions/src/backtest/*`,
`functions/src/index.ts`, `functions/src/middleware.ts`, `HANDOFF_BACKTEST.md`) to the same
paths on the other machine, then `cd functions && npm install && npm run build`.

On the resume machine, `npm install` in `functions/` is required (node_modules is not transferred).

---

## 11. Quick resume checklist for the next agent

1. Read this file + `functions/src/backtest/README.md`.
2. Confirm build: `cd functions; npm run build` (should be exit 0).
3. Confirm pure logic: `node lib/backtest/validate.js` (expect ALL CHECKS PASSED).
4. Install `firebase-tools` + a JDK 11/17, set `JAVA_HOME`.
5. Run the emulator replay (§5). Verify equity curve + metrics reconcile on synthetic data.
6. Then Increment 2 (real Kite data, §6) with the user present for login.
7. Consider the LIVE equity-loop fix (§4) and native EOD/morning schedules (§1 item 5).
