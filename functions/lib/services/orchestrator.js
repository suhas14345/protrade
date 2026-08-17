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
exports.sweepStuckJobs = sweepStuckJobs;
exports.doStartEodRun = doStartEodRun;
exports.orchestrateEodTask = orchestrateEodTask;
exports.doStartDeepSync = doStartDeepSync;
exports.orchestrateDeepSyncTask = orchestrateDeepSyncTask;
exports.doStartMorningExecution = doStartMorningExecution;
exports.doSyncUniverse = doSyncUniverse;
exports.terminateJob = terminateJob;
exports.runEodLogic = runEodLogic;
exports.runMorningLogic = runMorningLogic;
exports.processSymbolTask = processSymbolTask;
exports.processMorningSymbolTask = processMorningSymbolTask;
exports.doSyncCalendar = doSyncCalendar;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const tasks_1 = require("./tasks");
const calendar_1 = require("./calendar");
const logger_1 = require("./logger");
const runtime_1 = require("../config/runtime");
const marketdata_1 = require("./marketdata");
const alerting_1 = require("./alerting");
const getDb = () => {
    if (admin.apps.length === 0) {
        admin.initializeApp();
        const db = admin.firestore();
        db.settings({ ignoreUndefinedProperties: true });
        return db;
    }
    return admin.firestore();
};
const toDateId = (date) => date.replace(/-/g, '');
/**
 * V3.0: Audit trail — logs stage transitions per symbol/job.
 */
async function auditLog(db, jobId, event, details = {}) {
    try {
        await db.collection('jobs').doc(jobId).collection('audit').add(Object.assign(Object.assign({ event }, details), { timestamp: admin.firestore.Timestamp.now() }));
    }
    catch ( /* non-blocking */_a) { /* non-blocking */ }
}
/**
 * V3.0: Check idempotency — returns true if this stage was already completed.
 */
async function isStageCompleted(db, jobId, symbol, stage) {
    const key = `${jobId}_${symbol}_${stage}`;
    const sentinel = await db.collection('idempotency').doc(key).get();
    return sentinel.exists;
}
async function markStageCompleted(db, jobId, symbol, stage) {
    const key = `${jobId}_${symbol}_${stage}`;
    await db.collection('idempotency').doc(key).set({ completedAt: admin.firestore.Timestamp.now() });
}
/**
 * V3.0: Stuck job sweeper — call periodically to clean up orphaned jobs.
 */
async function sweepStuckJobs() {
    const db = getDb();
    const cutoff = new Date(Date.now() - runtime_1.ORCH_CONFIG.JOB_TIMEOUT_MINUTES * 60000);
    const stuckJobs = await db.collection('jobs')
        .where('status', 'in', ['RUNNING', 'FINALIZING'])
        .where('startedAt', '<', firestore_1.Timestamp.fromDate(cutoff))
        .get();
    for (const doc of stuckJobs.docs) {
        await doc.ref.update({
            status: 'FAILED',
            errorMessage: `Auto-failed: exceeded ${runtime_1.ORCH_CONFIG.JOB_TIMEOUT_MINUTES}min timeout`,
            updatedAt: firestore_1.Timestamp.now()
        });
        await logger_1.logger.warn(`[Orchestrator] Swept stuck job ${doc.id}`, 'Orchestrator');
    }
    return stuckJobs.size;
}
/**
 * Task Queue Trigger to get instrument map
 */
async function getInstrumentTokenMap(apiKey, accessToken) {
    const { getNSEInstrumentsMap } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
    const instrumentsMap = await getNSEInstrumentsMap(apiKey, accessToken);
    const map = {};
    instrumentsMap.forEach((token, symbol) => {
        map[symbol] = token;
        map[symbol + '.NS'] = token;
    });
    return map;
}
/**
 * HTTP Triggers for Dashboard/Scheduler
 */
