---
description: Mandatory Regression-First Development Workflow
---

// turbo-all

This workflow MUST be followed BEFORE and AFTER every code change or deployment to the `suhas-ag` project.

---

## ⚠️ Rate Limiting Rule (Always Check First)

**Before any change to market data fetching, orchestration, or task dispatch:**

- The Kite Historical Data API allows a maximum of **3 requests per second** per API key.
- The system MUST always dispatch tasks sequentially at **350ms intervals** (~2.85 reqs/sec).
- Each task handler MUST include a **0–500ms randomized jitter** before calling Kite.
- Never use `Promise.all()` or batch-concurrent fetches directly against the Kite API.
- Any change that modifies `enqueueDispatch`, `doFetchCandles`, or `fetchFromKite` must verify it does NOT break this constraint.
- If in doubt: **serialize, don't parallelize.**

---

## PRE-CHANGE CHECKS (Before writing code)

1. **Run Regression & Rule Validation**
   - Command: `npm run validate-rules && npm run regression` (in `functions` directory).
   - Expected Output: `--- VALIDATION PASSED ---` and `--- REGRESSION TEST PASSED ---`.
   - Do NOT proceed if either fails.

2. **Check Rate Limiting Compliance**
   - Confirm the change does NOT:
     - Remove the `350ms` sequential delay between task dispatches in `orchestrator.ts`.
     - Remove the `0–500ms` jitter in `doFetchCandles`.
     - Re-introduce `Promise.all()` concurrent fetches against the Kite API.

3. **Analyze Potential Breakages**
   - If touching `orchestrator.ts` or `tasks.ts`, identify all dependent functions.
   - If touching backend models/data shapes, verify the dashboard (`App.tsx`) uses matching field names.
   - Check for holiday detection logic: the "most recent bar within 5 days" query must remain intact.

---

## POST-CHANGE CHECKS (After every deployment)

4. **Verify Deployment & KITE Health**
   - Run `firebase functions:log --project suhas-ag -n 20` and confirm no cold-start errors.
   - Run `Invoke-WebRequest -Uri "https://us-central1-suhas-ag.cloudfunctions.net/checkKiteHealth"` and confirm `{"status": "ACTIVE"}`.

5. **Trigger a Job and Monitor (Mandatory Checks)**
   - Trigger a small test run (Nifty50) from the dashboard.
   - **Rule: Single Job Only** - Attempt to trigger a second job immediately; it MUST show "Job already running" or be blocked.
   - Confirm in logs:
     - `Index check passed. Most recent bar: ...` (Correct skip/fetch logic).
     - **Rule: Redundant Skip** - Verify that if data exists, `doFetchCandles` logs `Skipping duplicate fetch`.
     - `Dispatching N tasks at 350ms intervals...` (Rate limiting active).
     - **Rule: Component Recalculation** - Confirm `Computing Market Regime` and `Evaluating Signals` occur even if bars are skipped.
   - Confirm the **progress bar updates** (FETCH → REGIME → SIGNALS → done) and does NOT get stuck.

6. **Dashboard & Inventory Verification**
   - **Rule: System Data Inventory** - Refresh the dashboard and verify the "System Data Inventory" table shows updated groupings (e.g., `43 days | 200 symbols`).
   - Verify `done/total` count increments correctly.
   - Verify no 429 rate limit errors from Kite API.

7. **Scheduling & Sign-Off**
   - **Rule: Morning Run Schedule** - Verify Cloud Scheduler matches the desired morning execution time (e.g. 09:15 IST).
   - Job must reach `status: DONE` for the change to be considered safe.
   - If any check fails, roll back and diagnose before re-attempting.
