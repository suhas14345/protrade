# ProTrade | Strategy Deep Dive (V3.1)

6 strategies across bull, range, and bear markets. All EOD — evaluate at close, enter at next open.

---

## Market Regime Gating

| Regime | Condition | Strategies Allowed | Risk Mult |
|--------|-----------|-------------------|-----------|
| **TREND** | EMA slopes up, breadth >55% | Pullback, Breakout, RSLeader | 1.0 |
| **RANGE** | Flat EMAs, mixed breadth | Pullback, MeanReversion, RSLeader | 0.5 |
| **BEAR** | EMA slopes down, breadth <35% | Short, BearBounce, MeanReversion(tight), RSLeader | 0.5 |
| **HIGH_VOL** | Extreme volatility/VIX spike | Short, BearBounce | 0.25 |
| **TRANSITION** | Regime change in progress | **None** (3-bar hysteresis cooldown) | 0.0 |

---

## 1. PullbackEOD (BUY)

**Concept**: Buy high-quality uptrends during temporary retracements.

| Gate | Condition |
|------|-----------|
| Regime | TREND or RANGE |
| Trend | EMA20 > EMA50 |
| EMA touch | Close within 0.3×ATR of EMA20, or inside EMA20-50 band |
| RSI | Regime-aware range (TREND: 38-58, RANGE: 40-55) |
| VDU | Volume Dry-Up must be active (hard gate) |
| Events | No earnings within 5 days, no corporate actions |
| RS | ≥ 60 (filter weak stocks) |

- **Entry**: NEXT_OPEN
- **Stop**: 2.0 × ATR below entry
- **Target**: 3.0 × ATR above entry
- **Max hold**: 7 days, trailing stop enabled
- **Min score**: 55
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

## 2. BreakoutCloseEOD (BUY)

**Concept**: Catch breakouts from consolidation in strong trends.

| Gate | Condition |
|------|-----------|
| Regime | TREND only |
| Trend | EMA20 > EMA50 |
| Breakout | Close > 20-day high |
| Volume | Above 20-day SMA |
| Consolidation | ≥5 of last 10 bars with range < 80% of average (V3.0) |
| Events | No earnings/corporate actions |
| RS | ≥ 70 |

- **Entry**: NEXT_OPEN
- **Stop**: 2.5 × ATR
- **Target**: 4.0 × ATR
- **Max hold**: 10 days, trailing stop
- **Min score**: 60

---

## 3. MeanReversionEOD (BUY)

**Concept**: Buy extreme oversold conditions expecting a snap-back.

### RANGE mode
| Gate | Condition |
|------|-----------|
| Regime | RANGE |
| Oversold | Close < Bollinger lower band, RSI < 30 |
| Liquidity | Bucket A or B |
| Trend neutral | \|EMA20 - EMA50\| / close < 1% |

