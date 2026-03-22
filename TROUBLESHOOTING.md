# Troubleshooting Guide
This document tracks common issues encountered during development and solutions for future runtime stability.

> [!IMPORTANT]
> **Mandatory Update Rule**: AI Agents must append all new issues, symptoms, and fixes to this document as soon as they are resolved. This is a primary requirement for maintainability.

## 🔸 Firebase Emulator Issues

### 1. "Firestore does not support descending key scans"
- **Symptom**: Query error when using `orderBy('__name__', 'desc')` in the emulator.
- **Solution**: The emulator has stricter limits than production Firestore for name-based scans. 
- **Fix**: Fetch all documents for the symbol and sort/limit in-memory in the service layer. (Already implemented in `features.ts` and `strategy.ts`).

### 2. Networking / 404 Errors
- **Symptom**: Calling emulator functions via HTTP triggers fails with connection refused or 404.
- **Solution**: Networking in the local emulator environment can be flaky on some OSs.
- **Fix**: Use `run_simulation_direct.js` to invoke the core `do*` logic functions directly while setting `FIRESTORE_EMULATOR_HOST`. This bypasses unreliable HTTP routing.

## 🔸 Market Data Issues

### 1. "Yahoo removes API" / 404s
- **Symptom**: `yahoo-finance2` library fails to fetch historical data.
- **Solution**: Yahoo occasionally changes endpoints. 
- **Fix**: Ensure the library is updated. The project uses `yahooFinance.historical` which sometimes maps to `chart()`. If data fails for a specific date, try shifting the simulation date to a weekday.

### 2. "Bar not found"
- **Symptom**: Simulation fails during Morning phase because it can't find the bar for `runDate`.
- **Solution**: Likely a weekend (Sat/Sun) or a market holiday where data wasn't generated.
- **Fix**: Only run simulations on valid trading dates (e.g., Mar 12, 13, 2026).

## 🔸 Tooling & PATH Issues

### 1. "Command not recognized" (node, npm, firebase)
- **Symptom**: Terminal returns `The term 'npm' is not recognized` or similar.
- **Solution**: The binaries are installed in a non-standard tools directory and may not be in the system's `PATH`.
- **Fix**: Use the absolute paths documented in `CONTEXT.md` or manually add `C:\tools\node-v20.11.1-win-x64` to the environment variables.

## 🔸 Logic & Data Stability

### 1. Indicators returning `undefined`
- **Symptom**: Firestore error "Cannot use undefined as a Firestore value".
- **Solution**: Occurs when technical indicators (EMA, RSI) are given too few bars (e.g., calculating EMA20 with only 10 bars).
- **Fix**: `features.ts` implements **Adaptive Indicators** that reduce the period to match available data or use safe defaults. Also, `ignoreUndefinedProperties` is enabled in Firestore settings.

### 2. Date ID Mismatches
- **Symptom**: Data exists but lookups fail.
- **Solution**: Inconsistent formatting between `YYYY-MM-DD` and `YYYYMMDD`.
- **Fix**: Standardize all lookup IDs using `.replace(/-/g, '')` consistently across all services.

## 🔸 Deployment & Production Stability

### 1. Deployment Timeouts (Cloud Functions)
- **Symptom**: `firebase deploy` fails with "Function update operation timed out" or cold starts are very slow.
- **Solution**: Heavy top-level imports like `technicalindicators` and `yahoo-finance2` increase the bundle analysis time and cold start latency.
- **Fix**: Use **Dynamic/Lazy Imports** within the function handlers (e.g., `const { ... } = await import(...)`) to only load large libraries when actually needed.

### 2. Dashboard Progress "Stuck at 0%"
- **Symptom**: On-demand scans show 0% progress for a long time even if they are running.
- **Solution**: Batch updates were too infrequent (every 10 symbols) or missing entirely in some stages (Morning logic).
- **Fix**: Update the `jobs` document in Firestore for **Every Symbol** processed (success or failure) to provide immediate, smooth visual feedback in the UI.

### 3. "Fetch Failed" / CORS Errors on New Triggers
- **Symptom**: Calling new HTTP triggers (like `cleanupData`) from the dashboard console fails with CORS/preflight errors.
- **Solution**: New triggers in `index.ts` must explicitly enable CORS in their configuration.
- **Fix**: Set `{ cors: true }` in the `onRequest` options for all public-facing HTTP triggers.

### 4. "Function matches no filter" during Deployment
- **Symptom**: `firebase deploy --only functions:name` fails despite the code existing in `index.ts`.
- **Solution**: The `package.json` main entry point was pointing to `index.js` while the TypeScript compiler (`tsc`) was outputting to a `lib/` directory.
- **Fix**: Ensure `package.json` "main" is set to `"lib/index.js"` so the Firebase CLI can find the compiled entry point.

### 5. Intermittent "Fetch Failed" or Null Values (Yahoo Finance)
- **Symptom**: Logs show `TypeError: fetch failed` or `Historical returned a result with SOME (but not all) null values` for specific symbols.
- **Solution**: These are typically transient network issues or temporary data gaps on Yahoo's side, often occurring during high-concurrency scans.
- **Fix**: The orchestrator handles these by logging the failure and marking the symbol as 'failed' in the job's `counts`. If a scan has many failures, re-triggering it usually resolves the issue as the data becomes available or the network flakiness passes.
