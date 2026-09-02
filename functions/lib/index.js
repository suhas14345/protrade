"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduledMorning = exports.scheduledEod = exports.scheduledKiteRenew = exports.orchestrateDeepSyncTask = exports.orchestrateEodTask = exports.processSymbolTask = exports.taskDispatcher = exports.gateway = void 0;
const functions = __importStar(require("firebase-functions/v1"));
const admin = __importStar(require("firebase-admin"));
// --- Shared Execution Options ---
const v1Options = {
    timeoutSeconds: 540, // Max for Cloud Functions v1
};
// V3.0: Runtime kill switch check (reads from Firestore, not just config)
async function checkRuntimeKillSwitch() {
    var _a;
    try {
        const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
        const doc = await db.doc('config/runtime').get();
        return doc.exists && ((_a = doc.data()) === null || _a === void 0 ? void 0 : _a.killSwitch) === true;
    }
    catch (_b) {
        return false;
    }
}
/**
 * Unified Gateway (v1): The single entry point for all system operations
 * V3.0: Wired middleware — validation, auth, rate limiting, kill switch
 */
exports.gateway = functions.runWith(v1Options).https.onRequest(async (req, res) => {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    // CORS: allow dashboard origin
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }
    const { validateRequest, validateApiKey, checkRateLimit } = await Promise.resolve().then(() => __importStar(require('./middleware')));
    // V3.0: Rate limiting
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const rateCheck = checkRateLimit(((_a = req.body) === null || _a === void 0 ? void 0 : _a.action) || '', clientIp);
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
    const { action, taskType } = Object.assign(Object.assign({}, req.query), req.body);
    // Normalize: strip "Task" suffix from taskType to match gateway cases
    const normalizedTaskType = (taskType === null || taskType === void 0 ? void 0 : taskType.replace(/Task$/, '')) || undefined;
    const type = action || normalizedTaskType || taskType;
    // V3.0: Request validation (validate the resolved action from query OR body —
    // GET links like downloadReport pass the action in the query string).
    if (type && !taskType) {
        const validation = validateRequest(Object.assign(Object.assign({}, req.query), req.body));
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
            const { raiseAlert, AlertType } = await Promise.resolve().then(() => __importStar(require('./services/alerting')));
            await raiseAlert(AlertType.KILL_SWITCH, 'CRITICAL', `Kill switch blocked action: ${type}`, { action: type });
            res.status(503).send({ error: 'System kill switch active — all trading halted' });
            return;
        }
    }
    // V3.0: PAPER_ONLY enforcement — block live broker actions
    const { RUNTIME_CONFIG } = await Promise.resolve().then(() => __importStar(require('./config/runtime')));
    if (RUNTIME_CONFIG.PAPER_ONLY && type === 'manageTrades') {
        // Ensure paper broker is always used (tradeManager already respects this, but belt-and-suspenders)
        req.body = Object.assign(Object.assign({}, req.body), { paperOnly: true });
    }
    try {
        switch (type) {
            // Orchestration
            case 'startEod': {
                const { doStartEodRun } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartEodRun(req, res);
                break;
            }
            case 'startDeepSync': {
                const { doStartDeepSync } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartDeepSync(req, res);
                break;
            }
            case 'terminate': {
                const { terminateJob } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await terminateJob(req, res);
                break;
            }
            // Tasks
            case 'fetchCandles': {
                const { fetchCandlesTask } = await Promise.resolve().then(() => __importStar(require('./services/marketdata')));
                await fetchCandlesTask(req, res);
                break;
            }
            case 'computeFeatures': {
                const { computeFeaturesTask } = await Promise.resolve().then(() => __importStar(require('./services/features')));
                await computeFeaturesTask(req, res);
                break;
            }
            case 'evaluateSignals': {
                const { evaluateSignalsTask } = await Promise.resolve().then(() => __importStar(require('./services/strategy')));
                await evaluateSignalsTask(req, res);
                break;
            }
            case 'computeRsRanking': {
                const { computeRsRankingTask } = await Promise.resolve().then(() => __importStar(require('./services/rsRanking')));
                await computeRsRankingTask(req, res);
                break;
            }
            case 'computeCorrTopN': {
                const { computeCorrTopNTask } = await Promise.resolve().then(() => __importStar(require('./services/corrTopN')));
                await computeCorrTopNTask(req, res);
                break;
            }
            case 'manageTrades': {
                const { manageTradesTask } = await Promise.resolve().then(() => __importStar(require('./services/tradeManager')));
                await manageTradesTask(req, res);
                break;
            }
            case 'processSymbol': {
                const { processSymbolTask } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await processSymbolTask(req);
                res.status(200).send({ success: true });
                break;
            }
            case 'orchestrateEod': {
                const { orchestrateEodTask } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await orchestrateEodTask(req);
                res.status(200).send({ success: true });
                break;
            }
            case 'orchestrateDeepSync': {
                const { orchestrateDeepSyncTask } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await orchestrateDeepSyncTask(req);
                res.status(200).send({ success: true });
                break;
            }
            // Diagnostics & Health
            case 'diagnostics': {
                const { diagnosticsHandler } = await Promise.resolve().then(() => __importStar(require('./services/diag')));
                // Forward POST body params to query for diagnosticsHandler compatibility
                const bodyParams = req.body || {};
                for (const key of ['type', 'jobId', 'date', 'level', 'limit', 'symbol', 'universe', 'status', 'colType', 'includeBar']) {
                    if (bodyParams[key] !== undefined && !req.query[key])
                        req.query[key] = bodyParams[key];
                }
                await diagnosticsHandler(req, res);
                break;
            }
            case 'checkHealth': {
                const { checkKiteHealth } = await Promise.resolve().then(() => __importStar(require('./services/marketdata')));
                await checkKiteHealth(req, res);
                break;
            }
            case 'updateToken': {
                const { updateKiteToken } = await Promise.resolve().then(() => __importStar(require('./services/marketdata')));
                await updateKiteToken(req, res);
                break;
            }
            case 'updateCredentials': {
                const { updateKiteCredentials } = await Promise.resolve().then(() => __importStar(require('./services/marketdata')));
                await updateKiteCredentials(req, res);
                break;
            }
            case 'probeInventory': {
                const { probeInventory } = await Promise.resolve().then(() => __importStar(require('./services/diag')));
                await probeInventory(req, res);
                break;
            }
            case 'auditJobs': {
                const { auditJobs } = await Promise.resolve().then(() => __importStar(require('./services/maintenance')));
                await auditJobs(req, res);
                break;
            }
            case 'auditSignals': {
                const { auditSignalsTask } = await Promise.resolve().then(() => __importStar(require('./services/signalCritic')));
                await auditSignalsTask(req, res);
                break;
            }
            case 'snapshot': {
                const { snapshotTask } = await Promise.resolve().then(() => __importStar(require('./services/snapshot')));
                await snapshotTask(req, res);
                break;
            }
            case 'downloadReport': {
                const { downloadReport } = await Promise.resolve().then(() => __importStar(require('./services/diag')));
                await downloadReport(req, res);
                break;
            }
            case 'watchlistStats': {
                const { watchlistConversionStats } = await Promise.resolve().then(() => __importStar(require('./services/reporting')));
                await watchlistConversionStats(req, res);
                break;
            }
            case 'ingestFundamentals': {
                const { doIngestFundamentals } = await Promise.resolve().then(() => __importStar(require('./services/fundamentals')));
                await doIngestFundamentals(req, res);
                break;
            }
            case 'syncFundamentals': {
                const { doSyncFundamentals } = await Promise.resolve().then(() => __importStar(require('./services/fundamentals')));
                await doSyncFundamentals(req, res);
                break;
            }
            case 'getFundamentalsQuality': {
                const { getFundamentalsQuality } = await Promise.resolve().then(() => __importStar(require('./services/fundamentals')));
                await getFundamentalsQuality(req, res);
                break;
            }
            // V3.0: System health & scheduler
            case 'getKiteSettings': {
                const kdb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const ksnap = await kdb.collection('settings').doc('kite').get();
                const kdata = ksnap.data() || {};
                const mask = (v) => v ? v.substring(0, 3) + '***' + v.substring(v.length - 2) : '(not set)';
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
            case 'getTelegramSettings': {
                const tdb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const tsnap = await tdb.collection('settings').doc('telegram').get();
                const tdata = tsnap.data() || {};
                res.status(200).send({
                    botToken: tdata.botToken ? '***set***' : '(not set)',
                    chatId: tdata.chatId || '(not set)',
                    enabled: !!tdata.enabled,
                    hasAllFields: !!(tdata.botToken && tdata.chatId),
                });
                break;
            }
            case 'updateTelegram': {
                const tdb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const { botToken, chatId, enabled } = Object.assign(Object.assign({}, req.query), req.body);
                const update = { updatedAt: admin.firestore.Timestamp.now() };
                if (typeof botToken === 'string' && botToken.trim())
                    update.botToken = botToken.trim();
                if (typeof chatId === 'string' && chatId.trim())
                    update.chatId = chatId.trim();
                if (typeof enabled === 'boolean')
                    update.enabled = enabled;
                await tdb.collection('settings').doc('telegram').set(update, { merge: true });
                res.status(200).send({ message: 'Telegram settings saved' });
                break;
            }
            case 'testTelegram': {
                const { sendTelegramMessage } = await Promise.resolve().then(() => __importStar(require('./services/telegram')));
                const result = await sendTelegramMessage('✅ ProTrade Alpha test message — Telegram is connected.');
                if (result.sent)
                    res.status(200).send({ message: 'Test message sent' });
                else
                    res.status(400).send({ error: `Not sent: ${result.reason}` });
                break;
            }
            case 'sendDigest': {
                const { sendDailyDigest } = await Promise.resolve().then(() => __importStar(require('./services/telegram')));
                const digestDate = (((_b = req.body) === null || _b === void 0 ? void 0 : _b.date) || ((_c = req.query) === null || _c === void 0 ? void 0 : _c.date));
                const result = await sendDailyDigest(digestDate);
                if (result.sent)
                    res.status(200).send({ message: 'Digest sent' });
                else
                    res.status(400).send({ error: `Not sent: ${result.reason}` });
                break;
            }
            case 'systemHealth': {
                const { getSystemHealth } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const health = await getSystemHealth(db);
                res.status(200).send(health);
                break;
            }
            case 'sweepStuckJobs': {
                const { sweepStuckJobs } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const swept = await sweepStuckJobs(db);
                res.status(200).send({ swept });
                break;
            }
            case 'getAlerts': {
                const { getUnacknowledgedAlerts } = await Promise.resolve().then(() => __importStar(require('./services/alerting')));
                const alerts = await getUnacknowledgedAlerts();
                res.status(200).send({ alerts });
                break;
            }
            // V3.1: Scheduled actions — called by Cloud Scheduler
            case 'scheduledKiteRenew': {
                console.log('[Scheduler] Auto-renewing Kite session...');
                const { autoRenewKiteSessionHandler } = await Promise.resolve().then(() => __importStar(require('./services/kite_automation')));
                await autoRenewKiteSessionHandler({});
                // Check if renewal succeeded
                const renewDb = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const renewSnap = await renewDb.collection('settings').doc('kite').get();
                const renewData = renewSnap.data();
                if ((renewData === null || renewData === void 0 ? void 0 : renewData.status) === 'ERROR') {
                    res.status(500).send({ error: 'Auto-renewal failed', details: renewData.lastError });
                }
                else {
                    res.status(200).send({ message: 'Kite session auto-renewed', status: renewData === null || renewData === void 0 ? void 0 : renewData.status });
                }
                break;
            }
            case 'scheduledEod': {
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                // Holiday guard: skip if today is not a trading day
                const todayEod = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                const { isTradingDay: isTradingDayCheck } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
                if (!isTradingDayCheck(todayEod)) {
                    console.log(`[Scheduler] Skipping scheduled EOD: ${todayEod} is a holiday/weekend`);
                    res.status(200).send({ message: `Skipped: ${todayEod} is not a trading day` });
                    break;
                }
                const kiteSnap = await db.collection('settings').doc('kite').get();
                const kiteData = kiteSnap.data();
                if (!(kiteData === null || kiteData === void 0 ? void 0 : kiteData.accessToken) || (kiteData === null || kiteData === void 0 ? void 0 : kiteData.status) !== 'ACTIVE') {
                    const { raiseAlert, AlertType } = await Promise.resolve().then(() => __importStar(require('./services/alerting')));
                    await raiseAlert(AlertType.SESSION_EXPIRED, 'CRITICAL', 'Scheduled EOD skipped: Kite session not active');
                    res.status(503).send({ error: 'Kite session not active' });
                    break;
                }
                // Auto-sync corporate events before EOD scan (non-blocking)
                try {
                    const { syncAllCorporateEvents } = await Promise.resolve().then(() => __importStar(require('./services/eventSync')));
                    const evtResult = await syncAllCorporateEvents(30);
                    console.log(`[Scheduler] Pre-EOD event sync: ${evtResult.earnings} earnings, ${evtResult.corporateActions} corp actions, ${evtResult.fnoBans} F&O bans`);
                }
                catch (syncErr) {
                    console.warn(`[Scheduler] Pre-EOD event sync failed (non-blocking): ${syncErr.message}`);
                }
                console.log(`[Scheduler] Starting scheduled EOD for ${todayEod}`);
                const { doStartEodRun } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartEodRun({ body: { date: todayEod, universe: 'midsmall400', force: true }, query: {} }, res);
                break;
            }
            case 'scheduledMorning': {
                // Morning fill simulation: fills previous day's ACCEPTED orders at today's open
                const morningDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                // Holiday guard: skip if today is not a trading day
                const { isTradingDay: isMorningTradingDay } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
                if (!isMorningTradingDay(morningDate)) {
                    console.log(`[Scheduler] Skipping morning fill: ${morningDate} is a holiday/weekend`);
                    res.status(200).send({ message: `Skipped: ${morningDate} is not a trading day` });
                    break;
                }
                const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
                const kiteSnap = await db.collection('settings').doc('kite').get();
                const kiteData = kiteSnap.data();
                if (!(kiteData === null || kiteData === void 0 ? void 0 : kiteData.accessToken) || (kiteData === null || kiteData === void 0 ? void 0 : kiteData.status) !== 'ACTIVE') {
                    const { raiseAlert, AlertType } = await Promise.resolve().then(() => __importStar(require('./services/alerting')));
                    await raiseAlert(AlertType.SESSION_EXPIRED, 'CRITICAL', 'Scheduled Morning skipped: Kite session not active');
                    res.status(503).send({ error: 'Kite session not active' });
                    break;
                }
                console.log(`[Scheduler] Starting morning fill simulation for ${morningDate}`);
                const { doStartMorningExecution } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartMorningExecution({ query: { date: morningDate, universe: 'midsmall400' } }, res);
                break;
            }
            case 'startMorningExecution': {
                // Manual trigger defaults to the live MidSmall 400 universe.
                const { doStartMorningExecution } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartMorningExecution({ query: { date: (_d = req.body) === null || _d === void 0 ? void 0 : _d.date, universe: ((_e = req.body) === null || _e === void 0 ? void 0 : _e.universe) || 'midsmall400' } }, res);
                break;
            }
            case 'syncNseHolidays': {
                const { syncNseHolidays } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
                const hdb = admin.apps.length ? admin.firestore() : (admin.initializeApp(), admin.firestore());
                const result = await syncNseHolidays(hdb);
                res.status(200).send({ message: `Synced ${result.synced} holidays`, source: result.source });
                break;
            }
            case 'syncCorporateEvents': {
                const { syncAllCorporateEvents } = await Promise.resolve().then(() => __importStar(require('./services/eventSync')));
                const lookAhead = Number((_f = req.body) === null || _f === void 0 ? void 0 : _f.lookAheadDays) || 30;
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
                const { runHistoricalBackfill } = await Promise.resolve().then(() => __importStar(require('./services/historicalBackfill')));
                const result = await runHistoricalBackfill({
                    universeId: ((_g = req.body) === null || _g === void 0 ? void 0 : _g.universe) || 'midsmall400',
                    startISO: (_h = req.body) === null || _h === void 0 ? void 0 : _h.start,
                    endISO: (_j = req.body) === null || _j === void 0 ? void 0 : _j.end,
                    maxSymbols: Number((_k = req.body) === null || _k === void 0 ? void 0 : _k.maxSymbols) || 500,
                });
                res.status(200).send(result);
                break;
            }
            case 'resetTradingState': {
                const { runResetTradingState } = await Promise.resolve().then(() => __importStar(require('./services/resetState')));
                const result = await runResetTradingState({
                    equity: Number((_l = req.body) === null || _l === void 0 ? void 0 : _l.equity) || 1000000,
                });
                res.status(200).send(result);
                break;
            }
            case 'cleanupStale': {
                const { runStaleCleanup } = await Promise.resolve().then(() => __importStar(require('./services/cleanupStale')));
                const result = await runStaleCleanup((_m = req.body) === null || _m === void 0 ? void 0 : _m.retention);
                res.status(200).send({ message: 'Stale data cleaned', deleted: result });
                break;
            }
            default: res.status(400).send({ error: `Unknown op: ${type}` });
        }
    }
    catch (err) {
        console.error(`[Gateway] Op ${type} failed:`, err);
        res.status(500).send({ error: err.message });
    }
});
// Queue Placeholders for v1
exports.taskDispatcher = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: Object.assign(Object.assign({}, data), { taskType: 'taskDispatcher' }), query: {} });
});
exports.processSymbolTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: Object.assign(Object.assign({}, data), { taskType: 'processSymbol' }), query: {} });
});
exports.orchestrateEodTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: Object.assign(Object.assign({}, data), { taskType: 'orchestrateEod' }), query: {} });
});
exports.orchestrateDeepSyncTask = functions.runWith(v1Options).tasks.taskQueue().onDispatch(async (data) => {
    await gatewayHandler({ body: Object.assign(Object.assign({}, data), { taskType: 'orchestrateDeepSync' }), query: {} });
});
// Private helper to resolve types inside onDispatch
async function gatewayHandler(req) {
    const { taskType } = req.body;
    try {
        switch (taskType) {
            case 'processSymbol': {
                const { processSymbolTask: task } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                return await task(req);
            }
            case 'orchestrateEod': {
                const { orchestrateEodTask: task } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                return await task(req);
            }
            case 'orchestrateDeepSync': {
                const { orchestrateDeepSyncTask: task } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                return await task(req);
            }
            default: console.warn(`[TaskBridge] Unknown taskType: ${taskType}`);
        }
    }
    catch (err) {
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
exports.scheduledKiteRenew = functions
    .runWith(v1Options)
    .pubsub.schedule('30 8 * * 1-5')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
    var _a, _b;
    console.log('[Scheduler] Auto-renewing Kite session (native schedule)...');
    const { autoRenewKiteSessionHandler } = await Promise.resolve().then(() => __importStar(require('./services/kite_automation')));
    await autoRenewKiteSessionHandler({});
    const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
    const snap = await db.collection('settings').doc('kite').get();
    const status = (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.status;
    if (status === 'ERROR') {
        console.error('[Scheduler] Kite auto-renew failed:', (_b = snap.data()) === null || _b === void 0 ? void 0 : _b.lastError);
    }
    else {
        console.log(`[Scheduler] Kite session renewed (status=${status})`);
    }
    return null;
});
function scheduledResponse() {
    return {
        status: (code) => ({
            send: (body) => console.log(`[Scheduler] Native action response ${code}`, body),
        }),
    };
}
/** Native EOD schedule; supersedes the manually-created gateway scheduler job. */
exports.scheduledEod = functions
    .runWith(v1Options)
    .pubsub.schedule('30 16 * * 1-5')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { isTradingDay } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
    if (!isTradingDay(date)) {
        console.log(`[Scheduler] Skipping native EOD: ${date} is not a trading day`);
        return null;
    }
    const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
    const kite = (await db.collection('settings').doc('kite').get()).data();
    if (!(kite === null || kite === void 0 ? void 0 : kite.accessToken) || kite.status !== 'ACTIVE') {
        console.warn('[Scheduler] Skipping native EOD: Kite session is not active');
        return null;
    }
    try {
        const { syncAllCorporateEvents } = await Promise.resolve().then(() => __importStar(require('./services/eventSync')));
        await syncAllCorporateEvents(30);
    }
    catch (error) {
        console.warn('[Scheduler] Native EOD event sync failed:', error);
    }
    const { doStartEodRun } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
    await doStartEodRun({ body: { date, universe: 'midsmall400', force: true }, query: {} }, scheduledResponse());
    return null;
});
/** Native morning fill schedule; supersedes the manually-created gateway scheduler job. */
exports.scheduledMorning = functions
    .runWith(v1Options)
    .pubsub.schedule('15 9 * * 1-5')
    .timeZone('Asia/Kolkata')
    .onRun(async () => {
    const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { isTradingDay } = await Promise.resolve().then(() => __importStar(require('./services/scheduler')));
    if (!isTradingDay(date)) {
        console.log(`[Scheduler] Skipping native morning fill: ${date} is not a trading day`);
        return null;
    }
    const db = admin.apps.length ? admin.firestore() : admin.initializeApp() && admin.firestore();
    const kite = (await db.collection('settings').doc('kite').get()).data();
    if (!(kite === null || kite === void 0 ? void 0 : kite.accessToken) || kite.status !== 'ACTIVE') {
        console.warn('[Scheduler] Skipping native morning fill: Kite session is not active');
        return null;
    }
    const { doStartMorningExecution } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
    await doStartMorningExecution({ query: { date, universe: 'midsmall400' } }, scheduledResponse());
    return null;
});
//# sourceMappingURL=index.js.map