async function doStartEodRun(req, res) {
    const { date, universe = 'nifty50', forceRegime, force } = Object.assign(Object.assign({}, req.query), req.body);
    if (!date) {
        res.status(400).send({ error: 'Missing "date" query parameter (YYYY-MM-DD)' });
        return;
    }
    // V3.0: Kill switch check
    if (runtime_1.RUNTIME_CONFIG.KILL_SWITCH) {
        res.status(503).send({ error: 'Kill switch is active — all trading halted' });
        return;
    }
    // V3.0: Market hours guard — reject if market still open (skip with force=true for paper testing)
    if (!force && runtime_1.RUNTIME_CONFIG.MODE !== 'BACKFILL' && runtime_1.RUNTIME_CONFIG.MODE !== 'REPLAY') {
        if (!(0, marketdata_1.isMarketClosed)()) {
            res.status(400).send({ error: `Market still open. EOD can only run after ${runtime_1.MARKET_HOURS.EOD_SAFE_HOUR}:${String(runtime_1.MARKET_HOURS.EOD_SAFE_MINUTE).padStart(2, '0')} IST` });
            return;
        }
    }
    const jobId = `eod_${date}_${universe}_${Date.now()}`;
    const db = getDb();
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({ error: 'Job in progress', runningJobId: runningJobs.docs[0].id });
        return;
    }
    await db.collection('jobs').doc(jobId).set({
        id: jobId, runDate: date, universeId: universe, type: 'EOD_RUN', stage: 'STARTING', status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now(),
        dataSource: 'KITE', versionHash: 'v1.1Delta',
        forceRegime: forceRegime || null
    });
    // Enqueue the main orchestration loop as a task (Gap B12 Fixed)
    // Using processSymbolTask queue as it's guaranteed to exist
    await tasks_1.taskClient.enqueue('orchestrateEodTask', { jobId, date, universe, forceRegime }, 'processSymbolTask');
    res.status(202).send({ message: 'EOD run triggered', jobId });
}
/**
 * Task Handler: Main EOD Orchestration Loop
 */
async function orchestrateEodTask(req) {
    const { jobId, date, universe = 'nifty50', forceRegime } = req.body;
    if (!jobId || !date) {
        console.error('[Orchestrator] Missing jobId or date in task body');
        return;
    }
    try {
        await logger_1.logger.info(`[Orchestrator] Starting orchestration task for Job ${jobId}`, 'Orchestrator');
        await runEodLogic(date, jobId, universe, forceRegime);
    }
    catch (err) {
        await logger_1.logger.error(`[Orchestrator] Orchestration task failed: ${err.message}`, 'Orchestrator', { jobId });
        const db = getDb();
        await db.collection('jobs').doc(jobId).update({
            status: 'FAILED',
            errorMessage: `Orchestration error: ${err.message}`,
            updatedAt: admin.firestore.Timestamp.now()
        });
    }
}
/**
 * Deep Sync: Force-fetches historical data (e.g. 90 days) for all symbols in a universe.
 */
async function doStartDeepSync(req, res) {
    const { days = 90, universe = 'nifty500' } = Object.assign(Object.assign({}, req.query), req.body);
    const jobId = `deepsync_${new Date().toISOString().split('T')[0]}_${universe}_${Date.now()}`;
    const db = getDb();
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({ error: 'Another job is currently in progress', runningJobId: runningJobs.docs[0].id });
        return;
    }
    const forceDays = parseInt(days);
    await db.collection('jobs').doc(jobId).set({
        id: jobId,
        runDate: new Date().toISOString().split('T')[0],
        universeId: universe,
        type: 'DEEP_SYNC',
        stage: 'FETCH',
        status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
        dataSource: 'KITE',
        versionHash: 'v1.1Deep',
    });
    await db.collection('jobs').doc(jobId).update({ 'counts.total': 0, updatedAt: firestore_1.Timestamp.now() });
    // Enqueue the deep sync orchestration loop as a task (Gap B13 Fixed)
    await tasks_1.taskClient.enqueue('orchestrateDeepSyncTask', { jobId, universe, days: forceDays });
    res.status(202).send({ message: 'Deep sync triggered', jobId, forceDays });
}
/**
 * Task Handler: Deep Sync Orchestration Loop
 */
