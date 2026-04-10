# ProTrade Alpha — System Summary V3.1

## What It Does
Autonomous EOD swing-trading system for Indian equities (NSE). Fetches daily data via Kite Connect, evaluates 6 strategies across 500+ symbols, applies a 13-gate risk pipeline, and manages paper positions with realistic slippage and fees.

## Core Pipeline (Daily)
1. **Fetch** — Kite Connect OHLCV candles → `barsD/{symbol}/days/{dateId}`
2. **Features** — EMA20/50/200, RSI14, ATR14, Bollinger Bands, VDU, gap risk → `features/{symbol}/days/{dateId}`
3. **RS Rank** — Relative strength 0-99 across universe
4. **Regime** — Market state detection (TREND/RANGE/BEAR/HIGH_VOL/TRANSITION) with hysteresis
5. **Signals** — 6 strategies: PullbackEOD, BreakoutCloseEOD, MeanReversionEOD, ShortBounceEOD, BearBounceEOD, RSLeaderEOD
6. **Risk** — 13-gate pipeline: RS filter, gap risk, drawdown, vol-targeting, ADV, correlation clusters
7. **Orders** — Paper orders created for approved signals (NEXT_OPEN entry)
8. **Fills** — Next-day open fill simulation with dynamic slippage + Indian fee breakdown

## Technology
- Firebase Cloud Functions gen1 (single gateway, 540s timeout)
- Firestore (all state)
- React + Vite dashboard on Firebase Hosting
- Kite Connect API (market data + broker)
- Cloud Scheduler for daily automation

## Key Numbers
- 6 strategies (3 bull, 2 bear, 1 all-regime)
- 13 risk gates
- 86 tests across 10 suites
- 500+ symbols in universe
- 24+ gateway actions
- **Loss-Based Cooldowns**: The system automatically pauses or scales down risk after a series of significant losses.

---

## Technical Stack
- **Cloud**: Firebase Cloud Functions (Node.js 20, 2nd Gen).
- **Data Storage**: Firestore (Real-time NoSQL).
- **Data Feeds**: Zerodha Kite Connect (Main) with Yahoo Finance (Secondary Fallback).
- **Frontend**: Vite + React + Tailwind + Lucide Icons for a premium monitoring experience.

---

*This system turns raw market data into institutional-grade executions by enforcing mathematical discipline at every step.*
