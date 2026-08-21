import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';

// --- Shared Execution Options ---
const v1Options = {
  timeoutSeconds: 540, // Max for Cloud Functions v1
};

// V3.0: Runtime kill switch check (reads from Firestore, not just config)
async function checkRuntimeKillSwitch(): Promise<boolean> {
  try {
    const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
    const doc = await db.doc('config/runtime').get();
    return doc.exists && doc.data()?.killSwitch === true;
  } catch { return false; }
}

/**
 * Unified Gateway (v1): The single entry point for all system operations
 * V3.0: Wired middleware — validation, auth, rate limiting, kill switch
 */
export const gateway = functions.runWith(v1Options).https.onRequest(async (req, res) => {
    // CORS: allow dashboard origin
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

    const { validateRequest, validateApiKey, checkRateLimit } = await import('./middleware');

    // V3.0: Rate limiting
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || 'unknown';
    const rateCheck = checkRateLimit(req.body?.action || '', clientIp);
    if (!rateCheck.allowed) {
      res.status(429).send({ error: 'Rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs });
      return;
    }

    // V3.0: API key auth
    const authCheck = await validateApiKey(req);
    if (!authCheck.authenticated) {
      res.status(401).send({ error: authCheck.error || 'Unauthorized' });
      return;
    }

    const { action, taskType } = { ...req.query, ...req.body } as any;
    // Normalize: strip "Task" suffix from taskType to match gateway cases
    const normalizedTaskType = taskType?.replace(/Task$/, '') || undefined;
    const type = action || normalizedTaskType || taskType;

    // V3.0: Request validation (validate the resolved action from query OR body —
    // GET links like downloadReport pass the action in the query string).
    if (type && !taskType) {
      const validation = validateRequest({ ...req.query, ...req.body });
      if (!validation.valid) {
        res.status(400).send({ error: validation.error });
        return;
      }
    }

    if (!type) {
        res.status(400).send({ error: 'Missing action or taskType' });
        return;
    }

    // V3.0: Runtime kill switch — block trade-mutating actions
    const tradeMutatingActions = ['startEod', 'orchestrateEod', 'evaluateSignals', 'manageTrades'];
    if (tradeMutatingActions.includes(type)) {
      const killed = await checkRuntimeKillSwitch();
      if (killed) {
        const { raiseAlert, AlertType } = await import('./services/alerting');
        await raiseAlert(AlertType.KILL_SWITCH, 'CRITICAL', `Kill switch blocked action: ${type}`, { action: type });
        res.status(503).send({ error: 'System kill switch active — all trading halted' });
        return;
      }
    }

    // V3.0: PAPER_ONLY enforcement — block live broker actions
    const { RUNTIME_CONFIG } = await import('./config/runtime');
    if (RUNTIME_CONFIG.PAPER_ONLY && type === 'manageTrades') {
      // Ensure paper broker is always used (tradeManager already respects this, but belt-and-suspenders)
      req.body = { ...req.body, paperOnly: true };
    }

    try {
        switch (type) {
            // Orchestration
            case 'startEod': {
                const { doStartEodRun } = await import('./services/orchestrator');
                await doStartEodRun(req, res);
                break;
            }
            case 'startDeepSync': {
                const { doStartDeepSync } = await import('./services/orchestrator');
                await doStartDeepSync(req, res);
                break;
            }
            case 'terminate': {
                const { terminateJob } = await import('./services/orchestrator');
                await terminateJob(req, res);
                break;
            }

            // Tasks
            case 'fetchCandles': {
                const { fetchCandlesTask } = await import('./services/marketdata');
                await fetchCandlesTask(req, res);
                break;
            }
            case 'computeFeatures': {
                const { computeFeaturesTask } = await import('./services/features');
                await computeFeaturesTask(req, res);
                break;
            }
            case 'evaluateSignals': {
                const { evaluateSignalsTask } = await import('./services/strategy');
                await evaluateSignalsTask(req, res);
                break;
            }
            case 'computeRsRanking': {
                const { computeRsRankingTask } = await import('./services/rsRanking');
                await computeRsRankingTask(req, res);
                break;
            }
            case 'computeCorrTopN': {
                const { computeCorrTopNTask } = await import('./services/corrTopN');
                await computeCorrTopNTask(req, res);
                break;
            }
            case 'manageTrades': {
                const { manageTradesTask } = await import('./services/tradeManager');
                await manageTradesTask(req, res);
                break;
            }
            case 'processSymbol': {
                const { processSymbolTask } = await import('./services/orchestrator');
                await processSymbolTask(req);
                res.status(200).send({ success: true });
                break;
            }
            case 'orchestrateEod': {
                const { orchestrateEodTask } = await import('./services/orchestrator');
                await orchestrateEodTask(req);
                res.status(200).send({ success: true });
                break;
            }
            case 'orchestrateDeepSync': {
                const { orchestrateDeepSyncTask } = await import('./services/orchestrator');
                await orchestrateDeepSyncTask(req);
                res.status(200).send({ success: true });
                break;
            }

            // Diagnostics & Health
            case 'diagnostics': {
                const { diagnosticsHandler } = await import('./services/diag');
                // Forward POST body params to query for diagnosticsHandler compatibility
                const bodyParams = req.body || {};
                for (const key of ['type', 'jobId', 'date', 'level', 'limit', 'symbol', 'universe', 'status', 'colType', 'includeBar']) {
                  if (bodyParams[key] !== undefined && !req.query[key]) req.query[key] = bodyParams[key];
                }
                await diagnosticsHandler(req, res);
                break;
            }
            case 'checkHealth': {
                const { checkKiteHealth } = await import('./services/marketdata');
                await checkKiteHealth(req, res);
                break;
            }
            case 'updateToken': {
                const { updateKiteToken } = await import('./services/marketdata');
                await updateKiteToken(req, res);
                break;
            }
            case 'updateCredentials': {
                const { updateKiteCredentials } = await import('./services/marketdata');
                await updateKiteCredentials(req, res);
                break;
            }
            case 'probeInventory': {
                const { probeInventory } = await import('./services/diag');
                await probeInventory(req, res);
                break;
            }
            case 'auditJobs': {
                const { auditJobs } = await import('./services/maintenance');
                await auditJobs(req, res);
                break;
            }
            case 'auditSignals': {
                const { auditSignalsTask } = await import('./services/signalCritic');
                await auditSignalsTask(req, res);
                break;
            }
            case 'snapshot': {
                const { snapshotTask } = await import('./services/snapshot');
                await snapshotTask(req, res);
                break;
            }
            case 'downloadReport': {
                const { downloadReport } = await import('./services/diag');
                await downloadReport(req, res);
                break;
            }

            // V3.0: System health & scheduler
            case 'getKiteSettings': {
                const kdb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const ksnap = await kdb.collection('settings').doc('kite').get();
                const kdata = ksnap.data() || {};
                const mask = (v: string | undefined) => v ? v.substring(0, 3) + '***' + v.substring(v.length - 2) : '(not set)';
                res.status(200).send({
                  apiKey: mask(kdata.apiKey),
                  apiSecret: mask(kdata.apiSecret),
                  userId: kdata.userId || '(not set)',
                  password: kdata.password ? '***set***' : '(not set)',
                  totpSecret: kdata.totpSecret ? '***set***' : '(not set)',
                  status: kdata.status || 'UNKNOWN',
                  lastError: kdata.lastError || null,
                  lastAutoRenew: kdata.lastAutoRenew || null,
                  updatedAt: kdata.updatedAt || null,
                  hasAllFields: !!(kdata.apiKey && kdata.apiSecret && kdata.userId && kdata.password && kdata.totpSecret),
                });
                break;
            }
            case 'systemHealth': {
                const { getSystemHealth } = await import('./services/scheduler');
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const health = await getSystemHealth(db);
                res.status(200).send(health);
                break;
            }
            case 'sweepStuckJobs': {
                const { sweepStuckJobs } = await import('./services/scheduler');
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const swept = await sweepStuckJobs(db);
                res.status(200).send({ swept });
                break;
            }
            case 'getAlerts': {
                const { getUnacknowledgedAlerts } = await import('./services/alerting');
                const alerts = await getUnacknowledgedAlerts();
                res.status(200).send({ alerts });
                break;
            }

            // V3.1: Scheduled actions — called by Cloud Scheduler
            case 'scheduledKiteRenew': {
                console.log('[Scheduler] Auto-renewing Kite session...');
                const { autoRenewKiteSessionHandler } = await import('./services/kite_automation');
                await autoRenewKiteSessionHandler({});
                // Check if renewal succeeded
                const renewDb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const renewSnap = await renewDb.collection('settings').doc('kite').get();
                const renewData = renewSnap.data();
                if (renewData?.status === 'ERROR') {
                    res.status(500).send({ error: 'Auto-renewal failed', details: renewData.lastError });
                } else {
                    res.status(200).send({ message: 'Kite session auto-renewed', status: renewData?.status });
                }
                break;
            }
            case 'scheduledEod': {
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                // Holiday guard: skip if today is not a trading day
                const todayEod = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                const { isTradingDay: isTradingDayCheck } = await import('./services/scheduler');
                if (!isTradingDayCheck(todayEod)) {
                    console.log(`[Scheduler] Skipping scheduled EOD: ${todayEod} is a holiday/weekend`);
                    res.status(200).send({ message: `Skipped: ${todayEod} is not a trading day` });
                    break;
                }
                const kiteSnap = await db.collection('settings').doc('kite').get();
                const kiteData = kiteSnap.data();
                if (!kiteData?.accessToken || kiteData?.status !== 'ACTIVE') {
                    const { raiseAlert, AlertType } = await import('./services/alerting');
                    await raiseAlert(AlertType.SESSION_EXPIRED, 'CRITICAL', 'Scheduled EOD skipped: Kite session not active');
                    res.status(503).send({ error: 'Kite session not active' });
                    break;
                }
                // Auto-sync corporate events before EOD scan (non-blocking)
                try {
                    const { syncAllCorporateEvents } = await import('./services/eventSync');
                    const evtResult = await syncAllCorporateEvents(30);
                    console.log(`[Scheduler] Pre-EOD event sync: ${evtResult.earnings} earnings, ${evtResult.corporateActions} corp actions, ${evtResult.fnoBans} F&O bans`);
                } catch (syncErr: any) {
                    console.warn(`[Scheduler] Pre-EOD event sync failed (non-blocking): ${syncErr.message}`);
                }
                console.log(`[Scheduler] Starting scheduled EOD for ${todayEod}`);
                const { doStartEodRun } = await import('./services/orchestrator');
                await doStartEodRun({ body: { date: todayEod, universe: 'nifty200', force: true }, query: {} }, res);
                break;
            }
            case 'scheduledMorning': {
                // Morning fill simulation: fills previous day's ACCEPTED orders at today's open
                const morningDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                // Holiday guard: skip if today is not a trading day
                const { isTradingDay: isMorningTradingDay } = await import('./services/scheduler');
                if (!isMorningTradingDay(morningDate)) {
                    console.log(`[Scheduler] Skipping morning fill: ${morningDate} is a holiday/weekend`);
                    res.status(200).send({ message: `Skipped: ${morningDate} is not a trading day` });
                    break;
                }
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const kiteSnap = await db.collection('settings').doc('kite').get();
                const kiteData = kiteSnap.data();
                if (!kiteData?.accessToken || kiteData?.status !== 'ACTIVE') {
                    const { raiseAlert, AlertType } = await import('./services/alerting');
                    await raiseAlert(AlertType.SESSION_EXPIRED, 'CRITICAL', 'Scheduled Morning skipped: Kite session not active');
                    res.status(503).send({ error: 'Kite session not active' });
                    break;
                }
                console.log(`[Scheduler] Starting morning fill simulation for ${morningDate}`);
                const { doStartMorningExecution } = await import('./services/orchestrator');
                await doStartMorningExecution({ query: { date: morningDate, universe: 'nifty200' } }, res);
                break;
            }
            case 'startMorningExecution': {
                // Manual trigger: { action: "startMorningExecution", date: "2026-04-13", universe: "nifty500" }
                const { doStartMorningExecution } = await import('./services/orchestrator');
                await doStartMorningExecution({ query: { date: req.body?.date, universe: req.body?.universe || 'nifty500' } }, res);
                break;
            }

            case 'syncNseHolidays': {
                const { syncNseHolidays } = await import('./services/scheduler');
                const hdb = admin.apps.length ? admin.firestore() : (admin.initializeApp(), admin.firestore());
                const result = await syncNseHolidays(hdb);
                res.status(200).send({ message: `Synced ${result.synced} holidays`, source: result.source });
                break;
            }

            case 'syncCorporateEvents': {
                const { syncAllCorporateEvents } = await import('./services/eventSync');
                const lookAhead = Number(req.body?.lookAheadDays) || 30;
                const result = await syncAllCorporateEvents(lookAhead);
                res.status(200).send({
                    message: 'Corporate events synced',
                    earnings: result.earnings,
                    corporateActions: result.corporateActions,
                    fnoBans: result.fnoBans,
                });
                break;
            }

            case 'backfillHistorical': {
                const { runHistoricalBackfill } = await import('./services/historicalBackfill');
                const result = await runHistoricalBackfill({
                    universeId: req.body?.universe || 'nifty500',
                    startISO: req.body?.start,
                    endISO: req.body?.end,
                    maxSymbols: Number(req.body?.maxSymbols) || 500,
                });
                res.status(200).send(result);
                break;
            }

            case 'resetTradingState': {
                const { runResetTradingState } = await import('./services/resetState');
                const result = await runResetTradingState({
                    equity: Number(req.body?.equity) || 1000000,
                });
                res.status(200).send(result);
                break;
            }

            case 'cleanupStale': {
                const { runStaleCleanup } = await import('./services/cleanupStale');
                const result = await runStaleCleanup(req.body?.retention);
                res.status(200).send({ message: 'Stale data cleaned', deleted: result });
                break;
            }

            default: res.status(400).send({ error: `Unknown op: ${type}` });
        }
    } catch (err: any) {
        console.error(`[Gateway] Op ${type} failed:`, err);
        res.status(500).send({ error: err.message });
    }
});

// Queue Placeholders for v1
export const taskDispatcher = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: { ...data, taskType: 'taskDispatcher' }, query: {} } as any);
});

