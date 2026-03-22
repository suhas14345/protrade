================================================================================
TRADING SYSTEM SOFTWARE BLUEPRINT V2.1
Long‑Only Equities • EOD Swing • 500+ Symbols • Paper‑First • Firestore • No Pub/Sub
================================================================================

0) PURPOSE & PRINCIPLES
----------------------
Goal:
Build a professional, rules-driven swing-trading platform that runs end-of-day (EOD),
generates next-session (T+1) entry plans, enforces portfolio risk/correlation controls,
models real execution (gaps/slippage) in paper trading, and is live-ready by swapping
only the broker adapter.

Core principles:
1) Trade only when the market regime is favorable for long-only systems.
2) Enforce portfolio-level risk (heat) and diversification (sector + correlation clusters).
3) Make paper trading harsh and realistic (slippage, gap-through-stop).
4) Maintain deterministic, reproducible runs (idempotency + audit trail).
5) Keep architecture simple: Scheduler + Orchestrator + Cloud Tasks + Firestore (no Pub/Sub).

Scope:
- Data cadence: daily bars (plus optional weekly aggregation for bias).
- Execution style: EOD decisions, next session entries.
- Universe: 500+ liquid equities (NSE/BSE).
- Mode: fully automated, start with paper broker, later swap to Zerodha execution.

Non-goals (avoid early):
- High-frequency intraday trading
- Dozens of indicators/ML models
- Pub/Sub event architecture (explicitly excluded)


1) HIGH‑LEVEL SYSTEM FLOW
------------------------
Daily EOD pipeline (after market close):
A) Fetch latest daily bars for universe (rolling window + archive).
B) Compute features (EMA/RSI/ATR/structure/liquidity/returns).
C) Compute market regime + breadth (long-only gating + risk multipliers).
D) Generate candidate signals (EOD setups).
E) Portfolio & risk approval (position sizing + caps + correlation clusters).
F) Create paper orders for next day open (NEXT_OPEN plan).
G) Write immutable journal records and run summary.

Next morning pipeline (after market open):
H) Simulate fills for NEXT_OPEN orders (with slippage + gaps).
I) Update positions and trades.
J) Evaluate exits (stop/target/time/thesis-break) and simulate exit fills as needed.

Key concept:
- Orchestrator drives stages in a strict order; each stage is idempotent and resumable.


2) ARCHITECTURE (NO PUB/SUB)
----------------------------
2.1 Components (Cloud Run/Functions)
- orchestrator-service
  Owns run state machine, creates tasks, monitors completion, advances stages.

- universe-service
  Maintains symbol list, metadata (sector, liquidity bucket), token mapping.

- marketdata-service
  Fetches daily candles, validates data quality, stores rolling window.

- feature-engine
  Computes indicators, structure, liquidity metrics, returns.

- regime-breadth-engine (long-only critical)
  Classifies market regime and breadth; outputs tradeAllowed + risk multipliers + limits.

- strategy-engine
  EOD setups (trend pullback, breakout close), produces signals with "why" and checklist.

- portfolio-risk-engine
  Portfolio heat, max positions, sector caps, correlation cluster caps, adaptive sizing.
  Approves/rejects signals and creates orders.

- paper-broker-service
  Simulates orders/fills with harsh reality (gaps/slippage/fees), updates positions/trades.

- journal-analytics-service
  Immutable audit logging + daily/weekly analytics + adherence.

2.2 Scheduling
- Cloud Scheduler triggers orchestrator via HTTP:
  POST /run/eod?date=YYYY-MM-DD
  POST /run/open-sim?date=YYYY-MM-DD
  POST /run/healthcheck?date=YYYY-MM-DD (optional)

2.3 Parallelism without Pub/Sub
- Use Cloud Tasks queues (fan-out) per stage:
  fetch_candles_queue
  compute_features_queue
  compute_corrtopn_queue
  evaluate_signals_queue
  risk_approve_queue
  open_fill_sim_queue
  exit_sim_queue

Fan-out/fan-in mechanism:
- Orchestrator enqueues tasks in chunks (e.g., 25–50 symbols per task).
- Each task writes status to Firestore: jobs/{jobId}/tasks/{taskId}.
- Orchestrator periodically checks completion counts and advances stage when done.

