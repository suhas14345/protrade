# ProTrade Alpha: Full Trade Lifecycle Specification (EPIC 0–7)

This document defines the exact technical journey of a trade, from initial market classification to final performance evaluation.

---

## Phase 1: Market Regime Detection (EOD T-0)
**Trigger**: After market close on Day T-0.
**Logic**: Analyze Nifty 50 Index (`^NSEI`) features.
- **Rules**:
  1. **BEAR**: `Price < EMA200` & `EMA200 Slope < 0`. (Risk: 0.5x, Max New: 2)
  2. **HIGH_VOL**: `ATR % > 1.5 * ATR_MA_100`. (Risk: 0.5x, Max New: 2)
  3. **TREND**: `EMA20 > EMA50`. (Risk: 1.0x, Max New: 5)
  4. **RANGE**: Fallback. (Risk: 1.0x, Max New: 5)
**Output**: Persistent `Regime` document in Firestore.

---

## Phase 2: Stock Scanning & Signal Generation (EOD T-0)
**Trigger**: Immediately after Regime is set.
**Logic**: Scan the selected universe (Nifty 50/500/Sample).
- **Technical Ensemble**: 
  - **Daily**: Crossovers, RSI mean reversion, Volume spikes.
  - **Weekly Filter**: `Weekly Price > EMA50` required for long signals.
**Output**: `NEW` Signal documents in `signals/<date>/items`.

---

## Phase 3: Risk Processing & Selection (EOD T-0)
**Trigger**: Automated for every `NEW` signal.
**Logic**: Apply institutional risk constraints.
- **Position Sizing**: 
  `Qty = (Equity * RiskPercent) * RegimeMultiplier / (EntryPrice - StopPrice)`
- **Constraint Gates**: 
  1. **Max Heat**: Total open risk (in R-multiples) cannot exceed 4R.
  2. **Sector Cap**: Max 2 positions per sector (e.g., IT, Banks).
  3. **Max Positions**: Tighter global limit during `BEAR` or `HIGH_VOL`.
**Output**: Selected signals updated to `APPROVED`.

---

## Phase 4: Order Staging (EOD T-0)
**Trigger**: For all `APPROVED` signals.
**Logic**: Prepare orders for next-day execution.
- **Action**: Create `paperOrder` documents with `limitPrice = EntryPrice`.
**Output**: Signals updated to `ORDERED`.

---

## Phase 5: Execution & Fill Simulation (Open T+1)
**Trigger**: Shortly after market open on Day T+1.
**Logic**: Simulate institutional execution.
- **Fill Price**: `Next Day Open` + `Slippage` (0.1% for Nifty 50).
- **The Gap Filter**: If `Open Price` is >1.5x ATR away from expected entry, the order is **Cancelled** (Safety protocol).
- **Outcome**: Successful fills create a **Position** document.
**Output**: Signals updated to `IN_TRADE`.

---

## Phase 6: Trade Monitoring (Daily T+1 to T+N)
**Trigger**: Every hour/day while a position is open.
**Logic**: Track lifecycle metrics.
- **Excursion Tracking**: 
  - **MFE**: Highest price reached (mapped to R-multiple).
  - **MAE**: Lowest price reached (mapped to R-multiple).
- **Exit Logic**:
  1. **Target Hit**: Exit at `targetPrice`.
  2. **Stop Hit**: Exit at `stopPrice`.
  3. **Time Exit**: Exit if `CurrentDate - EntryDate > 10 Days`.
  4. **Breakeven Trail**: Move stop to entry once `Price > +1.5R`.
**Output**: Signals updated to `EXITED`.

---

## Phase 7: Outcome & Analytics (Post-Exit)
**Trigger**: Immediately after a trade is closed.
**Logic**: Scientific performance review.
- **Expected Value (Expectancy)**: `(Avg Win * Win Rate) - (Avg Loss * Loss Rate)`.
- **Regime Scoreboard**: Update the `aggregateStats` for the specific `Strategy_Regime` pair.
**Output**: Real-time performance chart updated on Dashboard.

---

*This specification ensures that every trade is a result of mathematical discipline rather than emotional impulse.*
