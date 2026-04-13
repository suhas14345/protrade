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
exports.orchestrateDeepSyncTask = exports.orchestrateEodTask = exports.processSymbolTask = exports.taskDispatcher = exports.gateway = void 0;
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
    var _a, _b, _c, _d;
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
    // V3.0: Request validation
    if (type && !taskType) {
        const validation = validateRequest(req.body || {});
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
            case 'downloadReport': {
                const { downloadReport } = await Promise.resolve().then(() => __importStar(require('./services/diag')));
                await downloadReport(req, res);
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
                await doStartEodRun({ body: { date: todayEod, universe: 'nifty50', force: true }, query: {} }, res);
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
                await doStartMorningExecution({ query: { date: morningDate, universe: 'nifty500' } }, res);
                break;
            }
            case 'startMorningExecution': {
                // Manual trigger: { action: "startMorningExecution", date: "2026-04-13", universe: "nifty500" }
                const { doStartMorningExecution } = await Promise.resolve().then(() => __importStar(require('./services/orchestrator')));
                await doStartMorningExecution({ query: { date: (_b = req.body) === null || _b === void 0 ? void 0 : _b.date, universe: ((_c = req.body) === null || _c === void 0 ? void 0 : _c.universe) || 'nifty500' } }, res);
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
                const lookAhead = Number((_d = req.body) === null || _d === void 0 ? void 0 : _d.lookAheadDays) || 30;
                const result = await syncAllCorporateEvents(lookAhead);
                res.status(200).send({
                    message: 'Corporate events synced',
                    earnings: result.earnings,
                    corporateActions: result.corporateActions,
                    fnoBans: result.fnoBans,
                });
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
//      Body: {"action":"scheduledEod"}  Cron: 45 15 * * 1-5  TZ: Asia/Kolkata
//   3. morning-fill: POST https://us-central1-suhas-ag.cloudfunctions.net/gateway
//      Body: {"action":"scheduledMorning"}  Cron: 15 9 * * 1-5  TZ: Asia/Kolkata
//# sourceMappingURL=index.js.map