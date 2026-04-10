# ProTrade Alpha — Technical Analysis Pipeline V3.1

How the system processes market data and individual stocks during each EOD cycle.

---

## Stage 1: Market Regime Detection

1. **Data**: Fetch Nifty 50 index features (EMA20, EMA50, EMA200, breadth metrics)
2. **Classification**:
   - **TREND**: EMA20 > EMA50, breadth (pctAboveEMA50) > 55%
   - **BEAR**: EMA slopes down, breadth < 35%
   - **RANGE**: EMAs flat, mixed breadth
   - **HIGH_VOL**: ATR spike > 1.5× average
   - **TRANSITION**: Regime change detected but not confirmed
3. **Hysteresis**: 3 consecutive bars required to confirm regime change
4. **Output**: `regime/{dateId}` — marketState, riskMultiplier, minSignalScore, maxNewPositions

---

## Stage 2: Feature Engineering (per symbol)

1. **Technical Indicators**: EMA20/50/200, RSI14, ATR14, Bollinger Bands (20, 2σ)
2. **Volume**: 20-day SMA, Volume Dry-Up (VDU) flag — detects institutional patience
3. **Market Structure**: Swing highs/lows, Support/Resistance zones
4. **Returns**: 20-day and 60-day returns (for RS ranking)
5. **Risk Metrics**: Gap risk score (percentile of historical gaps), liquidity bucket (A/B/C by median traded value)
6. **Output**: `features/{symbol}/days/{dateId}`

---

## Stage 3: Relative Strength Ranking

1. **Score**: Composite of 20-day + 60-day return percentile across entire universe
2. **Scale**: 0-99 (99 = strongest relative performer)
3. **Usage**: Per-strategy RS thresholds filter signals (PullbackEOD ≥60, ShortBounce ≤50, RSLeader ≥80)
4. **Output**: rsScore written to each feature doc

---

## Stage 4: Strategy Evaluation (per symbol)

Each symbol tested against 6 strategies simultaneously:

| Strategy | Regime | Key Gate | Direction |
|----------|--------|----------|-----------|
| PullbackEOD | TREND/RANGE | EMA touch + VDU active + RSI 38-58 | BUY |
| BreakoutCloseEOD | TREND | 20-day high + volume + consolidation | BUY |
| MeanReversionEOD | RANGE/BEAR | Below BB + RSI<30 (RANGE) or <25 (BEAR) | BUY |
| ShortBounceEOD | BEAR/HIGH_VOL | EMA touch + RSI 45-65 + bucket A | SELL |
| BearBounceEOD | BEAR/HIGH_VOL | RSI<25 + below BB + volume spike | BUY |
| RSLeaderEOD | Any | RS≥80 + EMA20>EMA50 + EMA touch | BUY |

Dynamic scoring adjusts base score with RS boost, VDU boost, regime modifiers.

---

## Stage 5: Risk Pipeline (13 Gates)

Each signal passes through:
1. Regime gate (tradeAllowed)
2. Feature validation (finite EMA/ATR)
3. RSI fail-closed
4. Kill switch
5. Event calendar (earnings, corporate actions, F&O bans)
6. Strategy-aware RS filter
7. Gap risk (reject ≥0.8)
8. Drawdown multiplier (halt at 20%)
9. Vol-targeting position sizing (12% annual target)
10. ADV liquidity cap (2% daily volume, ₹2Cr max)
11. Gap stress test (overnight worst-case)
12. Portfolio limits (positions, sectors, heat)
13. Correlation cluster (fail-closed)

---

## Stage 6: Execution Simulation (Next Day)

1. **Fill**: At next-day open price + dynamic slippage (2-40 bps by bucket × regime)
2. **Gap check**: If open gaps past stop → fill at open (not stop)
3. **Fees**: Full Indian breakdown — STT, stamp duty, exchange, SEBI, GST, brokerage
4. **Position**: Created in `portfolio/default/positions/`

---

## Stage 7: Position Management (Daily)

1. **P&L update**: Mark-to-market from latest bar
2. **MFE/MAE tracking**: Maximum favorable/adverse excursion in R-multiples
3. **Exit priority**: Hard stop → Time stop → Trailing stop → Profit target
4. **Closure**: Trade record created, aggregate stats updated, reconciliation logged
