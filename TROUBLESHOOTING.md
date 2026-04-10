# Troubleshooting Guide — ProTrade Alpha V3.1

Common issues and their solutions.

---

## Deployment

### "Must build before deploy"
- **Symptom**: Deployed functions behave stale or show old bugs.
- **Cause**: `firebase.json` has no `predeploy` hook. TypeScript isn't compiled automatically.
- **Fix**: Always run `cd functions && npm run build && cd .. && firebase deploy --only functions`

### "Function matches no filter"
- **Symptom**: `firebase deploy --only functions:gateway` fails.
- **Cause**: `package.json` main must match tsc output directory.
- **Fix**: Ensure `"main": "lib/index.js"` in `functions/package.json`.

### Firebase Scheduled Functions Not Discovered
- **Symptom**: `functions.pubsub.schedule()` or v2 `onSchedule` compiles but isn't deployed.
- **Cause**: firebase-functions v6.3.2 with gen1 imports; CLI only discovers https/taskQueue triggers.
- **Fix**: Use gateway HTTP actions + Cloud Scheduler. Don't use native scheduled functions.

---

## Market Data

### Kite Session Expired
- **Symptom**: EOD run fails with "Kite session not active" or fetches return auth errors.
- **Cause**: Kite access tokens expire daily.
- **Fix**: 
  1. Manual: Dashboard → Settings → paste new token, or use OAuth redirect
  2. Automated: `scheduledKiteRenew` gateway action (requires correct TOTP secret)

### Kite Auto-Renewal Fails ("Invalid App Code")
- **Symptom**: TOTP verification fails, "Invalid App Code", attempts decrement.
- **Cause**: TOTP secret must be the **base32 seed string** from Kite's 2FA setup page (not the 6-digit code).
- **Fix**: In Kite settings, when setting up TOTP, copy the secret key (e.g., `JBSWY3DPEHPK3PXP`), not the generated code. Update via Settings tab.
- **Warning**: Zerodha locks account after ~5 failed TOTP attempts. Wait for lockout reset.

### "Universe is empty" Warning
- **Symptom**: Logs show "universe is empty" or 0 symbols evaluated.
- **Cause**: Universe collection `universes/nifty500/members` not seeded, or path mismatch.
- **Fix**: Run `{"action":"seedUniverse","universe":"nifty500"}` via gateway.

### "DATA_STALE" Error
- **Symptom**: Signal evaluation throws "Last bar date does not match run date".
- **Cause**: Bar data is from a different date than the run date. Common in backfill or when market data fetch failed.
- **Fix**: Verify bars exist for the run date. In PAPER_LIVE mode, staleness is strictly enforced.

---

## Pipeline

### Job Stuck at RUNNING
- **Symptom**: Job shows RUNNING for >30 minutes, progress frozen.
- **Cause**: Orchestrator stage barrier waiting for failed symbols; or Cloud Tasks not firing.
- **Fix**: 
  1. `{"action":"sweepStuckJobs"}` — auto-detects and fails stuck jobs
  2. `{"action":"auditJobs"}` — diagnoses job state
  3. Manual: `{"action":"terminate","jobId":"..."}` to force-fail

### "Correlation check failed (fail-closed)"
- **Symptom**: All signals rejected with correlation error.
- **Cause**: `corrTopN` data not computed for previous trading date. Correlation is fail-closed.
- **Fix**: Run `{"action":"computeCorrTopN","dateId":"YYYYMMDD"}` for the previous trading day.

### No Signals Generated (0 of N)
- **Symptom**: EOD run completes but 0 signals.
- **Cause**: Legitimate in bear markets if no strategy gates are met. Check:
  1. Regime state (TRANSITION blocks all entries)
  2. RSI fail-closed (missing RSI → all rejected)
  3. VDU gate (PullbackEOD requires VDU active)
  4. Kill switch active
- **Fix**: Check logs for rejection reasons. Each gate failure is logged.

---

## Dashboard

### Can't See Settings Tab
- **Symptom**: Settings tab missing from navigation.
- **Cause**: Stale dashboard build deployed.
- **Fix**: `cd dashboard && npm run build && cd .. && firebase deploy --only hosting`

### CORS Errors Calling Gateway
- **Symptom**: Browser console shows CORS/preflight errors.
- **Cause**: Gateway CORS headers not matching origin.
- **Fix**: Gateway allows all origins (`*`). If still failing, check the request includes `Content-Type: application/json`.

---

## Testing

### Strategy Test Fails on Timestamp
- **Symptom**: `checkSafety` throws DATA_STALE in tests.
- **Cause**: Mock bar timestamp uses `Date.now()` but runDate is in the future.
- **Fix**: Mock timestamp must match the test's runDate. See `strategy.test.ts` for pattern.

### Mock Get Sequence Issues
- **Symptom**: Test assertions fail because wrong data returned from Firestore mocks.
- **Cause**: Shared chainable mock (`jest.setup.js`) returns `mockResolvedValueOnce` in order. Adding strategies or event checks changes the consumption order.
- **Fix**: Only mock the critical first 6 gets (features, regime, account, positions, signals, bars). Let remaining calls fall through to default mock.
