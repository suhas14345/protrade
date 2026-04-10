================================================================================
PROTRADE ALPHA — SYSTEM BLUEPRINT V3.1
Long + Short Equities • EOD Swing • 500+ Symbols • Paper-First • Firestore
6 Strategies • Bear Market Capable • Automated via Cloud Scheduler
================================================================================


0) SYSTEM OVERVIEW
------------------
Autonomous Indian equities EOD swing-trading system.

  - Firebase Cloud Functions gen1 (single "gateway" HTTPS function) + Firestore
  - React/Vite dashboard on Firebase Hosting
  - Kite Connect for market data and broker integration
  - GCP project: suhas-ag
  - Dashboard: https://suhas-ag.web.app
  - Gateway:   https://us-central1-suhas-ag.cloudfunctions.net/gateway

Core principles:
  1) Trade long AND short depending on regime — 6 strategies cover all conditions.
  2) Enforce portfolio-level risk (heat) and diversification (sector + correlation clusters).
  3) Make paper trading harsh and realistic (slippage, gap-through-stop, Indian fees).
  4) Maintain deterministic, reproducible runs (idempotency + audit trail).
  5) Keep architecture simple: single gateway + Cloud Tasks + Firestore (no Pub/Sub).
  6) Automated end-to-end: Cloud Scheduler triggers Kite renewal and daily EOD run.

Scope:
  - Data cadence:     daily bars (EOD)
  - Execution style:  EOD decisions, next-open (T+1) entries
  - Universe:         500+ liquid NSE equities
  - Mode:             paper-first, live-ready by swapping broker adapter
  - Short selling:    supported via ShortBounceEOD strategy (BEAR/HIGH_VOL regimes)


1) HIGH-LEVEL SYSTEM FLOW
-------------------------
Daily EOD pipeline (after 15:45 IST market close):
  A) Fetch latest daily bars for universe            (FETCH stage)
  B) Compute features per symbol                     (FEATURES stage)
  C) Compute RS ranking across all symbols            (RS_RANK stage)
  D) Detect market regime + breadth                   (REGIME stage)
  E) Evaluate signals — 6 strategies per symbol       (SIGNALS stage)
  F) Risk approval — 13 gates per signal              (RISK stage)
  G) Compute correlation top-N                        (CORR stage)
  H) Create paper orders for next-open                (ORDERS stage)

Next morning pipeline (after market open):
  I)  Simulate fills for NEXT_OPEN orders (slippage + gaps)
  J)  Create positions from filled orders
  K)  Trade manager: update stops, check exits, close positions

Key concept:
  - Orchestrator enforces strict stage barriers with fan-out/fan-in.
  - Every stage is idempotent and resumable via sentinel docs.


2) GATEWAY PATTERN (index.ts)
-----------------------------
Single HTTPS Cloud Function with 540s timeout.
All operations via POST body: { "action": "...", ...params }

Request flow:
  CORS → Rate limit (60/min/IP) → API key auth → Action validation
  → Kill switch check → Dispatch to handler

Known actions (24+):
  startEod              Start EOD pipeline run
  startDeepSync         Historical data backfill
  terminate             Kill a running job
  fetchCandles          Fetch OHLCV bars for a symbol
  computeFeatures       Compute indicators for a symbol
  evaluateSignals       Run strategy evaluation for a symbol
  computeRsRanking      RS ranking pass across universe
  computeCorrTopN       Correlation top-N for a symbol
  manageTrades          Daily trade management (exits, stops)
  processSymbol         Per-symbol pipeline dispatch
  orchestrateEod        Internal orchestration handler
  orchestrateDeepSync   Internal deep sync handler
  diagnostics           System diagnostics report
  checkHealth           Health check
  updateToken           Update Kite OAuth access token
  updateCredentials     Store Kite API credentials
  seedUniverse          Import universe members
  systemHealth          Detailed system health report
  sweepStuckJobs        Clean up stuck/stale jobs
  getAlerts             Retrieve system alerts
  probeInventory        Probe portfolio inventory
  auditJobs             Audit job history
  downloadReport        Download analytics report
  scheduledKiteRenew    Automated Kite session renewal (scheduler)
  scheduledEod          Automated daily EOD run (scheduler)
  getKiteSettings       Retrieve Kite configuration

Kill switch blocks these actions:
  startEod, orchestrateEod, evaluateSignals, manageTrades

PAPER_ONLY enforcement:
  Forces paperOnly:true on all order-creating actions.