Idempotency:
- Each task uses deterministic doc IDs or idempotency keys derived from:
  (runDate + stage + chunkId + versionHash)
- Re-running does not duplicate results.

Rate limiting:
- marketdata-service must throttle API calls (e.g., token bucket), as historical API calls
  are rate-limited in practice; design for safe requests/sec. (Kite forum indicates 3 rps
  guidance for historical data usage.)


3) ZERODHA INTEGRATION NOTES (LATER LIVE)
-----------------------------------------
This system is paper-first. Live integration is by swapping broker adapter.

Data:
- Historical daily candles are fetched via Kite historical endpoint
  GET /instruments/historical/:instrument_token/:interval with interval=day.

Orders:
- Kite supports order placement by variety including amo and regular.

GTT:
- Kite supports GTT triggers, including two-leg (OCO) behavior.
  (Optional later if you want server-side triggers for swing.)

Auth:
- Kite auth uses login redirect to obtain request_token and exchange it at /session/token
  for access_token; api_secret must not be exposed client-side.

Plan dependency:
- Zerodha support notes market data (live + historical) is included with paid Kite Connect,
  and not included with Personal API.


4) STORAGE DESIGN (FIRESTORE + CLOUD STORAGE)
----------------------------------------------
4.1 Storage strategy for 500+ symbols
- Firestore stores:
  universe metadata, rolling daily bars (last 300–800 days), features, regime, corrTopN,
  signals, orders, fills, positions, trades, journals, and run/job metadata.

- Cloud Storage stores:
  bulk historical bars and backtest artifacts (compressed per symbol or per month).
  Firestore keeps pointers/checksums to GCS objects.

4.2 Firestore collections (recommended)
A) Run tracking
- jobs/{jobId}
- jobs/{jobId}/tasks/{taskId}

B) Universe
- universes/{universeId}
- universes/{universeId}/members/{symbol}

C) Rolling bars
- barsD/{symbol}/days/{yyyyMMdd}
  (Keep last 300–800 daily docs; archive older to GCS)

D) Features
- features/{symbol}/days/{yyyyMMdd}

E) Market regime + breadth
- regime/{yyyyMMdd}

F) Correlation Top-N (avoid NxN matrix explosion)
- corrTopN/{yyyyMMdd}/symbols/{symbol}

G) Signals
- signals/{yyyyMMdd}/items/{signalId}

H) Paper orders + fills
- paperOrders/{yyyyMMdd}/items/{orderId}
- paperFills/{yyyyMMdd}/items/{fillId}

I) Portfolio
- portfolio/{userId}
- portfolio/{userId}/positions/{symbol}

J) Trades + journal
- trades/{userId}/items/{tradeId}
- journals/{userId}/items/{entryId}

4.3 Document shapes (key ones)

jobs/{jobId}
{
  runDate, type (EOD_RUN|OPEN_SIM_RUN),
  stage (FETCH|FEATURES|REGIME|CORR|SIGNALS|RISK|ORDERS|DONE),
  status (RUNNING|FAILED|DONE),
  counts {total, done, failed},
  startedAt, updatedAt,
  versionHash (for reproducibility)
}

features/{symbol}/days/{yyyyMMdd}
{
  ema20, ema50, rsi14, atr14, atrPct,
  trendState (UP|DOWN|RANGE),
  swing {lastSwingHigh, lastSwingLow},
  srZones [{low, high, strength}],
  returns {ret1d, ret5d, ret20d},
  liquidity {medVol20, medTradedValue20, bucket},
  computedAt
}

regime/{yyyyMMdd}
{
  marketState (TREND|RANGE|HIGH_VOL|TRANSITION),
  tradeAllowed (bool),
  riskMultiplier (0..1),
  maxNewPositions (int),
  minSignalScore (int),
  notes,
  breadth {
    pctAboveEMA50, pctAboveEMA200,
    newHighs20, newLows20
  }
}

