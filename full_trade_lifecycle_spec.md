# ProTrade Alpha — Trade Lifecycle Specification V3.1

Full journey of a trade from market close to position closure.

---

## Phase 1: Market Regime Detection (15:45 IST)

**Trigger**: After NSE market close.

**Process**: Analyze Nifty 50 index features.
- Detect regime: TREND, RANGE, BEAR, HIGH_VOL, or TRANSITION
- 3-bar hysteresis for regime changes
- Breadth confirmation: TREND needs >55% above EMA50, BEAR <35%

**Output**: `regime/{dateId}` document with marketState, riskMultiplier, minSignalScore.

---

## Phase 2: Signal Generation (EOD Run)

**Trigger**: Orchestrator completes FETCH → FEATURES → RS_RANK → REGIME stages.

**Process**: Each symbol evaluated against 6 strategies:
1. PullbackEOD — buy trend pullbacks (TREND/RANGE)
2. BreakoutCloseEOD — buy consolidation breakouts (TREND)
3. MeanReversionEOD — buy extreme oversold (RANGE/BEAR)
4. ShortBounceEOD — sell rips in downtrends (BEAR/HIGH_VOL)
5. BearBounceEOD — buy capitulation bounces (BEAR/HIGH_VOL)
6. RSLeaderEOD — buy relative strength leaders (any regime)

**Scoring**: Dynamic score = base + RS boost + VDU boost + regime modifiers - penalties.
Must exceed `max(strategyMinScore, regime.minSignalScore)`.

**Output**: `signals/{dateId}/items/{signalId}` with status NEW.

---

## Phase 3: Risk Approval (13 Gates)

**Trigger**: Inline during signal evaluation.

**Process**: Every signal passes through:
1. Regime gate → 2. Feature validation → 3. RSI fail-closed → 4. Kill switch →
5. Event calendar → 6. RS filter (strategy-aware) → 7. Gap risk → 8. Drawdown →
9. Vol-targeting sizing → 10. ADV cap → 11. Gap stress → 12. Portfolio limits →
13. Correlation cluster (fail-closed)

**Output**: Signal status updated to APPROVED or REJECTED_BY_RISK.

---

## Phase 4: Order Creation (EOD)

**Trigger**: Approved signals.

**Process**: Create paper orders with:
- Entry type: NEXT_OPEN
- Sized quantity (from vol-targeting)
- Stop and target prices (ATR-based, per-strategy exit profile)
- Risk amount, sector, liquidity bucket metadata

**Output**: `paperOrders/{dateId}/items/{orderId}` with status ACCEPTED.

---

## Phase 5: Fill Simulation (Next Day ~09:20 IST)

**Trigger**: `doOpenFillSimulation()` in morning trade management.

**Process**:
- Fetch today's opening bar
- Apply dynamic slippage: bucket A (2-8 bps), B (5-20 bps), C (10-40 bps) × regime multiplier
- Gap-through-stop check: if open gaps past stop, fill at open (not stop)
- Apply Indian fees: STT (0.025% sell), stamp duty, exchange, SEBI, GST, ₹20 brokerage
- Create position in `portfolio/default/positions/{symbol}`

**Output**: Active position with entry price, stop, targets, risk amount.

---

## Phase 6: Position Management (Daily)

**Trigger**: Daily `manageTrades` action.

**Process**:
- Update unrealized P&L from latest bar
- Track MFE (Maximum Favorable Excursion) and MAE (Maximum Adverse Excursion)
- Exit checks (in priority order):
  1. **Hard stop** — price hits stop loss
  2. **Time stop** — max hold days exceeded without profit target
  3. **Trailing stop** — activated after reaching profit threshold
  4. **Profit target** — price reaches target

**Output**: Position closed → trade record in `trades/`.

---

## Phase 7: Performance Analytics

**Trigger**: After trade closure.

**Process**:
- Compute R-multiple: actual P&L / risk amount
- Update aggregate stats by strategy × regime
- Reconciliation: compare expected vs actual slippage
- Systematic bias detection: 5+ consecutive same-direction errors → alert

**Output**: Updated `aggregateStats`, reconciliation records, alerts if thresholds breached.