3) MIDDLEWARE (middleware.ts)
----------------------------
  validateRequest()   — checks action string against KNOWN_ACTIONS whitelist
  validateApiKey()    — reads config/apiKey from Firestore; matches x-api-key header
                        REQUIRE_AUTH=false by default (for development)
  checkRateLimit()    — sliding window, 60 requests per 60 seconds per IP
  checkKiteHealth()   — verifies config/kiteSession accessToken exists and not expired


4) ORCHESTRATION (orchestrator.ts)
----------------------------------
4.1 doStartEodRun()
  - Creates Job doc in jobs/{jobId}
  - Fans out per-symbol processing via Cloud Tasks
  - Stage barriers enforce strict ordering:
      FETCH(all) → FEATURES(all) → RS_RANK → REGIME → SIGNALS → RISK/CORR → ORDERS

4.2 Idempotency
  - Sentinel docs: signals/{dateId}/status/{jobId_symbol} prevent duplicate processing
  - Each stage writes with deterministic IDs (jobId + symbol + stage)
  - Re-running a stage safely overwrites existing results

4.3 Circuit breaker
  - If >20% of symbols fail in any stage → abort entire run
  - Max 3 retries per symbol per stage, then mark FAILED
  - Job timeout: 30 minutes auto-fail for stuck jobs

4.4 doStartDeepSync()
  - Historical data backfill mode
  - Fetches extended bar history for all universe symbols


5) DATA PIPELINE
----------------

5.1 Market Data (marketdata.ts)
  - Primary source: Kite Connect historical API (doFetchCandles)
  - Storage: barsD/{symbol}/days/{dateId} — OHLCV candles
  - Kite session management: updateToken (OAuth flow), updateKiteCredentials
  - NSE instrument token mapping from Kite instruments file
  - Market hours guard: rejects EOD runs before 15:45 IST

5.2 Features (features.ts)
  - doComputeFeatures(): computes per-symbol technical indicators
  - Output: features/{symbol}/days/{dateId}
  - Indicators computed:
      EMA20, EMA50, EMA200
      RSI14
      ATR14
      Bollinger Bands (20-period, 2 std dev)
      Swing highs and lows
      Support/resistance zones
      Volume SMA20
  - Derived fields:
      20-day and 60-day returns (for RS ranking input)
      VDU flag (Volume Dry-Up — 3+ declining volume bars on pullback)
      Gap risk score (historical gap frequency normalized by ATR)
      Liquidity bucket: A (>50M INR median traded value),
                        B (10M-50M), C (<10M)

5.3 RS Ranking (rsRanking.ts)
  - doComputeRsRanking(): ranks all universe symbols on 0-99 scale
  - Composite score: weighted blend of 20-day + 60-day return percentile
  - Writes rsScore to each features/{symbol}/days/{dateId} doc
  - Writes universe median returns to regime/{dateId} doc

5.4 Regime Detection (regime.ts)
  - doComputeRegime(): classifies current market state
  - States: TREND | RANGE | HIGH_VOL | TRANSITION | BEAR
  - Inputs:
      Nifty50 EMA slopes
      Breadth: pctAboveEMA50 across universe
      VIX proxy
  - Hysteresis: requires 3 consecutive bars to confirm regime change
  - Breadth confirmation:
      TREND requires >55% of universe above EMA50
      BEAR  requires <35% of universe above EMA50
  - Output: regime/{dateId}

5.5 Correlation (corrTopN.ts)
  - computeCorrTopN(): stores top-20 most correlated peers per symbol
  - Used by risk approval for correlation cluster enforcement


6) STRATEGIES (strategy.ts)
---------------------------
6 strategies evaluated per-symbol per-day. All generate NEXT_OPEN entry plans.
Each strategy has regime gates, technical gates, and per-strategy scoring.

6.1 PullbackEOD (BUY)
  Regime:     TREND or RANGE
  Gates:
    - ema20 > ema50
    - ATR-normalized EMA touch (within 0.3 ATR of EMA20 or in EMA band)
    - RSI in regime-aware range (TREND: 38-58, RANGE: 40-55)
    - VDU active (hard gate — must show volume dry-up)
  Exit plan:  stop 2.0x ATR, target 3.0x ATR, max 7 days, trailing stop
  Scoring:    min score 55, RS threshold 60-100