export const processSymbolTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: { ...data, taskType: 'processSymbol' }, query: {} } as any);
});

export const orchestrateEodTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: { ...data, taskType: 'orchestrateEod' }, query: {} } as any);
});

export const orchestrateDeepSyncTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: { ...data, taskType: 'orchestrateDeepSync' }, query: {} } as any);
});

// Private helper to resolve types inside onDispatch
async function gatewayHandler(req: any) {
    const { taskType } = req.body;
    try {
        switch (taskType) {
            case 'processSymbol': {
                const { processSymbolTask: task } = await import('./services/orchestrator');
                return await task(req);
            }
            case 'orchestrateEod': {
                const { orchestrateEodTask: task } = await import('./services/orchestrator');
                return await task(req);
            }
            case 'orchestrateDeepSync': {
                const { orchestrateDeepSyncTask: task } = await import('./services/orchestrator');
                return await task(req);
            }
            default: console.warn(`[TaskBridge] Unknown taskType: ${taskType}`);
        }
    } catch (err) {
        console.error(`[TaskBridge] Failed: ${err}`);
    }
}

// V3.1: Scheduled actions — called by Google Cloud Scheduler via HTTP POST to gateway
// Setup: Create 3 Cloud Scheduler jobs in GCP Console:
//   1. kite-auto-renew: POST https://us-central1-suhas-ag.cloudfunctions.net/gateway
//      Body: {"action":"scheduledKiteRenew"}  Cron: 30 8 * * 1-5  TZ: Asia/Kolkata
//   2. daily-eod: POST https://us-central1-suhas-ag.cloudfunctions.net/gateway
//      Body: {"action":"scheduledEod"}  Cron: 30 16 * * 1-5  TZ: Asia/Kolkata
//   3. morning-fill: POST https://us-central1-suhas-ag.cloudfunctions.net/gateway
//      Body: {"action":"scheduledMorning"}  Cron: 15 9 * * 1-5  TZ: Asia/Kolkata

