# System Context & Architecture
This document serves as a persistent brain for the ProTrade project, detailing the architecture, data structures, and the roadmap for adding more advanced features.

## 🏗️ System Architecture
The system is built on a **Modular Service Architecture** using Firebase Cloud Functions (Gen 1 & 2) and Firestore.

> [!NOTE]
> **Status**: LIVE on `suhas-ag`
> **Dashboard**: [https://suhas-ag.web.app](https://suhas-ag.web.app)
> **Daily Automations**: Active via Cloud Scheduler.

### Core Services
1.  **Orchestrator**: Manages the EOD and Morning workflow, enqueuing tasks.
2.  **MarketData**: Robust fetching and ingestion from Yahoo Finance.
3.  **Features**: Computes Technical Indicators (EMA, RSI, ATR) and Market Structure (Swing H/L, S/R Zones).
4.  **Strategy**: Evaluates entry/exit rules (e.g., Trend Pullback).
5.  **Risk**: enforces position sizing and portfolio-wide risk limits.
6.  **Paper Broker**: Simulates order fills, tracks open positions, and monitors stop/target exits.

## 📊 Data Models (Firestore)
- **`barsD/{symbol}/days/{dateId}`**: 1-day OHLCV candles.
- **`features/{symbol}/days/{dateId}`**: Computed indicators and market structure.
- **`signals/{dateId}/items/{signalId}`**: Strategy-generated triggers.
- **`paperOrders/{dateId}/items/{orderId}`**: Approved entry/exit orders.
- **`positions/{symbol}`**: Active and closed paper trades with live PnL.
- **`paperFills/{dateId}/items/{fillId}`**: Execution records.

## ⚒️ Development Environment & Tooling
The development environment is configured with specific tool paths located in the `C:\tools` directory.

- **Node.js**: `C:\tools\node-v20.11.1-win-x64\node.exe`
- **NPM**: `C:\tools\node-v20.11.1-win-x64\npm.cmd`
- **Firebase CLI**: `C:\tools\node-v20.11.1-win-x64\firebase.cmd`

> [!TIP]
> When running terminal commands, ensure these paths are used if the global shortcuts are not available in the shell.

## 🚀 Future Roadmap

### 1. Advanced Analytical Layer
- **Candlestick Patterns**: Integrate `binary-candle` or similar for Dojis, Engulfing, etc.
- **Volume Profile**: Implement POC (Point of Control) and Value Area calculations.
- **Multi-Timeframe Analysis**: Pull 60m data to verify EOD signals.

### 2. Strategy Expansion
- **Mean Reversion**: Use Bollinger Bands and RSI extremes.
- **Breakout/Momentum**: Implement Volatility Contraction Pattern (VCP) detection.

### 3. Execution & Risk
- **Trailing Stops**: Update the Exit Monitor to trail ATR or Swing Lows.
- **Shadow Staging**: Log signals to a private Telegram/Discord channel for real-time review.
- **Live Integration**: Create adaptive adapter layers for Kite/Zerodha or Alpaca APIs.

### 4. Dashboard Enhancements
- **Equity Curve**: Visualize the historical progression of realized PnL.
- **Strategy Comparison**: Chart win rates and drawdowns per strategy type.

## 🔑 Design Principles
- **Data First**: All trading decisions must be logged and traceable in Firestore.
- **Simulation Proof**: Logic functions are decoupled from Firebase triggers to ensure easy local testing.
- **Risk Preservation**: The Risk Engine is the final gatekeeper for all orders.

## 🤖 AI Agent Protocols
To maintain system stability and knowledge continuity, all AI agents must follow these rules:
1. **Troubleshooting Logs**: Whenever a new technical issue is encountered and solved (e.g., deployment errors, logic bugs, data mismatches), it **must** be documented in [TROUBLESHOOTING.md](file:///d:/protrade/TROUBLESHOOTING.md) immediately.
2. **Context Updates**: Significant architectural changes or new service additions must be reflected in this `CONTEXT.md` file.