### BEAR mode (V3.1 — tighter)
| Gate | Condition |
|------|-----------|
| Regime | BEAR |
| Deep oversold | RSI < 25 (stricter than RANGE's 30) |
| Liquidity | Bucket A only |
| Below BB | Close < Bollinger lower band |

- **Entry**: NEXT_OPEN
- **Stop**: 1.5 × ATR · **Target**: 2.0 × ATR · **Max hold**: 5 days
- **Min score**: 50, RS threshold: 30-100

---

## 4. ShortBounceEOD (SELL)

**Concept**: Sell the rip during confirmed downtrends (paper research mode).

| Gate | Condition |
|------|-----------|
| Regime | BEAR or HIGH_VOL |
| Config | SHORT_CONFIG.ENABLED = true |
| Trend | EMA20 < EMA50 |
| Bounce | ATR-normalized EMA touch |
| RSI | 45-65 (overbought in downtrend) |
| Liquidity | Bucket A only |
| F&O ban | Symbol not in F&O ban list |
| Max shorts | ≤ 2 concurrent |

- **Entry**: NEXT_OPEN
- **Stop**: 1.5 × ATR above · **Target**: 2.0 × ATR below · **Max hold**: 5 days
- **Min score**: 65, RS threshold: 0-50 (only short weak stocks)

> **Note**: Futures plumbing (lot sizes, expiry, F&O fees) not implemented. PnL approximate.

---

## 5. BearBounceEOD (BUY) — V3.1

**Concept**: Buy capitulation bounces — deeply oversold with selling climax exhaustion.

| Gate | Condition |
|------|-----------|
| Regime | BEAR or HIGH_VOL |
| Deep oversold | RSI < 25 |
| Below BB | Close < Bollinger lower band |
| Volume spike | Volume > 1.5× 20-day SMA (capitulation) |
| Liquidity | Bucket A or B |

- **Entry**: NEXT_OPEN
- **Stop**: 1.5 × ATR · **Target**: 1.5 × ATR · **Max hold**: 3 days
- **Min score**: 55, RS: 0-100 (no RS filter — oversold stocks have weak RS)

---

## 6. RSLeaderEOD (BUY) — V3.1

**Concept**: Buy stocks with exceptional relative strength — first to rally on turn.

| Gate | Condition |
|------|-----------|
| Regime | Any (designed for bear markets) |
| Uptrend | EMA20 > EMA50 (uptrend despite market) |
| RS | ≥ 80 (top quintile) |
| RSI | 40-65 (healthy pullback) |
| EMA touch | ATR-normalized |
| Liquidity | Bucket A; or B in non-BEAR |

- **Entry**: NEXT_OPEN
- **Stop**: 2.5 × ATR · **Target**: 4.0 × ATR · Trailing stop
- **Min score**: 65, RS: 80-100

---

## 13-Gate Risk Pipeline

Every signal passes `doRiskApproval` before becoming an order:

1. **Regime gate** — tradeAllowed, TRANSITION blocks all
2. **Feature validation** — EMA20, ATR14 finite and positive
3. **RSI fail-closed** — reject if unavailable
4. **Kill switch** — RUNTIME_CONFIG.KILL_SWITCH
5. **Event calendar** — earnings, corporate actions, F&O bans (strategy-aware)
6. **RS filter** — per-strategy min/max thresholds
7. **Gap risk** — reject if gapRiskScore ≥ 0.8
8. **Drawdown** — halt at 20% DD; scale from 5%
9. **Vol-targeting** — target 12% annual portfolio vol
10. **ADV cap** — max 2% daily volume; ₹2Cr absolute
11. **Gap stress** — worst-case overnight loss
12. **Portfolio limits** — max positions, sector caps, heat
13. **Correlation cluster** — max 2/cluster (fail-closed)

---

## Dynamic Scoring

| Modifier | Points | Condition |
|----------|--------|-----------|
| RS boost | +5 | rsScore ≥ 80 |
| VDU boost | +5 | VDU active + Pullback/RSLeader |
| Liquidity penalty | -5 | Bucket C |
| BEAR short bonus | +5 | ShortBounce in BEAR |
| BEAR leader bonus | +5 | RSLeader in BEAR |
| BEAR long penalty | -5 | Generic longs in BEAR |
| Inverse RS (shorts) | +5 | ShortBounce with RS ≤ 20 |

Signal must exceed `max(strategyMinScore, regime.minSignalScore)`.

---

## Signal → Position Flow

```
Day N (15:45 IST):  EOD run → signals → risk approval → paper orders (ACCEPTED)
Day N+1 (09:20 IST): doOpenFillSimulation() → fill at open + slippage → active position
```

## 7. Technical Indicators Used (v1.1)
*   **EMA (20, 50)**: Trend and ATR-normalized buy-zone detection.
*   **RSI (14)**: Momentum and overextension gating.
*   **ATR (14)**: Volatility-adjusted risk, stops, targets, and touch proximity.
*   **Bollinger Bands**: Mean reversion boundaries.
*   **Volume SMA (20)**: Breakout confirmation threshold.
