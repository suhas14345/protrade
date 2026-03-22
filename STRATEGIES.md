# ProTrade Strategy Analysis

ProTrade uses a multi-layered approach to trading, combining specific technical setups with broad market gating and adaptive risk management.

## 1. Primary Trading Strategy: Trend Pullback EOD
The core logic revolves around buying high-quality trends during temporary weakness.

*   **Setup**: 
    *   **Trend Alignment**: EMA20 must be above EMA50.
    *   **Pullback**: Price retraces into the "buy zone" between EMA20 and EMA50 (or within 0.5% of EMA20).
    *   **Momentum Filter**: RSI14 must be below 55 (ensuring the stock is not overbought).
*   **Execution**:
    *   **Entry**: Market order at the Next Day's Open (`NEXT_OPEN`).
    **Stop Loss**: Set at 2.0 * ATR14 below the entry price.
    *   **Target**: Set at 3.0 * ATR14 above the entry price (targeting a 1.5:1 to 2:1 Reward-to-Risk ratio).

## 2. Bearish Strategy: Short Bounce EOD
The Short Bounce strategy is designed to "sell the rip" during a confirmed downtrend, entering when a stock has a temporary relief rally back to resistance.

*   **Setup**:
    *   **Market Regime**: Must be `BEAR` or `HIGH_VOL`.
    *   **Trend Confirmation**: EMA20 must be below EMA50 (EMA20 < EMA50).
    *   **The Bounce**: Price retraces upwards to "touch" the band between EMA20 and EMA50.
    *   **Momentum Filter**: RSI14 must be between 45 and 65 (avoiding oversold conditions).
*   **Execution**:
    *   **Direction**: SELL (Short).
    *   **Entry**: Market order at the Next Day's Open (`NEXT_OPEN`).
    *   **Stop Loss**: Set at 2.0 * ATR14 above the entry price.
    *   **Target**: Set at 3.0 * ATR14 below the entry price (1.5:1 reward-to-risk).

### Example: SAIL.NS (March 2026)
1.  **Market**: Regime is `BEAR`.
2.  **Trend**: EMA20 (154) < EMA50 (160).
3.  **Bounce**: Stock rallies from 148 to **155.52**, touching the EMA20 resistance.
4.  **Signal**: Short Sell at 155.52 with a target of 143.50.

---

## 3. Market Regime Gating (The "Gatekeeper")
Before any individual stock is evaluated, the system analyzes the broad market to determine the "Regime."

| Regime | Description | Trade Allowed | Risk Multiplier |
| :--- | :--- | :--- | :--- |
| **TREND** | Healthy uptrend, strong breadth. | Yes | 1.0 (Full Size) |
| **RANGE** | Side-ways movement, lower conviction. | Yes | 0.5 (Reduced) |
| **BEAR** | Persistent downtrend, weak breadth. | Yes (Shorts Only) | 0.5 (Reduced) |
| **HIGH_VOL** | Market panic or extreme volatility. | Yes | 0.25 (Small Size) |
| **TRANSITION**| Sharp trend change or volatility shock. | **No** | 0.0 (Cooldown) |

---

## 4. Risk & Portfolio Management
The app prioritizes survival and risk preservation over raw returns.

*   **Adaptive Sizing**: Positions are sized so that a stop-loss hit only loses **0.5% of total equity** (base risk), which is then further scaled down by the Regime's Risk Multiplier.
*   **Portfolio Heat**: The system tracks "Total Open R" (the sum of all risk across open positions) and enforces a cap (e.g., 4R total).
*   **Correlation Clusters**: The system identifies symbols that move together (correlation > 0.75) and limits exposure to those specific clusters.

---

## 5. Technical Indicators Used
The system's "Feature Engine" computes the following for every symbol daily:
*   **EMA (20, 50)**: For trend and buy-zone identification.
*   **RSI (14)**: For momentum gating.
*   **ATR (14)**: For volatility-adjusted stop losses and position sizing.
*   **Bollinger Bands**: For mean reversion and volatility context.

---

## 6. Planned Strategies (Roadmap)
*   **Breakout Close EOD**: Entering when a stock closes above a multi-day consolidation range.
*   **Mean Reversion**: Using Bollinger Bands and RSI extremes for overextended reversals.