async function orchestrateDeepSyncTask(req) {
    const { jobId, universe = 'nifty500', days } = req.body;
    if (!jobId || !universe) {
        console.error('[Orchestrator] Missing jobId or universe in Deep Sync task body');
        return;
    }
    try {
        await logger_1.logger.info(`[Orchestrator] Starting Deep Sync task for Job ${jobId}`, 'Orchestrator');
        await runDeepSyncLogic(jobId, universe, parseInt(days));
    }
    catch (err) {
        await logger_1.logger.error(`[Orchestrator] Deep Sync task failed: ${err.message}`, 'Orchestrator', { jobId });
        const db = getDb();
        await db.collection('jobs').doc(jobId).update({
            status: 'FAILED',
            errorMessage: `Deep Sync error: ${err.message}`,
            updatedAt: firestore_1.Timestamp.now()
        });
    }
}
async function runDeepSyncLogic(jobId, universeId, forceDays) {
    const db = getDb();
    const dateId = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const date = new Date().toISOString().split('T')[0];
    // 1. Get symbols
    const symbolsSnap = await db.collection('universes').doc(universeId).collection('members').get();
    const symbols = symbolsSnap.docs.map(d => d.id);
    await db.collection('jobs').doc(jobId).update({ 'counts.total': symbols.length, updatedAt: firestore_1.Timestamp.now() });
    // 2. Dispatch tasks
    for (const symbol of symbols) {
        await tasks_1.taskClient.enqueueDispatch('processSymbolTask', {
            jobId,
            dateId,
            date,
            symbol,
            forceDays
        });
        // Delay to prevent enqueuing too fast
        await new Promise(resolve => setTimeout(resolve, 350));
    }
}
async function doStartMorningExecution(req, res) {
    const { date, universe = 'nifty50' } = req.query;
    if (!date) {
        res.status(400).send({ error: 'Missing "date"' });
        return;
    }
    const jobId = `morning_${date}_${universe}_${Date.now()}`;
    const db = getDb();
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({ error: 'Job in progress', runningJobId: runningJobs.docs[0].id });
        return;
    }
    await db.collection('jobs').doc(jobId).set({
        id: jobId, runDate: date, universeId: universe, type: 'OPEN_SIM_RUN', stage: 'STARTING', status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now(),
        dataSource: 'KITE', versionHash: 'v1.1Delta',
    });
    (async () => {
        try {
            await logger_1.logger.info(`[Orchestrator] Triggering Morning Execution for ${date}`, 'Orchestrator', { jobId, date, universe });
            await runMorningLogic(date, jobId, universe);
        }
        catch (err) {
            await logger_1.logger.error(`[Orchestrator] Morning execution failed: ${err.message}`, 'Orchestrator', { jobId, error: err.message });
            console.error(`[Job ${jobId}] Morning execution failed:`, err);
        }
    })();
    res.status(202).send({ message: 'Morning execution triggered', jobId });
}
/**
 * Logic to sync universe members and instrument tokens. (Restored for Rule Compliance)
 */
async function doSyncUniverse(req, res) {
    const db = getDb();
    const date = new Date().toISOString().split('T')[0];
    const jobId = `sync_${date}_${Date.now()}`;
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({ error: 'Job in progress', runningJobId: runningJobs.docs[0].id });
        return;
    }
    await db.collection('jobs').doc(jobId).set({ id: jobId, runDate: date, type: 'SYNC_UNIVERSE', stage: 'STARTING', status: 'RUNNING', startedAt: admin.firestore.Timestamp.now(), updatedAt: admin.firestore.Timestamp.now(), versionHash: 'v1.1Delta' });
    res.status(200).send({ message: 'Universe sync started', jobId });
    (async () => {
        try {
            const { getNSEInstrumentsMap } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
            const settingsSnap = await db.collection('settings').doc('kite').get();
            const settings = settingsSnap.data();
            if ((settings === null || settings === void 0 ? void 0 : settings.apiKey) && (settings === null || settings === void 0 ? void 0 : settings.accessToken))
                await getNSEInstrumentsMap(settings.apiKey, settings.accessToken);
            await db.collection('jobs').doc(jobId).update({ status: 'DONE', stage: 'DONE', updatedAt: admin.firestore.Timestamp.now() });
        }
        catch (err) {
            await db.collection('jobs').doc(jobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: admin.firestore.Timestamp.now() });
        }
    })();
}
async function terminateJob(req, res) {
    var _a, _b;
    const jobId = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.jobId) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.jobId);
    if (!jobId) {
        res.status(400).send({ error: 'Missing jobId' });
        return;
    }
    const db = getDb();
    await db.collection('jobs').doc(jobId).update({ status: 'FAILED', errorMessage: 'Terminated by user', updatedAt: firestore_1.Timestamp.now() });
    res.status(200).send({ message: 'Terminated', jobId });
}
/**
 * Core Logic: EOD Run (Refactored Gap B4)
 */