6.2 BreakoutCloseEOD (BUY)
  Regime:     TREND only
  Gates:
    - ema20 > ema50
    - Close above 20-day high
    - Volume > SMA20
    - Consolidation check (5+ low-ATR bars in prior 10)
  Exit plan:  stop 2.5x ATR, target 4.0x ATR, max 10 days, trailing stop
  Scoring:    min score 60, RS threshold 70-100

6.3 MeanReversionEOD (BUY)
  Regime:     RANGE (RSI < 30, bucket A/B) or BEAR (RSI < 25, bucket A only)
  Gates:
    - Price below Bollinger lower band
    - Extended earnings check (avoid buying into earnings)
  Exit plan:  stop 1.5x ATR, target 2.0x ATR, max 5 days
  Scoring:    min score 50, RS threshold 30-100

6.4 ShortBounceEOD (SELL)
  Regime:     BEAR or HIGH_VOL
  Gates:
    - SHORT_CONFIG.ENABLED = true
    - ema20 < ema50 (confirmed downtrend)
    - ATR-normalized EMA touch (bounce into resistance)
    - RSI 45-65 (overbought on bounce)
    - Bucket A only (shorts need deep liquidity)
    - Max 2 short positions simultaneously
    - F&O ban check (cannot short if in ban period)
  Exit plan:  stop 1.5x ATR, target 2.0x ATR, max 5 days
  Scoring:    min score 65, RS threshold 0-50 (only short weak stocks)

6.5 BearBounceEOD (BUY)
  Regime:     BEAR or HIGH_VOL
  Gates:
    - RSI < 25 (deeply oversold)
    - Price below Bollinger lower band
    - Volume spike > 1.5x SMA20 (capitulation signal)
    - Bucket A/B
  Exit plan:  stop 1.5x ATR, target 1.5x ATR, max 3 days (quick bounce only)
  Scoring:    min score 55, RS threshold 0-100 (no RS filter — oversold bounce)

6.6 RSLeaderEOD (BUY)
  Regime:     any (designed to find leaders even in bear markets)
  Gates:
    - ema20 > ema50 (uptrend despite market weakness)
    - RS score >= 80 (relative strength leader)
    - RSI 40-65
    - ATR-normalized EMA touch
    - Bucket A (or B in non-BEAR regimes)
  Exit plan:  stop 2.5x ATR, target 4.0x ATR, trailing stop (wide — leaders run far)
  Scoring:    min score 65, RS threshold 80-100


7) RISK PIPELINE (13 gates in doRiskApproval)
---------------------------------------------
Every signal must pass all 13 gates in sequence to be approved:

  Gate 1:  Regime hard gate
           - Checks tradeAllowed flag from regime doc
           - TRANSITION regime blocks all new entries

  Gate 2:  Feature validation
           - ema20 and atr14 must be finite numbers
           - Rejects if feature data is corrupt or missing

  Gate 3:  RSI fail-closed
           - If RSI14 is unavailable, reject the signal
           - Prevents trading without momentum context

  Gate 4:  Kill switch check
           - Reads config/runtime KILL_SWITCH flag
           - Hard block when kill switch is active

  Gate 5:  Event calendar
           - Checks earnings dates, corporate actions, F&O bans
           - Rejects entries around scheduled events

  Gate 6:  Strategy-aware RS filter
           - Each strategy defines its own min/max RS thresholds
           - PullbackEOD: 60-100, BreakoutCloseEOD: 70-100, ShortBounceEOD: 0-50, etc.

  Gate 7:  Gap risk gate
           - Rejects signal if gapRiskScore >= 0.8

  Gate 8:  Drawdown multiplier
           - Halts new entries at 20% portfolio drawdown
           - Scales down position size starting at 5% drawdown

  Gate 9:  Vol-targeting position sizing
           - Targets 12% annualized portfolio volatility
           - Adjusts position sizes to stay within vol budget

  Gate 10: ADV liquidity cap
           - Max 2% of average daily volume per position
           - Hard cap at Rs 2 crore position value

  Gate 11: Gap stress test
           - Per-position and portfolio-level worst-case overnight gap loss
           - Rejects if gap scenario exceeds risk tolerance

  Gate 12: Portfolio constraints
           - Max open positions limit
           - Sector exposure caps
           - Portfolio heat limit (total open risk in R-multiples)

  Gate 13: Correlation cluster enforcement
           - Max 2 positions per correlation cluster
           - Fail-closed: if correlation data unavailable, reject