// V3.2: Native scheduled Kite session auto-renew.
// Deploying this function auto-provisions the Cloud Scheduler job — no manual
// GCP Console step required. Runs at 08:30 IST Mon–Fri (before market open) so a
// fresh access token is in settings/kite ahead of the morning-fill and EOD runs.
// Kite tokens expire daily (~07:30 IST), so a daily pre-open renew is required.
export const scheduledKiteRenew = functions
  .runWith(v1Options)
  .pubsub.schedule('30 8 * * 1-5')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    console.log('[Scheduler] Auto-renewing Kite session (native schedule)...');
    const { autoRenewKiteSessionHandler } = await import('./services/kite_automation');
    await autoRenewKiteSessionHandler({});
    const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
    const snap = await db.collection('settings').doc('kite').get();
    const status = snap.data()?.status;
    if (status === 'ERROR') {
      console.error('[Scheduler] Kite auto-renew failed:', snap.data()?.lastError);
    } else {
      console.log(`[Scheduler] Kite session renewed (status=${status})`);
    }
    return null;
  });

function scheduledResponse(): any {
    return {
        status: (code: number) => ({
            send: (body: unknown) => console.log(`[Scheduler] Native action response ${code}`, body),
        }),
    };
}

/** Native EOD schedule; supersedes the manually-created gateway scheduler job. */
export const scheduledEod = functions
    .runWith(v1Options)
    .pubsub.schedule('30 16 * * 1-5')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const { isTradingDay } = await import('./services/scheduler');
        if (!isTradingDay(date)) {
            console.log(`[Scheduler] Skipping native EOD: ${date} is not a trading day`);
            return null;
        }
        const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
        const kite = (await db.collection('settings').doc('kite').get()).data();
        if (!kite?.accessToken || kite.status !== 'ACTIVE') {
            console.warn('[Scheduler] Skipping native EOD: Kite session is not active');
            return null;
        }
        try {
            const { syncAllCorporateEvents } = await import('./services/eventSync');
            await syncAllCorporateEvents(30);
        } catch (error) {
            console.warn('[Scheduler] Native EOD event sync failed:', error);
        }
        const { doStartEodRun } = await import('./services/orchestrator');
        await doStartEodRun({ body: { date, universe: 'nifty200', force: true }, query: {} }, scheduledResponse());
        return null;
    });

/** Native morning fill schedule; supersedes the manually-created gateway scheduler job. */
export const scheduledMorning = functions
    .runWith(v1Options)
    .pubsub.schedule('15 9 * * 1-5')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const { isTradingDay } = await import('./services/scheduler');
        if (!isTradingDay(date)) {
            console.log(`[Scheduler] Skipping native morning fill: ${date} is not a trading day`);
            return null;
        }
        const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
        const kite = (await db.collection('settings').doc('kite').get()).data();
        if (!kite?.accessToken || kite.status !== 'ACTIVE') {
            console.warn('[Scheduler] Skipping native morning fill: Kite session is not active');
            return null;
        }
        const { doStartMorningExecution } = await import('./services/orchestrator');
        await doStartMorningExecution({ query: { date, universe: 'nifty200' } }, scheduledResponse());
        return null;
    });
