# ProTrade | Strategy Deep Dive (v1.1)

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
    *   **ATR-Normalized Touch (v1.1)**: Price must be within **0.3 ATR** of EMA20 or inside the EMA20-50 band.
    *   **Momentum Filter**: RSI14 must be between **40 and 55**.
    *   **Earnings Block (v1.1)**: No entries within 2 trading days of earnings.
*   **Execution**:
    *   **Entry**: `NEXT_OPEN`.
    *   **Stop Loss**: `Entry - (2.0 * ATR14)`.
    *   **Target**: `Entry + (3.0 * ATR14)`.

---

## 3. Long Strategy: Breakout Close EOD
**Concept**: Riding momentum when a stock clears a high-conviction resistance level.

*   **Setup Conditions**:
    *   **Regime**: Must be `TREND`.
    *   **Trend Alignment**: EMA20 > EMA50.
    *   **20-Day High**: Today's Close > High of previous 20 trading days.
    *   **Volume Confirm (v1.1)**: Volume must be **>= 1.2x SMA20 Volume**.
*   **Execution**:
    *   **Entry**: `NEXT_OPEN`.
    *   **Stop Loss**: `Entry - (2.0 * ATR14)`.
    *   **Target**: `Entry + (3.0 * ATR14)`.

---

## 4. Long Strategy: Mean Reversion EOD
**Concept**: Buying extreme "oversold" conditions during a range-bound market.

*   **Setup Conditions**:
    *   **Regime**: Must be `RANGE`.
    *   **Trend Neutrality (v1.1)**: |EMA20 - EMA50| / Close must be **< 1%**.
    *   **Extreme**: Price Close < Lower Bollinger Band (2 SD).
    *   **Oversold**: RSI14 < 30.
*   **Execution**:
    *   **Entry**: `NEXT_OPEN`.

---

## 5. Bearish Strategy: Short Bounce EOD
**Concept**: "Selling the rip" during a confirmed downtrend.

*   **Setup Conditions**:
    *   **Regime**: `BEAR` or `HIGH_VOL`.
    *   **Trend Confirmation**: EMA20 < EMA50.
    *   **The Bounce**: ATR-normalized touch (0.3 ATR) of EMA20 or inside EMA band.
    *   **Momentum Filter**: RSI14 between **45 and 65**.
*   **Execution**:
    *   **Stop Loss**: `Entry + (2.0 * ATR14)`.
    *   **Target**: `Entry - (3.0 * ATR14)` (Overrides to **2.0 ATR** in `HIGH_VOL` regime).

---

## 6. Exit Management & Priority (v1.1)

The system manages open positions daily using a strict **Exit Priority** to protect capital:

1.  **HARD STOP**: Triggered if price hits the volatility-adjusted stop. (Highest Priority)
2.  **TIME STOP**: If a trade is open for **5 trading days** and has not reached **+1.0 ATR** in profit, it is closed at the market.
3.  **PARTIAL PROFIT**: If price reaches **+1.5 ATR** in profit, the system sells **33% (1/3rd)** of the position and moves the stop loss to **Breakeven**.
4.  **PROFIT TARGET**: The final 2/3rds are held until the 3.0 ATR target is reached.

---

## 7. Technical Indicators Used (v1.1)
*   **EMA (20, 50)**: Trend and ATR-normalized buy-zone detection.
*   **RSI (14)**: Momentum and overextension gating.
*   **ATR (14)**: Volatility-adjusted risk, stops, targets, and touch proximity.
*   **Bollinger Bands**: Mean reversion boundaries.
*   **Volume SMA (20)**: Breakout confirmation threshold.