signals/{yyyyMMdd}/items/{signalId}
{
  symbol,
  direction (BUY only in long-only),
  strategy (PullbackEOD|BreakoutCloseEOD),
  score (0..100),
  entryPlan {type:NEXT_OPEN},
  stopPrice,
  targets [target1, target2...],
  rr,
  checklist { ... booleans ... },
  reasons { ... key values ... },
  status (NEW|APPROVED|REJECTED|ORDERED|IN_TRADE|DONE)
}

paperOrders/{yyyyMMdd}/items/{orderId}
{
  symbol, side (BUY), orderType (NEXT_OPEN),
  intendedQty,
  intendedEntryRef (OPEN),
  createdFromSignalId,
  risk {plannedR, riskAmount, stopDistance},
  status (CREATED|ACCEPTED|FILLED|CANCELLED|REJECTED)
}

paperFills/{yyyyMMdd}/items/{fillId}
{
  orderId, symbol, fillPrice, fillQty,
  slippageBps, feeEstimate,
  fillType (ENTRY|EXIT_STOP|EXIT_TARGET|EXIT_TIME|EXIT_THESIS),
  timestamp
}


5) MARKET DATA INGESTION (EOD, 500+ SYMBOLS)
--------------------------------------------
5.1 Daily sync strategy
- Fetch last 5–10 trading days per symbol daily to handle corrections.
- Validate per symbol:
  - missing dates
  - zero volume anomalies (if unexpected)
  - extreme candle ranges vs ATR (outliers)
- Store:
  - Firestore rolling window (barsD)
  - Cloud Storage archive (optional but recommended)

5.2 Initial backfill strategy
- Download in chunks per symbol (e.g., 1 year blocks).
- Write to GCS as compressed files.
- Compute features incrementally (only keep rolling windows + latest snapshots in Firestore).

5.3 Idempotency for ingestion
- Use doc IDs like yyyyMMdd so re-writes overwrite safely.
- Store a checksum (e.g., hash of OHLCV) to detect changes.


6) FEATURE ENGINE (TECHNICAL + STRUCTURE)
-----------------------------------------
For each symbol and each new date:
Compute:
- EMA20, EMA50
- RSI14
- ATR14 and ATR%
- Trend state (UP/DOWN/RANGE) using:
  - price relative to EMA50
  - EMA50 slope sign/magnitude
- Market structure swings:
  - swing highs/lows using fractal window (k=2..5)
- Support/resistance zones:
  - cluster recent swing points into zones (strength by touch count + recency)
- Returns for correlation and risk:
  - ret1d, ret5d, ret20d
- Liquidity proxies:
  - median volume 20d, median traded value 20d (= close*vol)
  - liquidity bucket A/B/C based on traded value percentile


7) REGIME + BREADTH ENGINE (LONG‑ONLY CRITICAL)
-----------------------------------------------
Purpose:
Long-only systems require market gating to avoid broad drawdowns and correlation spikes.

7.1 Inputs
- Market index proxy derived from:
  (a) actual index bars if available, or
  (b) universe equal-weight aggregate (median/mean return series)
- Volatility via ATR% percentile on index proxy
- Breadth from universe:
  - pctAboveEMA50
  - pctAboveEMA200
  - newHighs20 vs newLows20 (counts across universe)

7.2 Classification (simple, robust)
- TRANSITION:
  if marketState changed in last N days OR volatility shock (ATR% jump > threshold)
  => tradeAllowed = false for cooldown window (3–5 days)

- HIGH_VOL:
  if ATR% percentile > 80th (configurable)
  => tradeAllowed true but riskMultiplier 0.25–0.5 and maxNewPositions reduced

- RANGE/CHOP:
  if EMA slopes flat and breadth weak/neutral
  => tradeAllowed true but minSignalScore raised and maxNewPositions reduced

- TREND:
  if index proxy above EMA200 and breadth strong
  => tradeAllowed true, riskMultiplier 1.0, normal limits

7.3 Outputs used by risk engine
- tradeAllowed
- riskMultiplier
- maxNewPositions
- minSignalScore