8) DYNAMIC SCORING (computeDynamicScore)
----------------------------------------
Base score assigned per strategy:
  PullbackEOD:       55-75 depending on setup quality
  BreakoutCloseEOD:  55-75
  MeanReversionEOD:  55-75
  ShortBounceEOD:    55-75
  BearBounceEOD:     55-75
  RSLeaderEOD:       55-75

Score adjustments:
  RS boost:          +5 if rsScore >= 80, +3 if >= BOOST_THRESHOLD
  VDU boost:         +5 for PullbackEOD or RSLeaderEOD when VDU active
  Liquidity penalty: -5 for bucket C
  BEAR regime:       shorts +5, leaders +5, generic longs -5
  Inverse RS boost:  +5 for ShortBounceEOD when RS <= 20

Per-strategy min score cutoffs override the regime-level minSignalScore.
Signal must exceed both its strategy cutoff and the regime cutoff to proceed.


9) PAPER BROKER & EXECUTION
----------------------------

9.1 Order Flow
  1. Signal APPROVED → PaperOrder created (ACCEPTED status)
  2. Next day: doOpenFillSimulation() → fill at open price + slippage
  3. Position created in portfolio/default/positions/
  4. Daily: tradeManager updates trailing stops, checks exit conditions
  5. Position closed → Trade record created with full P&L breakdown

9.2 Slippage Model
  Dynamic by liquidity bucket with regime multiplier:
    Bucket A (>50M INR):   uniform random in [2, 8] bps
    Bucket B (10M-50M):    uniform random in [5, 20] bps
    Bucket C (<10M):       uniform random in [10, 40] bps
  Regime multipliers applied on top:
    TREND=1.0x, RANGE=1.2x, HIGH_VOL=2.0x, BEAR=1.5x

9.3 Indian Fee Breakdown
  STT (Securities Transaction Tax):  0.025% sell side
  Stamp duty:                         0.003%
  Exchange transaction charges:       0.00345%
  SEBI turnover fee:                  0.0001%
  GST:                                18% on (brokerage + exchange charges)
  Brokerage:                          Rs 20 flat per order

9.4 Gap-Through-Stop
  If bar.open gaps past the stop price:
    - Fill at open price (not stop price), plus slippage
    - Realizes loss greater than planned R
    - Prevents unrealistic P&L in volatile markets
    - Recorded as "gapStop" in fill metadata


10) FIRESTORE SCHEMA
--------------------

10.1 Core Collections
  barsD/{symbol}/days/{dateId}
    OHLCV candles (open, high, low, close, volume)

  features/{symbol}/days/{dateId}
    Computed indicators: ema20, ema50, ema200, rsi14, atr14,
    bollingerUpper, bollingerLower, swingHigh, swingLow, srZones,
    volumeSMA20, ret20d, ret60d, vduActive, gapRiskScore,
    liquidityBucket, rsScore, computedAt

  regime/{dateId}
    marketState, tradeAllowed, riskMultiplier, maxNewPositions,
    minSignalScore, breadth (pctAboveEMA50, universeMedianRet20d,
    universeMedianRet60d)

  signals/{dateId}/items/{signalId}
    signalId format: {symbol}_{dateId}_{strategyName}
    Fields: symbol, direction (BUY|SELL), strategy, score, entryPlan,
    stopPrice, targetPrice, rr, checklist, reasons,
    status (NEW|APPROVED|REJECTED|ORDERED|IN_TRADE|DONE)

  signals/{dateId}/status/{sentinelKey}
    sentinelKey format: {jobId}_{symbol}
    Idempotency sentinels to prevent duplicate signal evaluation

  paperOrders/{dateId}/items/{orderId}
    symbol, side (BUY|SELL), orderType (NEXT_OPEN), intendedQty,
    createdFromSignalId, risk (plannedR, riskAmount, stopDistance),
    status (CREATED|ACCEPTED|FILLED|CANCELLED|REJECTED)

  paperFills/{dateId}/items/{fillId}
    orderId, symbol, fillPrice, fillQty, slippageBps, feeEstimate,
    fillType (ENTRY|EXIT_STOP|EXIT_TARGET|EXIT_TIME|EXIT_THESIS)

  portfolio/default/positions/{symbol}
    Open and closed positions with entry/exit details, P&L

10.2 Config Collections
  config/account
    equity, baseRiskPct, maxPositions, strategyRiskWeights, peakEquity

  config/runtime
    TRADING_ENABLED (bool), MODE, KILL_SWITCH (bool)

  config/kiteSession
    accessToken, expiry, apiKey, apiSecret

  config/kiteCredentials
    apiKey, apiSecret, userId, password, totpSecret (for auto-renewal)