async function runEodLogic(targetDate, targetJobId, targetUniverse = 'nifty50', forceRegime) {
    const db = getDb();
    const dateId = toDateId(targetDate);
    const settingsSnap = await db.collection('settings').doc('kite').get();
    const settingsData = settingsSnap.data();
    let tokenMap = {};
    if ((settingsData === null || settingsData === void 0 ? void 0 : settingsData.apiKey) && (settingsData === null || settingsData === void 0 ? void 0 : settingsData.accessToken) && (settingsData === null || settingsData === void 0 ? void 0 : settingsData.status) === 'ACTIVE') {
        try {
            tokenMap = await getInstrumentTokenMap(settingsData.apiKey, settingsData.accessToken);
        }
        catch (err) {
            console.error(`[Job ${targetJobId}] Instrument cache fail: ${err}`);
        }
    }
    // 1. Trading Day Correctness (Gap B4.2)
    const isTrading = await calendar_1.CalendarService.isTradingDay(dateId);
    if (!isTrading) {
        const msg = `[Job ${targetJobId}] Aborting: ${targetDate} is not a trading day according to calendar.`;
        console.warn(msg);
        await db.collection('jobs').doc(targetJobId).update({ stage: 'COMPLETED', status: 'SKIPPED', error: msg, updatedAt: admin.firestore.Timestamp.now() });
        return;
    }
    const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
    const symbols = universeSnap.docs.map((d) => d.id).filter((s) => s !== '^NSEI');
    // Metals sleeve ETFs are always part of the daily run, independent of universe membership.
    if (runtime_1.METALS_CONFIG.ENABLED) {
        for (const m of runtime_1.METALS_CONFIG.SYMBOLS)
            if (!symbols.includes(m))
                symbols.push(m);
    }
    await db.collection('jobs').doc(targetJobId).update({ 'counts.total': symbols.length, stage: 'FETCH' });
    try {
        // 2. Risk-First: Manage Trades (Gap B3)
        const { doManageTrades } = await Promise.resolve().then(() => __importStar(require('./tradeManager')));
        await doManageTrades(dateId, targetJobId);
        // 3. Index Processing (Regime)
        const { doFetchCandles } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
        const { doComputeFeatures } = await Promise.resolve().then(() => __importStar(require('./features')));
        const { doComputeRegime } = await Promise.resolve().then(() => __importStar(require('./regime')));
        const indexSymbol = (settingsData === null || settingsData === void 0 ? void 0 : settingsData.accessToken) ? 'NIFTY 50' : '^NSEI';
        await doFetchCandles(targetJobId, indexSymbol, targetDate, tokenMap[indexSymbol]);
        await doComputeFeatures(targetJobId, indexSymbol, targetDate);
        await db.collection('jobs').doc(targetJobId).update({ stage: 'REGIME' });
        if (forceRegime) {
            await logger_1.logger.info(`[Orchestrator] Forcing regime to ${forceRegime} for Job ${targetJobId}`, 'Orchestrator');
            await db.collection('jobs').doc(targetJobId).update({ marketState: forceRegime });
        }
        else {
            await doComputeRegime(targetDate, targetJobId, indexSymbol, targetUniverse);
        }
        // 4. Dispatch tasks (Gap B4.1)
        await db.collection('jobs').doc(targetJobId).update({ stage: 'SIGNALS' });
        await logger_1.logger.info(`[Orchestrator] Dispatching tasks for ${symbols.length} symbols`, 'Orchestrator', { jobId: targetJobId });
        for (const symbol of symbols) {
            await tasks_1.taskClient.enqueueDispatch('processSymbolTask', {
                jobId: targetJobId, symbol, date: targetDate,
                dateId, // Pass dateId to symbol task (Gap B11 Fixed)
                token: tokenMap[symbol], universe: targetUniverse,
                forceRegime
            });
            await new Promise(resolve => setTimeout(resolve, 350));
        }
    }
    catch (err) {
        await db.collection('jobs').doc(targetJobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: firestore_1.Timestamp.now() });
        throw err;
    }
}
/**
 * Morning Execution logic
 */
async function runMorningLogic(targetDate, targetJobId, targetUniverse = 'nifty50') {
    const db = getDb();
    const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
    const symbols = universeSnap.docs.map(d => d.id);
    // Metals sleeve ETFs are always part of the morning fill run too.
    if (runtime_1.METALS_CONFIG.ENABLED) {
        for (const m of runtime_1.METALS_CONFIG.SYMBOLS)
            if (!symbols.includes(m))
                symbols.push(m);
    }
    await db.collection('jobs').doc(targetJobId).update({ 'counts.total': symbols.length, stage: 'ORDERS' });
    try {
        for (const symbol of symbols) {
            await tasks_1.taskClient.enqueueDispatch('processSymbolTask', { jobId: targetJobId, date: targetDate, symbol, taskSubType: 'morning' });
            await new Promise(resolve => setTimeout(resolve, 350));
        }
    }
    catch (err) {
        await db.collection('jobs').doc(targetJobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: firestore_1.Timestamp.now() });
        throw err;
    }
}
/**
 * Task Handler: Process a single symbol (Redundancy Removed Gap B1)
 */