8) STRATEGY ENGINE (EOD SETUPS, LONG‑ONLY)
------------------------------------------
Strategy A: Trend Pullback EOD (primary)
Entry conditions (example rules):
- Trend aligned:
  - close > EMA50
  - EMA50 slope positive
  - RSI regime supportive (e.g., RSI > 50)
- Pullback:
  - price pulled back into EMA20/EMA50 zone
  - near S/R support zone (from srZones)
- Confirmation (EOD):
  - bullish rejection / strong close (configurable)
- Plan:
  - entry NEXT_OPEN (T+1 open)
  - stop below recent swing low or below support zone
  - targets ensure RR >= 2.0 (first target at 2R, optional runner)

Strategy B: Breakout Close EOD (secondary)
Entry conditions:
- Range identified over N days (tight consolidation)
- EOD close above range high
- Optional: volume expansion proxy vs 20d median volume
- Plan:
  - entry NEXT_OPEN
  - stop below breakout level or range midpoint
  - targets RR >= 2.0 with trailing option if trend strong

Signal scoring:
- Combine confluences into score 0..100:
  trend strength + location quality + breadth alignment + liquidity + volatility suitability
- Apply minSignalScore from regime engine.

Output:
- Create signals docs with checklist + reasons + score.


9) PORTFOLIO & RISK ENGINE (PRO-GRADE, LONG‑ONLY)
-------------------------------------------------
9.1 Hard gates
- If regime.tradeAllowed == false => reject all new entries.

9.2 Adaptive position sizing
Base:
- baseRiskAmount = equity * baseRiskPct (e.g., 0.5%)

Multipliers:
- regimeMultiplier (from regime engine; 0..1)
- drawdownMultiplier (from equity curve)
  DD < 5% => 1.0
  5–10% => 0.75
  10–15% => 0.5
  >15% => 0.25 or stop new entries

Final:
- riskAmount = baseRiskAmount * regimeMultiplier * drawdownMultiplier

Sizing:
- qty = floor(riskAmount / abs(entryPriceAssumption - stopPrice))

Note:
- For NEXT_OPEN, entryPriceAssumption = lastClose or modelled open estimate.

9.3 Portfolio heat controls
- maxOpenPositions (e.g., 12–18)
- maxTotalOpenRiskR (e.g., 4R)
- maxNewPositionsPerDay = regime.maxNewPositions

9.4 Sector exposure caps
- maxSectorExposurePct (e.g., 25% of portfolio value)
- sector exposure computed from current positions + proposed order

9.5 Correlation/cluster caps (critical for 500+)
- Use corrTopN lists with 60-day lookback
- Define cluster membership:
  candidate is in same cluster as any held position if corr > 0.75
- Enforce:
  - maxPositionsPerCluster (e.g., 2–3)
  - maxClusterRiskR (e.g., 1.5R)

9.6 Liquidity gating
- Reject symbols below minimum median traded value threshold
- Optionally raise slippage model for liquidity bucket B/C

9.7 Gap-risk gating (without earnings feed)
Compute per symbol "gap risk score":
- For last N days:
  gap = abs(open - prevClose) / ATR
- If gapRiskPercentile > threshold => reduce size or reject
This protects long-only from overnight gap disasters.

Approval output:
- APPROVED signals become paper orders for NEXT_OPEN.
- Store rejection reasons in signals for auditability.


10) PAPER BROKER (HARSH REALITY MODE)
-------------------------------------
Purpose:
Paper results must approximate live behavior; avoid perfect fills.

10.1 Entry fill model for NEXT_OPEN
At next day open:
- baseFill = openPrice
- slippageBps = f(liquidityBucket, atrPct, regimeState)
- fillPrice = baseFill * (1 + slippageBps/10000) for BUY
- record slippage and fees

10.2 Gap-through-stop
If open gaps below stop (for long position):
- stop executes at open (worse than stop), plus slippage
- realize loss > planned R
- record "gapStop" in fill metadata

10.3 Exit simulation events
- stop loss: if low breaches stop => exit at stop ± slippage;
  if open gaps through stop => exit at open ± slippage
- target: if high reaches target => exit at target ± slippage
- time stop: if daysInTrade >= N and MFE < threshold => exit at next open
- thesis break: if close < key level (e.g., EMA50 or support zone) => exit next open