10.3 Reference Collections
  universes/{universeId}/members/{symbol}
    sector, liquidityBucket, instrumentToken

  calendar/{dateId}
    isTradingDay, tradingIndex, prevTradingDateId

  jobs/{jobId}
    stage, status, symbolCount, errors, startedAt, updatedAt

  logs/{dateId}/entries/{entryId}
    Structured log entries (level, message, context, timestamp)

  earnings/{symbol}
    Upcoming earnings dates

  corporateActions/{symbol}
    Corporate action dates (splits, dividends, etc.)

  fnoBans/{dateId}
    F&O ban list for the trading day

  alerts/{alertId}
    Alert type, message, severity, timestamp


11) AUTOMATION (Cloud Scheduler)
--------------------------------

11.1 Kite Auto-Renewal (kite_automation.ts)
  Gateway action: scheduledKiteRenew
  Schedule:       08:30 IST weekdays (Mon-Fri)
  Flow:
    1. Read credentials from Firestore config/kiteCredentials
    2. Headless login via axios: POST to Kite /api/login
    3. Two-factor auth: POST to /api/twofa with TOTP code
    4. Extract request_token from redirect
    5. KiteConnect.generateSession() to get access_token
    6. Store new accessToken + expiry in config/kiteSession
  Note: totpSecret must be the base32 seed string, NOT a 6-digit code.

11.2 Daily EOD Run
  Gateway action: scheduledEod
  Schedule:       15:45 IST weekdays (Mon-Fri)
  Flow:
    1. Check kill switch — abort if active
    2. Verify Kite session is active and not expired
    3. Call doStartEodRun(force=true) to begin pipeline

11.3 Cloud Scheduler Setup (GCP Console)
  Two HTTP POST jobs targeting the gateway URL with x-api-key header:

  Job 1: kite-auto-renew
    Cron:     30 8 * * 1-5
    Timezone: Asia/Kolkata
    Body:     {"action": "scheduledKiteRenew"}

  Job 2: daily-eod
    Cron:     45 15 * * 1-5
    Timezone: Asia/Kolkata
    Body:     {"action": "scheduledEod"}


12) DASHBOARD (React + Vite)
----------------------------

12.1 Tabs
  Dashboard tab:
    - Open positions table with live P&L
    - Portfolio stats (equity, drawdown, heat)
    - Current regime display
    - Active/recent jobs with stage progress
    - Today's signals (approved, rejected, reasons)
    - Manual trigger buttons (start EOD, deep sync, etc.)

  History tab:
    - Closed positions log
    - Win rate and expectancy by strategy
    - P&L breakdown (gross, fees, net)

  Logs tab:
    - Real-time log viewer from logs/{dateId}/entries
    - Filterable by level and context

  Settings tab:
    - Kite credentials form (apiKey, apiSecret, userId, password, totpSecret)
    - Test auto-renewal button
    - Cloud Scheduler schedule info

12.2 Gateway Client
  - All API calls via POST to gateway URL
  - Real-time updates: Firestore onSnapshot listeners for positions, jobs,
    signals, and log entries


13) ALERTING (alerting.ts)
--------------------------
Alert types:
  KILL_SWITCH            — kill switch activated
  SESSION_EXPIRED        — Kite access token expired
  RECONCILIATION_DRIFT   — paper vs expected position mismatch
  SYSTEMATIC_BIAS        — persistent directional error pattern

Storage: Firestore alerts collection

Systematic bias detection:
  - Triggers alert after 5+ consecutive same-direction errors
  - Indicates potential model or data issue

Reconciliation drift thresholds:
  - Warn at 30 bps drift
  - Halt trading at 50 bps drift


14) TESTING
-----------
  - 86 tests across 10 suites (Jest + ts-jest)
  - Coverage areas:
      Strategy evaluation (all 6 strategies)
      Features computation
      Risk approval (all 13 gates)
      Regime detection
      Aggregation stats
      Paper broker (fills, slippage, fees)
      Reconciliation
  - Mock pattern: shared jest.setup.js with chainable Firestore mock


15) DEPLOYMENT
--------------
Functions:
  npm run build && firebase deploy --only functions
  Node 20 runtime, region us-central1

Hosting (dashboard):
  cd dashboard && npm run build && firebase deploy --only hosting
  Serves from dashboard/dist to https://suhas-ag.web.app
