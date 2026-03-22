# ProTrade Alpha: Institutional-Grade Trading Architecture (EPIC 0–7)

ProTrade Alpha is a cloud-native, event-driven trading system built for autonomous, regime-aware portfolio management. It bridges the gap between simple technical scanning and professional execution management.

---

## 1. Intelligence Layer: Market Regime Detection
The system begins every cycle by identifying the **Market Environment**. 
- **Methodology**: Multi-timeframe analysis (Daily/Weekly EMA) of the Nifty 50 Index.
- **Outcome**: Classification into regimes like `TREND` (confirmed bull), `BEAR` (aggressive selling), `RANGE` (sideways), or `MR/HIGH_VOL` (mean reversion).
- **Impact**: Sets the **Global Risk Multiplier** (e.g., 1.0x in Trend vs. 0.5x in Volatile conditions).

## 2. Signal Generation: Multi-Strategy Ensemble
Signals are generated from a custom universe (Nifty 50, 500, or sampled lists) using an ensemble of alpha patterns:
- **Daily Features**: EMA crossovers, RSI extremes, and trend-aligned price patterns.
- **Weekly Filter**: Optional EMA-based trend filter (Weekly EMA20 > EMA50) to ensure high-probability entries.

## 3. The Professional Risk Engine (EPIC 2)
Every signal must pass a strict institutional risk filter:
- **Adaptive Position Sizing**: 
  `Qty = (Equity * Risk%) * RegimeMultiplier / (Entry - StopLoss)`
- **Portfolio- **Constraint Gates**: 
  1. **Max Heat**: Total open risk (in R-multiples) cannot exceed 4R.
  2. **Sector Cap**: Max 2 positions per sector (e.g., IT, Banks).
  - **Exposure Caps**: Ensures no single position dominates the portfolio.

## 4. Paper Brokerage & Execution Simulation (EPIC 3)
Designed to provide a "realistic truth" about backtest/forward performance:
- **Order Placement**: Approved signals are staged as `paperOrders` at EOD.
- **Simulated Fills**: Executed at the **Next Day's Open** with customizable **Slippage** and **Fee Models**.
- **Execution Gap Filter**: Automatically cancels orders if the opening price "gaps" more than 1.5x the expected ATR (Average True Range), protecting the system from overnight shocks.

## 5. Active Trade Management (EPIC 4)
Once filled, positions are managed dynamically until close:
- **Multi-Day Monitoring**: Trades remain open across sessions, with state tracked in Firestore.
- **MAE/MFE Tracking**: 
  - **MFE (Maximum Favorable Excursion)**: The maximum profit reached (in R-multiples).
  - **MAE (Maximum Adverse Excursion)**: The maximum "pain" (drawdown) endured.
- **Automated Exit Logic**: 
  - **Target/Stop Reached**: Triggered by price movement.
  - **Time Exit**: Exits after a set number of days if targets aren't hit.
  - **Trail Activation**: Locks in profit after an "R-multiple" threshold is crossed.

## 6. Monitoring & Performance Scoreboard (EPIC 6)
Post-trade results are analyzed through a statistical lens:
- **Forward Returns**: Measures potential returns at T+1, T+3, and T+5 intervals.
- **Regime Scoreboard**: Strategy-level metrics showing Win Rate and Expectancy ($E$) per regime, identifying "What's Winning Now."

## 7. Safety & Discipline (EPIC 7)
Safety is integrated into every function call:
- **Global Kill Switches**: Instant system halt if market conditions or configuration change.
- **Data Staleness Protection**: Functions abort if data latency exceeds safety thresholds.
- **Loss-Based Cooldowns**: The system automatically pauses or scales down risk after a series of significant losses.

---

## Technical Stack
- **Cloud**: Firebase Cloud Functions (Node.js 20, 2nd Gen).
- **Data Storage**: Firestore (Real-time NoSQL).
- **Data Feeds**: Zerodha Kite Connect (Main) with Yahoo Finance (Secondary Fallback).
- **Frontend**: Vite + React + Tailwind + Lucide Icons for a premium monitoring experience.

---

*This system turns raw market data into institutional-grade executions by enforcing mathematical discipline at every step.*