async function processSymbolTask(req) {
    var _a, _b, _c, _d, _e;
    // Route morning fill tasks to the dedicated handler
    if (((_a = req.body) === null || _a === void 0 ? void 0 : _a.taskSubType) === 'morning') {
        return processMorningSymbolTask(req);
    }
    const { jobId, symbol, date, forceRegime, forceDays, universe } = req.body;
    let { dateId } = req.body;
    if (!jobId || !symbol || !date) {
        console.error('[Orchestrator] Missing jobId, symbol, or date in processSymbolTask body');
        return;
    }
    const db = getDb();
    if (!dateId)
        dateId = date.replace(/-/g, '');
    const jobRef = db.collection('jobs').doc(jobId);
    // V3.0: Check if job is still RUNNING (don't process if FAILED/DONE)
    const jobCheck = await jobRef.get();
    if (!jobCheck.exists || !['RUNNING', 'FINALIZING'].includes((_b = jobCheck.data()) === null || _b === void 0 ? void 0 : _b.status)) {
        console.warn(`[Orchestrator] Skipping ${symbol}: job ${jobId} is ${(_c = jobCheck.data()) === null || _c === void 0 ? void 0 : _c.status}`);
        return;
    }
    try {
        // 1. Fetch (with idempotency)
        if (!await isStageCompleted(db, jobId, symbol, 'FETCH')) {
            const { doFetchCandles } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
            await doFetchCandles(jobId, symbol, date, undefined, forceDays);
            await markStageCompleted(db, jobId, symbol, 'FETCH');
        }
        // 2. Features (with idempotency)
        if (!await isStageCompleted(db, jobId, symbol, 'FEATURES')) {
            const { doComputeFeatures } = await Promise.resolve().then(() => __importStar(require('./features')));
            await doComputeFeatures(jobId, symbol, date);
            await markStageCompleted(db, jobId, symbol, 'FEATURES');
        }
        // 3. Signals (Only for EOD_RUN, with idempotency)
        const jobSnapForType = await jobRef.get();
        const jobData = jobSnapForType.data();
        if ((jobData === null || jobData === void 0 ? void 0 : jobData.type) === 'EOD_RUN' && !await isStageCompleted(db, jobId, symbol, 'SIGNALS')) {
            const { doEvaluateSignals } = await Promise.resolve().then(() => __importStar(require('./strategy')));
            await doEvaluateSignals(jobId, symbol, date, forceRegime, universe || (jobData === null || jobData === void 0 ? void 0 : jobData.universeId) || 'nifty500');
            await markStageCompleted(db, jobId, symbol, 'SIGNALS');
        }
        // Atomic update and wrap-up check
        const updatedJob = await db.runTransaction(async (t) => {
            var _a;
            const doc = await t.get(jobRef);
            if (!doc.exists)
                return null;
            const data = doc.data();
            if (data.status !== 'RUNNING')
                return null;
            const newDone = (((_a = data.counts) === null || _a === void 0 ? void 0 : _a.done) || 0) + 1;
            t.update(jobRef, { 'counts.done': newDone, updatedAt: firestore_1.Timestamp.now() });
            return Object.assign(Object.assign({}, data), { counts: Object.assign(Object.assign({}, data.counts), { done: newDone }) });
        });
        await auditLog(db, jobId, 'SYMBOL_COMPLETE', { symbol, dateId });
        await checkAndFinalizeJob(db, jobRef, jobId, dateId, date, updatedJob);
    }
    catch (err) {
        await auditLog(db, jobId, 'SYMBOL_FAILED', { symbol, dateId, error: err.message });
        await logger_1.logger.error(`[Orchestrator] Symbol ${symbol} failed: ${err.message}`, 'Orchestrator', { jobId, symbol });
        const jobRef = db.collection('jobs').doc(jobId);
        await jobRef.update({ 'counts.failed': admin.firestore.FieldValue.increment(1), updatedAt: firestore_1.Timestamp.now() });
        // V3.0: Check failure threshold — abort if too many symbols fail
        const jobSnap = await jobRef.get();
        const jobData = jobSnap.data();
        if (jobData && jobData.status === 'RUNNING') {
            const failPct = (((_d = jobData.counts) === null || _d === void 0 ? void 0 : _d.failed) || 0) / (((_e = jobData.counts) === null || _e === void 0 ? void 0 : _e.total) || 1);
            if (failPct > runtime_1.ORCH_CONFIG.MAX_FAILURE_PCT) {
                await logger_1.logger.error(`[Orchestrator] ABORTING job ${jobId}: ${(failPct * 100).toFixed(0)}% symbols failed (threshold: ${runtime_1.ORCH_CONFIG.MAX_FAILURE_PCT * 100}%)`, 'Orchestrator', { jobId });
                await (0, alerting_1.raiseAlert)(alerting_1.AlertType.JOB_FAILED, 'CRITICAL', `Job ${jobId} aborted: ${(failPct * 100).toFixed(0)}% symbol failure rate`, { jobId, failPct });
                await jobRef.update({ status: 'FAILED', errorMessage: `Aborted: ${(failPct * 100).toFixed(0)}% symbol failure rate exceeded threshold`, updatedAt: firestore_1.Timestamp.now() });
                return;
            }
            await checkAndFinalizeJob(db, jobRef, jobId, dateId, date, Object.assign({}, jobData));
        }
    }
}
/**
 * Shared helper: runs wrap-up when all tasks (done + failed) >= total.
 */
