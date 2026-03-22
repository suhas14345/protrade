# ProTrade Alpha: Technical Analysis & Execution Pipelines

This document provides a step-by-step technical breakdown of how the ProTrade Alpha system (EPIC 0–7) processes the overall market and individual stocks during a single trading cycle.

---

## Phase 1: Market Regime Analysis (The "Filter")
Before looking at any individual stock, the system determines the **Market Context**. This sets the "speed limit" for the entire portfolio.

1.  **Data Acquisition**: The `computeRegime` service fetches the last 200 days of OHLCV data for the Nifty 50 Index (`NSE:NIFTY_50`).
2.  **Indicator Layer**: It computes a moving average ribbon:
    *   **Short-term**: EMA 20
    *   **Medium-term**: EMA 50
    *   **Long-term**: EMA 200
3.  **Classification Logic**:
    *   **TREND**: If `Price > EMA 20 > EMA 50`. (Bullish Bias)
    *   **BEAR**: If `Price < EMA 50 < EMA 200`. (Bearish Bias)
    *   **RANGE**: If Moving Averages are "tangled" or price is oscillating between EMA 20 and EMA 50.
4.  **State Persistence**: The detected regime is saved to Firestore. A `RiskMultiplier` is assigned:
    *   *Example*: 1.0x for Trend, 0.5x for Range/Volatile.

---

## Phase 2: Individual Stock Analysis (The "Alpha")
Once the regime is set, the system processes a stock (e.g., `RELIANCE`) through the **Strategy Ensemble**.

1.  **Technical Feature Engineering**:
    *   **Daily Scan**: Calculates RSI, EMA crossovers, and volume spikes.
    *   **Weekly Filter**: Checks the higher-timeframe trend. If the stock is below its Weekly EMA 50, it is often discarded as "weak" regardless of the daily signal.
2.  **Signal Generation**:
    *   If technical patterns align (e.g., an RSI Mean Reversion or an EMA Breakout), a `NEW` signal is generated.
    *   The signal includes an **Entry Price** (usually next open), a **Stop Loss**, and a **Target**.
3.  **Risk Engine Validation**:
    *   **Dynamic Sizing**: The system looks at your current **Portfolio Equity**. It calculates how many shares to buy so that if you hit your Stop Loss, you only lose exactly `Risk %` of your account (adjusted by the Regime Multiplier).
    *   **Constraint Check**: It checks the current "Portfolio Heat." If 5 stocks are already in trade, it may reject `RELIANCE` to prevent over-concentration.
4.  **Order Staging**:
    *   If the Risk Engine approves, the status changes to `APPROVED`.
    *   A `paperOrder` document is created, which the **Paper Broker** will attempt to "fill" at the next day's market open.

---

## Phase 3: Real-Time Monitoring
After the stock is "bought" in the simulation:

1.  **Lifecycle Tracking**: The **Trade Manager** begins a dedicated loop for `RELIANCE`.
2.  **Excursion Analysis**: Every minute, it tracks:
    *   **MFE**: "How much did we go into green?" (Maximum Favorable Excursion).
    *   **MAE**: "How much did we go into red?" (Maximum Adverse Excursion).
3.  **Exit Trigger**: The monitor continuously compares price against the `Target` and `StopLoss` until an exit is triggered and the trade is logged to History.
