# ProTrade | Alpha
A premium, modular trading backend and dashboard built for automated EOD (End of Day) strategies.

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- **Node.js**: v20+
- **Firebase CLI**: `npm install -g firebase-tools`
- **Java JRE**: Required for Firebase Emulators.

### 2. Backend Setup
```bash
cd functions
npm install
npm run build
```

### 3. Dashboard Setup
```bash
cd dashboard
npm install
```

## 🕹️ Operations Guide

### Step 1: Start the Emulators
In one terminal, launch the Firestore and Functions host:
```bash
firebase emulators:start
```

### Step 2: Run a Trading Simulation
Execute the end-to-end multi-day lifecycle (Data -> Features -> Signals -> Fills -> Exits):
```bash
cd functions
# In a Node-compatible shell:
$env:Path = "C:\tools\node-v20.11.1-win-x64;" + $env:Path; node run_simulation_direct.js
```

### Step 3: Launch the Dashboard
In another terminal, view your positions and PnL in real-time:
```bash
cd dashboard
npm run dev
```
Open the provided `localhost` URL in your browser.

## 📂 Project Structure
- **/functions**: Core backend services (TypeScript).
  - `/src/services`: Orchestrator, MarketData, Features, Strategy, Risk, Paper Broker.
  - `/src/models`: Shared Firestore schemas.
- **/dashboard**: Premium React + Vite frontend.
- **run_simulation_direct.js**: The main script for local end-to-end testing without external network dependencies.

## 🛠️ Technology Stack
- **Backend**: Firebase Cloud Functions (Gen 1), Firestore.
- **Frontend**: React, Vite, Lucide-React.
- **Data**: Yahoo Finance 2, TechnicalIndicators.