10.4 Fees
- Configurable estimate (brokerage + taxes + impact)
- Store in fill records so net P&L is realistic.

10.5 Broker adapter contract
BrokerAdapter:
  placeOrder(orderIntent) -> orderAck
  cancelOrder(orderId)
  getOrderStatus(orderId)
  getPositions()

Implementations:
- PaperBrokerAdapter (now)
- ZerodhaBrokerAdapter (later)


11) EXIT LOGIC (MINIMAL BUT ROBUST)
-----------------------------------
Long-only swing exits (recommended minimal set):
1) Initial stop beyond structure.
2) Time stop:
   - if trade does not reach +0.5R within 10 trading days => exit next open.
3) Structure trailing:
   - once trade reaches +1R, trail stop to last swing low (or EMA20/EMA50 depending on rules).
4) Thesis break:
   - if EOD close breaks key support or EMA50 with bearish structure => exit next open.
Optional:
5) Partial at 1R and trail remaining runner.

Keep exits deterministic and consistent across backtests and paper sim.


12) SAFETY, RELIABILITY, OBSERVABILITY
--------------------------------------
Kill switches (runtime config):
- TRADING_ENABLED (false stops all order creation)
- PAPER_ONLY (true prevents real broker execution)
- MAX_DAILY_NEW_ENTRIES override (emergency throttle)

Circuit breakers:
- If data stale or missing for index proxy OR >X% universe symbols missing bars => block run.
- If abnormal slippage spikes (indicates data issue) => block new entries.
- If portfolio drawdown breaches hard limit => stop new entries and optionally reduce exposure.

Idempotency:
- Each stage writes outputs with deterministic IDs.
- Orchestrator can resume from last completed stage.
- Cloud Tasks retries safe due to overwrite semantics.

Auditability:
- Every signal stores "why" (feature snapshot) and checklist results.
- Every rejection stores the exact reason(s).
- Every fill stores slippage/fees and whether it was gap-through-stop.

Monitoring:
- Dashboard derived from Firestore:
  - job stage latency and failures
  - number of signals generated/approved/rejected
  - exposure by sector/cluster
  - equity curve, drawdowns, expectancy
  - regime performance breakdown


13) IMPLEMENTATION PHASES (PAPER-FIRST)
---------------------------------------
Phase 0 (2–3 days):
- Firestore schema, orchestrator skeleton, Cloud Scheduler, Cloud Tasks queues, universe import.

Phase 1 (1 week):
- marketdata-service with throttled fetching + QA, rolling Firestore storage, optional GCS archive.

Phase 2 (1 week):
- feature engine + regime/breadth engine + basic reports.

Phase 3 (1–2 weeks):
- strategy engine + portfolio/risk engine including sector + corrTopN clusters + adaptive sizing.

Phase 4 (1 week):
- paper broker harsh fill simulation + exits + full trade lifecycle + journal analytics.

Phase 5 (later, live readiness):
- Zerodha auth + execution adapter (AMO), shadow mode (signals compare), then limited live rollout.


14) DEFAULT PARAMETERS (SANE STARTING POINTS)
---------------------------------------------
Universe:
- 500–800 liquid equities

Lookbacks:
- Bars: 300–800 daily bars (rolling)
- Correlation: 60 trading days
- Gap risk: 60–120 days

Risk:
- baseRiskPct: 0.5%
- maxOpenPositions: 12–18
- maxTotalOpenRiskR: 4R
- maxSectorExposurePct: 25%
- corrThreshold: 0.75
- maxPositionsPerCluster: 2–3
- maxClusterRiskR: 1.5R

Regime:
- transitionCooldownDays: 3–5
- highVolAtrPctile: 80th
- highVolRiskMultiplier: 0.25–0.5
- rangeMinSignalScore uplift: +10 to +20

Exits:
- timeStopDays: 10
- timeStopMFE: +0.5R
- trailActivation: +1R

Paper execution realism:
- slippageBps buckets:
  A (high liquidity): 2–8 bps
  B (mid): 5–20 bps
  C (low): 10–40 bps
- add regime multiplier to slippage in HIGH_VOL
