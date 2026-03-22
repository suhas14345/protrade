# ProTrade | Strategy Deep Dive

ProTrade uses a multi-layered approach to trading, combining specific technical setups with broad market gating and adaptive risk management. All strategies are **EOD (End of Day)**, meaning they evaluate data at the close and plan entries for the next market open.

---

## 1. Market Regime Gating (The "Gatekeeper")
Before any individual stock is evaluated, the system analyzes the broad market to determine the "Regime." No strategy can fire if the Regime forbids it.

| Regime | Description | Tactics Allowed | Risk Multiplier |
| :--- | :--- | :--- | :--- |
| **TREND** | Healthy uptrend, strong breadth. | Longs (Pullback, Breakout) | 1.0 (Full Size) |
| **RANGE** | Side-ways movement, lower conviction. | Longs (Pullback, Mean Reversion) | 0.5 (Reduced) |
| **BEAR** | Persistent downtrend, weak breadth. | **Shorts Only** (Short Bounce) | 0.5 (Reduced) |
| **HIGH_VOL** | Market panic or extreme volatility. | Highly Defensive | 0.25 (Small Size) |
| **TRANSITION**| Sharp trend change or volatility shock. | **None** | 0.0 (Cooldown) |

---

## 2. Long Strategy: Pullback EOD
**Concept**: Buying high-quality trends during temporary weakness (retracements).

*   **Setup Conditions**:
    *   **Trend Alignment**: EMA20 must be above EMA50.
    *   **Weekly Bias**: Weekly EMA20 > Weekly EMA50 (optional filter).
    *   **Pullback Zone**: The price must "touch" the band between EMA20 and EMA50 (or be within 0.5% of EMA20).
    *   **Momentum Filter**: RSI14 must be between **40 and 55** (ensuring the stock is in a dip, not overextended).
*   **Execution**:
    *   **Entry**: `NEXT_OPEN` (Market order at next open).
    *   **Stop Loss**: `Entry - (2.0 * ATR14)`.
    *   **Target**: `Entry + (3.0 * ATR14)`.

---

## 3. Long Strategy: Breakout Close EOD
**Concept**: Riding momentum when a stock clears a high-conviction resistance level.

*   **Setup Conditions**:
    *   **Regime**: Must be `TREND` (Bullish).
    *   **Trend Alignment**: EMA20 > EMA50.
    *   **The Break**: Today's **Close** must be higher than the **High** of the previous 20 trading days.
*   **Execution**:
    *   **Entry**: `NEXT_OPEN`.
    *   **Stop Loss**: `Entry - (2.0 * ATR14)`.
    *   **Target**: `Entry + (3.0 * ATR14)`.

---

## 4. Long Strategy: Mean Reversion EOD
**Concept**: Buying extreme "oversold" conditions during a range-bound market.

*   **Setup Conditions**:
    *   **Regime**: Must be `RANGE`.
    *   **Volatility Context**: Price must close **below the Lower Bollinger Band** (2 standard deviations).
    *   **Oversold Filter**: RSI14 must be **below 30**.
*   **Execution**:
    *   **Entry**: `NEXT_OPEN`.
    *   **Stop Loss**: `Entry - (2.0 * ATR14)`.
    *   **Target**: `Entry + (3.0 * ATR14)`.

---

## 5. Bearish Strategy: Short Bounce EOD
**Concept**: "Selling the rip" during a confirmed downtrend.

*   **Setup Conditions**:
    *   **Regime**: Must be `BEAR` or `HIGH_VOL`.
    *   **Trend Confirmation**: EMA20 must be below EMA50.
    *   **The Bounce**: Price retraces upwards to "touch" the resistance band between EMA20 and EMA50.
    *   **Momentum Filter**: RSI14 must be between **45 and 65** (bounce has strength but isn't a reversal).
*   **Execution**:
    *   **Direction**: SELL (Short).
    *   **Entry**: `NEXT_OPEN`.
    *   **Stop Loss**: `Entry + (2.0 * ATR14)`.
    *   **Target**: `Entry - (3.0 * ATR14)`.

---

## 6. Risk & Portfolio Management (Rules of Engagement)

The app prioritizes survival and risk preservation over raw returns.

*   **Adaptive Sizing**: Positions are sized so that a stop-loss hit only loses **0.5% of total equity** (base risk). This is then further scaled down by the Regime's **Risk Multiplier**.
*   **Portfolio Heat**: The system tracks "Total Open R" (sum of all risk) and enforces a cap (e.g., 4R total).
*   **Correlation Clusters**: The system prevents over-concentration by limiting exposure to symbols with correlation > 0.75.

---

## 7. Technical Indicators Used
*   **EMA (20, 50)**: Trend and buy-zone detection.
*   **RSI (14)**: Momentum and overextension gating.
*   **ATR (14)**: Volatility-adjusted risk management.
*   **Bollinger Bands**: Mean reversion boundaries.