async function checkAndFinalizeJob(db, jobRef, jobId, dateId, date, jobData) {
    var _a, _b, _c;
    if (!jobData || !jobId || !dateId) {
        console.warn(`[Orchestrator] checkAndFinalizeJob aborted: Missing jobId(${jobId}) or dateId(${dateId})`);
        return;
    }
    const done = ((_a = jobData.counts) === null || _a === void 0 ? void 0 : _a.done) || 0;
    const failed = ((_b = jobData.counts) === null || _b === void 0 ? void 0 : _b.failed) || 0;
    const total = ((_c = jobData.counts) === null || _c === void 0 ? void 0 : _c.total) || 0;
    if (done + failed < total)
        return; // Not finished yet
    // V3.0: Data completeness check before finalization
    const completionPct = total > 0 ? done / total : 0;
    if (runtime_1.ORCH_CONFIG.STAGE_BARRIER_ENABLED && completionPct < runtime_1.ORCH_CONFIG.MIN_DATA_COMPLETENESS_PCT) {
        await logger_1.logger.error(`[Orchestrator] Job ${jobId}: Only ${(completionPct * 100).toFixed(0)}% symbols succeeded (need ${runtime_1.ORCH_CONFIG.MIN_DATA_COMPLETENESS_PCT * 100}%). Aborting.`, 'Orchestrator', { jobId });
        await (0, alerting_1.raiseAlert)(alerting_1.AlertType.DATA_STALE, 'WARN', `Job ${jobId}: data completeness ${(completionPct * 100).toFixed(0)}% below threshold`, { jobId, completionPct });
        await jobRef.update({ status: 'FAILED', errorMessage: `Data completeness ${(completionPct * 100).toFixed(0)}% below threshold`, updatedAt: firestore_1.Timestamp.now() });
        return;
    }
    // V3.0: Index bar check — ensure regime data exists
    if (runtime_1.ORCH_CONFIG.INDEX_BAR_REQUIRED && jobData.type === 'EOD_RUN') {
        const regimeSnap = await db.collection('regime').doc(dateId).get();
        if (!regimeSnap.exists) {
            await logger_1.logger.error(`[Orchestrator] Job ${jobId}: No regime data for ${dateId}. Cannot finalize.`, 'Orchestrator', { jobId });
            await jobRef.update({ status: 'FAILED', errorMessage: 'Regime data missing — index processing may have failed', updatedAt: firestore_1.Timestamp.now() });
            return;
        }
    }
    // Guard: only one task should run wrap-up (with retry counter)
    let retryCount = 0;
    try {
        await db.runTransaction(async (t) => {
            const snap = await t.get(jobRef);
            if (!snap.exists || snap.data().status !== 'RUNNING')
                throw new Error('ALREADY_FINALIZED');
            retryCount = snap.data().finalizationRetries || 0;
            if (retryCount >= runtime_1.ORCH_CONFIG.FINALIZATION_MAX_RETRIES)
                throw new Error('MAX_RETRIES_EXCEEDED');
            t.update(jobRef, { status: 'FINALIZING', finalizationRetries: retryCount + 1, updatedAt: firestore_1.Timestamp.now() });
        });
    }
    catch (e) {
        if (e.message === 'ALREADY_FINALIZED')
            return;
        if (e.message === 'MAX_RETRIES_EXCEEDED') {
            await jobRef.update({ status: 'FAILED', errorMessage: `Finalization failed after ${runtime_1.ORCH_CONFIG.FINALIZATION_MAX_RETRIES} retries`, updatedAt: firestore_1.Timestamp.now() });
            await (0, alerting_1.raiseAlert)(alerting_1.AlertType.JOB_FAILED, 'CRITICAL', `Job ${jobId} finalization exceeded max retries`, { jobId, retries: runtime_1.ORCH_CONFIG.FINALIZATION_MAX_RETRIES });
            await logger_1.logger.error(`[Orchestrator] Job ${jobId} finalization exceeded max retries`, 'Orchestrator', { jobId });
            return;
        }
        throw e;
    }
    try {
        const { doAggregateStats } = await Promise.resolve().then(() => __importStar(require('./aggregateStats')));
        const { doDailyAnalytics } = await Promise.resolve().then(() => __importStar(require('./journal')));
        const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
        const { doPlaceOrders } = await Promise.resolve().then(() => __importStar(require('./paperBroker')));
        // RS Rankings
        const universeId = jobData.universeId || 'nifty500';
        try {
            await jobRef.update({ stage: 'RS_RANK' });
            const { doComputeRsRanking } = await Promise.resolve().then(() => __importStar(require('./rsRanking')));
            await doComputeRsRanking(dateId, jobId, universeId);
            await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'RS_RANK' });
        }
        catch (rsErr) {
            await logger_1.logger.warn(`[Orchestrator] RS ranking failed (non-blocking): ${rsErr.message}`, 'Orchestrator', { jobId });
            await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'RS_RANK', error: rsErr.message });
        }
        // Correlation
        try {
            await jobRef.update({ stage: 'CORR' });
            const { doComputeCorrTopN } = await Promise.resolve().then(() => __importStar(require('./corrTopN')));
            await doComputeCorrTopN(dateId, jobId, universeId);
            await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'CORR' });
        }
        catch (corrErr) {
            await logger_1.logger.warn(`[Orchestrator] CorrTopN failed (non-blocking): ${corrErr.message}`, 'Orchestrator', { jobId });
            await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'CORR', error: corrErr.message });
        }
        // Orders
        await jobRef.update({ stage: 'ORDERS' });
        try {
            // V3.0: Kill switch check before placing orders
            if (!runtime_1.RUNTIME_CONFIG.KILL_SWITCH) {
                await doPlaceOrders(dateId, jobId);
                await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'ORDERS' });
            }
            else {
                await logger_1.logger.warn(`[Orchestrator] Kill switch active — skipping order placement`, 'Orchestrator', { jobId });
                await auditLog(db, jobId, 'STAGE_SKIPPED', { stage: 'ORDERS', reason: 'KILL_SWITCH' });
            }
        }
        catch (err) {
            await logger_1.logger.warn(`[Orchestrator] Order placement failed: ${err.message}`, 'Orchestrator', { jobId });
            await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'ORDERS', error: err.message });
        }
        await jobRef.update({ stage: 'DONE' });
        // Optional wrap-up tasks
        try {
            await calendar_1.CalendarService.upsertToday(dateId);
            await doAggregateStats(dateId);
            await doDailyAnalytics(jobId, date);
            await generateJobReport(jobId, date);
        }
        catch (wrapSubErr) {
            await logger_1.logger.error(`[Orchestrator] Non-critical wrap-up task failed: ${wrapSubErr.message}`, 'Orchestrator', { jobId });
        }
        await logger_1.logger.info(`[Orchestrator] Job ${jobId} Completed. Done: ${done}, Failed: ${failed}, Total: ${total}`, 'Orchestrator', { jobId, date, done, failed, total });
        await auditLog(db, jobId, 'JOB_COMPLETE', { done, failed, total });
        await jobRef.update({ status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
    }
    catch (wrapErr) {
        await logger_1.logger.error(`[Orchestrator] Critical wrap-up error for ${jobId}: ${wrapErr.message}`, 'Orchestrator', { jobId });
        await auditLog(db, jobId, 'FINALIZATION_ERROR', { error: wrapErr.message, retryCount });
        await jobRef.update({ status: 'FAILED', errorMessage: `Wrap-up error: ${wrapErr.message}`, updatedAt: firestore_1.Timestamp.now() });
    }
}
/**
 * Shared helper: runs wrap-up for morning jobs when all tasks >= total.
 */
async function checkAndFinalizeMorningJob(db, jobRef, jobId, date, jobData) {
    var _a, _b, _c;
    if (!jobData)
        return;
    const done = ((_a = jobData.counts) === null || _a === void 0 ? void 0 : _a.done) || 0;
    const failed = ((_b = jobData.counts) === null || _b === void 0 ? void 0 : _b.failed) || 0;
    const total = ((_c = jobData.counts) === null || _c === void 0 ? void 0 : _c.total) || 0;
    if (done + failed < total)
        return; // Not finished yet
    // Guard: only one task should run wrap-up
    try {
        await db.runTransaction(async (t) => {
            const snap = await t.get(jobRef);
            if (!snap.exists || snap.data().status !== 'RUNNING')
                throw new Error('ALREADY_FINALIZED');
            t.update(jobRef, { status: 'FINALIZING', updatedAt: firestore_1.Timestamp.now() });
        });
    }
    catch (e) {
        if (e.message === 'ALREADY_FINALIZED')
            return;
        throw e;
    }
    try {
        await jobRef.update({ stage: 'DONE' });
        try {
            const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
            await generateJobReport(jobId, date);
        }
        catch (err) {
            await logger_1.logger.warn(`[Orchestrator] Morning report error: ${err.message}`, 'Orchestrator', { jobId });
        }
        await jobRef.update({ status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
        await logger_1.logger.info(`[Orchestrator] Morning Job ${jobId} Completed successfully.`, 'Orchestrator', { jobId, date });
    }
    catch (wrapErr) {
        await logger_1.logger.error(`[Orchestrator] Critical morning wrap-up error: ${wrapErr.message}`, 'Orchestrator', { jobId });
        await jobRef.update({ status: 'FAILED', errorMessage: `Morning wrap-up error: ${wrapErr.message}`, updatedAt: firestore_1.Timestamp.now() });
    }
}
async function processMorningSymbolTask(req) {
    const { jobId, date, symbol } = req.body;
    if (!jobId || !symbol || !date)
        return;
    const db = getDb();
    const jobRef = db.collection('jobs').doc(jobId);
    try {
        const { doOpenFillSimulation } = await Promise.resolve().then(() => __importStar(require('./paperBroker')));
        await doOpenFillSimulation(jobId, date, symbol);
        const updatedJob = await db.runTransaction(async (t) => {
            var _a;
            const doc = await t.get(jobRef);
            if (!doc.exists)
                return null;
            const data = doc.data();
            if (data.status !== 'RUNNING')
                return null;
            const newDone = (((_a = data.counts) === null || _a === void 0 ? void 0 : _a.done) || 0) + 1;
            t.update(jobRef, { 'counts.done': newDone, updatedAt: firestore_1.Timestamp.now() });
            return Object.assign(Object.assign({}, data), { counts: Object.assign(Object.assign({}, data.counts), { done: newDone }) });
        });
        await checkAndFinalizeMorningJob(db, jobRef, jobId, date, updatedJob);
    }
    catch (err) {
        const jobRef = db.collection('jobs').doc(jobId);
        await jobRef.update({ 'counts.failed': admin.firestore.FieldValue.increment(1), updatedAt: firestore_1.Timestamp.now() });
        const jobSnap = await jobRef.get();
        const jobData = jobSnap.data();
        if (jobData && jobData.status === 'RUNNING') {
            await checkAndFinalizeMorningJob(db, jobRef, jobId, date, Object.assign({}, jobData));
        }
    }
}
/**
 * Migration Utility: One-off historical sync
 */
async function doSyncCalendar(req, res) {
    const { symbol = '^NSEI' } = req.query || {};
    try {
        await calendar_1.CalendarService.syncFromIndexData(String(symbol));
        res.status(200).send({ message: 'Calendar historical sync complete' });
    }
    catch (e) {
        res.status(500).send(e.message);
    }
}
//# sourceMappingURL=orchestrator.js.map