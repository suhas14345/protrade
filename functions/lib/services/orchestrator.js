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
exports.doStartEodRun = doStartEodRun;
exports.doStartMorningExecution = doStartMorningExecution;
exports.doSyncUniverse = doSyncUniverse;
exports.terminateJob = terminateJob;
exports.processStageTask = processStageTask;
exports.runEodLogic = runEodLogic;
exports.runMorningLogic = runMorningLogic;
exports.processSymbolTask = processSymbolTask;
exports.processMorningSymbolTask = processMorningSymbolTask;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const logger_1 = require("./logger");
const tasks_1 = require("./tasks");
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
 * Task Queue Trigger to get instrument map (optimized)
 */
async function getInstrumentTokenMap(apiKey, accessToken) {
    const { getNSEInstruments } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
    const instruments = await getNSEInstruments(apiKey, accessToken);
    const map = {};
    instruments.forEach((i) => {
        map[i.tradingsymbol] = i.instrument_token;
        map[i.tradingsymbol + '.NS'] = i.instrument_token;
    });
    return map;
}
/**
 * HTTP Triggers for Dashboard/Scheduler
 */
/**
 * Logic to start an EOD run.
 */
async function doStartEodRun(req, res) {
    const { date, universe = 'nifty50' } = req.query;
    if (!date) {
        res.status(400).send({ error: 'Missing "date" query parameter (YYYY-MM-DD)' });
        return;
    }
    const jobId = `eod_${date}_${universe}_${Date.now()}`;
    const db = getDb();
    // Concurrency Guard: Don't start if another job is already RUNNING
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({
            error: 'Job in progress',
            message: 'Another job is currently RUNNING. Please wait or terminate it before starting a new one.',
            runningJobId: runningJobs.docs[0].id
        });
        return;
    }
    // Initialize job in Firestore IMMEDIATELY so it's visible to probeJobs
    await db.collection('jobs').doc(jobId).set({
        id: jobId,
        runDate: date,
        universeId: universe,
        type: 'EOD_RUN',
        stage: 'STARTING',
        status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
        dataSource: 'KITE',
        versionHash: 'v3.7Atomic',
    });
    // Run the logic asynchronously to prevent dashboard timeouts.
    // The job status is tracked in Firestore.
    (async () => {
        try {
            await runEodLogic(date, jobId, universe);
            console.log(`[Job ${jobId}] EOD run completed successfully`);
        }
        catch (err) {
            console.error(`[Job ${jobId}] Critical execution error:`, err);
            // Status update is handled inside runEodLogic for catch block
        }
    })();
    res.status(202).send({
        message: 'EOD run triggered successfully',
        jobId,
        trackingUrl: `/jobs/${jobId}`
    });
}
/**
 * Logic to start morning execution.
 */
async function doStartMorningExecution(req, res) {
    const { date, universe = 'nifty50' } = req.query;
    if (!date) {
        res.status(400).send({ error: 'Missing "date" query parameter' });
        return;
    }
    const jobId = `morning_${date}_${universe}_${Date.now()}`;
    // Initialize job
    const db = getDb();
    // Concurrency Guard
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({
            error: 'Job in progress',
            message: 'Cannot start morning execution while another job is RUNNING.',
            runningJobId: runningJobs.docs[0].id
        });
        return;
    }
    await db.collection('jobs').doc(jobId).set({
        id: jobId,
        runDate: date,
        universeId: universe,
        type: 'OPEN_SIM_RUN',
        stage: 'STARTING',
        status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
        dataSource: 'KITE',
        versionHash: 'v3.7Atomic',
    });
    // Start asynchronously to prevent dashboard timeouts
    (async () => {
        try {
            await runMorningLogic(date, jobId, universe);
            console.log(`[Job ${jobId}] Morning execution completed successfully`);
        }
        catch (err) {
            console.error(`[Job ${jobId}] Morning execution failed:`, err);
        }
    })();
    res.status(202).send({
        message: 'Morning execution triggered successfully',
        jobId
    });
}
/**
 * Logic to sync universe members and instrument tokens.
 */
async function doSyncUniverse(req, res) {
    const db = getDb();
    const date = new Date().toISOString().split('T')[0];
    const jobId = `sync_${date}_${Date.now()}`;
    // Check running
    const runningJobs = await db.collection('jobs').where('status', '==', 'RUNNING').limit(1).get();
    if (!runningJobs.empty) {
        res.status(409).send({ error: 'Job in progress', runningJobId: runningJobs.docs[0].id });
        return;
    }
    await db.collection('jobs').doc(jobId).set({
        id: jobId,
        runDate: date,
        type: 'SYNC_UNIVERSE',
        stage: 'STARTING',
        status: 'RUNNING',
        startedAt: admin.firestore.Timestamp.now(),
        updatedAt: admin.firestore.Timestamp.now(),
        versionHash: 'v3.7Atomic'
    });
    res.status(200).send({ message: 'Universe sync started', jobId });
    // Background sync logic
    (async () => {
        try {
            const settingsSnap = await db.collection('settings').doc('kite').get();
            const settings = settingsSnap.data();
            if (!(settings === null || settings === void 0 ? void 0 : settings.apiKey) || !(settings === null || settings === void 0 ? void 0 : settings.accessToken))
                throw new Error('Missing Kite credentials');
            await db.collection('jobs').doc(jobId).update({ stage: 'INSTRUMENTS' });
            const { getNSEInstruments } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
            await getNSEInstruments(settings.apiKey, settings.accessToken); // This caches internally but we might want to persist it
            // Update completion
            await db.collection('jobs').doc(jobId).update({
                status: 'DONE',
                stage: 'DONE',
                updatedAt: admin.firestore.Timestamp.now()
            });
        }
        catch (err) {
            console.error(`[Job ${jobId}] Sync failed:`, err);
            await db.collection('jobs').doc(jobId).update({
                status: 'FAILED',
                errorMessage: err.message || String(err),
                updatedAt: admin.firestore.Timestamp.now()
            });
        }
    })();
}
async function terminateJob(req, res) {
    var _a, _b, _c, _d;
    console.log('[Terminate] Triggered', {
        method: req.method,
        body: req.body,
        query: req.query
    });
    const jobId = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.jobId) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.jobId) || ((_c = req.body) === null || _c === void 0 ? void 0 : _c.job_id) || ((_d = req.query) === null || _d === void 0 ? void 0 : _d.job_id);
    if (!jobId || typeof jobId !== 'string') {
        res.status(400).send({ error: 'Missing or invalid jobId' });
        return;
    }
    const db = getDb();
    const docRef = db.collection('jobs').doc(jobId);
    const snap = await docRef.get();
    if (!snap.exists) {
        res.status(404).send({ error: `Job ${jobId} not found` });
        return;
    }
    await docRef.update({
        status: 'FAILED',
        errorMessage: 'Terminated by user',
        updatedAt: firestore_1.Timestamp.now()
    });
    res.status(200).send({ message: 'Job termination signal sent', jobId });
}
async function processStageTask(req, res) {
    res.status(200).send({ message: 'Stage tasks are now handled internally by orchestrator loop' });
}
/**
 * Core Logic: EOD Run
 */
async function runEodLogic(targetDate, targetJobId, targetUniverse = 'nifty50') {
    var _a;
    await logger_1.logger.info(`>>> [V13] runEodLogic ENTER`, 'Orchestrator', { targetDate, targetJobId, targetUniverse });
    console.log(`>>> [CRITICAL LOG] runEodLogic: Date=${targetDate}, JobID=${targetJobId}, Universe=${targetUniverse}`);
    const db = getDb();
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
    const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
    const indexSymbol = '^NSEI';
    const symbols = universeSnap.docs.map((d) => d.id).filter((s) => s !== indexSymbol);
    // Update job with total count and stage
    await db.collection('jobs').doc(targetJobId).update({
        'counts.total': symbols.length,
        stage: 'FETCH'
    });
    try {
        // 1. Index Processing
        const { doFetchCandles } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
        const { doComputeFeatures } = await Promise.resolve().then(() => __importStar(require('./features')));
        const { doComputeRegime } = await Promise.resolve().then(() => __importStar(require('./regime')));
        const indexSymbol = '^NSEI';
        const kiteIndexSymbol = 'NIFTY 50';
        const targetIndex = (settingsData === null || settingsData === void 0 ? void 0 : settingsData.accessToken) ? kiteIndexSymbol : indexSymbol;
        // Index stage (non-fatal for progress visibility)
        try {
            await doFetchCandles(targetJobId, targetIndex, targetDate, tokenMap[targetIndex]);
            await doComputeFeatures(targetJobId, targetIndex, targetDate);
            await db.collection('jobs').doc(targetJobId).update({ stage: 'REGIME' });
            await doComputeRegime(targetDate, targetJobId, targetIndex);
        }
        catch (err) {
            console.error(`Index stage failed for ${targetIndex}: ${err}. Continuing to symbol loop.`);
        }
        // Holiday Check: Only abort if NO recent index data exists at all (last 5 days).
        // We query backwards because weekends/holidays may mean today's bar doesn't exist,
        // but yesterday's (or Friday's) bar proves the market was open recently.
        const dateId = targetDate.replace(/-/g, '');
        const recentIndexSnap = await db.collection('barsD').doc(targetIndex).collection('days')
            .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
            .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
            .limit(1)
            .get();
        const mostRecentBar = recentIndexSnap.docs[0];
        const isHoliday = (() => {
            if (!mostRecentBar)
                return true; // No data at all
            const mostRecentDateId = mostRecentBar.id; // e.g. "20260320"
            // If the most recent bar is older than 5 days, likely a holiday/weekend with no data
            const fiveDaysAgo = new Date(targetDate);
            fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
            const fiveDaysAgoId = fiveDaysAgo.toISOString().split('T')[0].replace(/-/g, '');
            return mostRecentDateId < fiveDaysAgoId;
        })();
        if (isHoliday) {
            const msg = `[Job ${targetJobId}] Aborting run: ${targetDate} appears to be a holiday or has no index data (most recent: ${(_a = mostRecentBar === null || mostRecentBar === void 0 ? void 0 : mostRecentBar.id) !== null && _a !== void 0 ? _a : 'none'}).`;
            console.warn(msg);
            await db.collection('jobs').doc(targetJobId).update({
                stage: 'COMPLETED',
                status: 'SKIPPED',
                error: msg,
                updatedAt: admin.firestore.Timestamp.now()
            });
            return;
        }
        console.log(`[Job ${targetJobId}] Index check passed. Most recent bar: ${mostRecentBar === null || mostRecentBar === void 0 ? void 0 : mostRecentBar.id}. Proceeding with symbol dispatch.`);
        // 3. Main Loop: Dispatch tasks for each symbol (Fixed-rate to honor Kite limits)
        await db.collection('jobs').doc(targetJobId).update({ stage: 'SIGNALS' });
        console.log(`[Job ${targetJobId}] Dispatching ${symbols.length} tasks at 350ms intervals...`);
        for (const symbol of symbols) {
            await tasks_1.taskClient.enqueueDispatch('processSymbolTask', {
                jobId: targetJobId,
                symbol,
                date: targetDate,
                token: tokenMap[symbol],
                universe: targetUniverse
            });
            // Delay to maintain ~2.85 requests per second system-wide
            await new Promise(resolve => setTimeout(resolve, 350));
        }
        console.log(`[Job ${targetJobId}] All ${symbols.length} tasks dispatched successfully.`);
        // Note: We don't wait for them to finish here. 
        // The "DONE" logic will be triggered by an audit job or the last task.
        // For now, let's keep it simple: the dashboard tracks progress via Firestore updates from individual tasks.
        // 4. Wrap up
        const { doAggregateStats } = await Promise.resolve().then(() => __importStar(require('./aggregateStats')));
        const { doDailyAnalytics } = await Promise.resolve().then(() => __importStar(require('./journal')));
        await db.collection('jobs').doc(targetJobId).update({ stage: 'DONE' });
        try {
            await doAggregateStats(dateId);
            await doDailyAnalytics(targetJobId, targetDate);
            const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
            await generateJobReport(targetJobId, targetDate);
        }
        catch (err) {
            console.error(`Post-run analysis fail: ${err}`);
        }
        await db.collection('jobs').doc(targetJobId).update({ status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Job ${targetJobId}] CRITICAL FAIL: ${errMsg}`);
        await db.collection('jobs').doc(targetJobId).update({
            status: 'FAILED',
            errorMessage: errMsg,
            updatedAt: firestore_1.Timestamp.now()
        });
        throw err;
    }
}
/**
 * Core Logic: Morning Execution
 */
async function runMorningLogic(targetDate, targetJobId, targetUniverse = 'nifty50') {
    const db = getDb();
    const newJob = {
        runDate: targetDate,
        universeId: targetUniverse,
        type: 'OPEN_SIM_RUN',
        stage: 'FETCH',
        status: 'RUNNING',
        counts: { total: 0, done: 0, failed: 0 },
        startedAt: firestore_1.Timestamp.now(),
        updatedAt: firestore_1.Timestamp.now(),
        dataSource: 'KITE',
        versionHash: 'v3.7Atomic',
    };
    const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
    const symbols = universeSnap.docs.map(d => d.id);
    newJob.counts.total = symbols.length;
    await db.collection('jobs').doc(targetJobId).set(newJob);
    try {
        await db.collection('jobs').doc(targetJobId).update({ stage: 'ORDERS' });
        // Dispatch tasks for each symbol
        const taskPromises = symbols.map(symbol => tasks_1.taskClient.enqueueDispatch('processMorningSymbolTask', {
            jobId: targetJobId,
            date: targetDate,
            symbol
        }));
        await Promise.all(taskPromises);
        console.log(`[Morning Job ${targetJobId}] Dispatched ${taskPromises.length} symbol tasks.`);
        await db.collection('jobs').doc(targetJobId).update({ stage: 'DONE', status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
        try {
            const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
            await generateJobReport(targetJobId, targetDate);
        }
        catch (repErr) {
            console.error(`[Morning] Report generation failed for ${targetJobId}: ${repErr}`);
        }
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Morning Job ${targetJobId}] CRITICAL FAIL: ${errMsg}`);
        await db.collection('jobs').doc(targetJobId).update({
            status: 'FAILED',
            errorMessage: errMsg,
            updatedAt: firestore_1.Timestamp.now()
        });
        throw err;
    }
}
/**
 * Task Handler: Process a single symbol
 */
async function processSymbolTask(req) {
    console.log('>>> [V2-PUB] processSymbolTask ENTER', req.body);
    const { jobId, symbol, date, token } = req.body;
    if (!jobId || !symbol || !date) {
        console.error('[processSymbolTask] Missing required parameters', req.body);
        return;
    }
    const db = getDb();
    const dateId = toDateId(date);
    try {
        const { doFetchCandles } = await Promise.resolve().then(() => __importStar(require('./marketdata')));
        const { doComputeFeatures } = await Promise.resolve().then(() => __importStar(require('./features')));
        const { doEvaluateSignals } = await Promise.resolve().then(() => __importStar(require('./strategy')));
        const { doRiskApproval } = await Promise.resolve().then(() => __importStar(require('./risk')));
        // 1. Fetch
        await doFetchCandles(jobId, symbol, date, token);
        // 2. Compute Features
        await doComputeFeatures(jobId, symbol, date);
        // 3. Evaluate Signals
        await doEvaluateSignals(jobId, symbol, date);
        // 4. Risk Approval for new signals
        const sigSnap = await db.collection('signals').doc(dateId).collection('items').where('symbol', '==', symbol).get();
        for (const sigDoc of sigSnap.docs) {
            if (sigDoc.data().status === 'NEW') {
                await doRiskApproval(jobId, symbol, date, sigDoc.id);
            }
        }
        // 5. Atomic Update
        const jobRef = db.collection('jobs').doc(jobId);
        const updatedJob = await db.runTransaction(async (t) => {
            var _a;
            const doc = await t.get(jobRef);
            if (!doc.exists)
                return null;
            const data = doc.data();
            const newDone = (((_a = data.counts) === null || _a === void 0 ? void 0 : _a.done) || 0) + 1;
            t.update(jobRef, {
                'counts.done': newDone,
                updatedAt: firestore_1.Timestamp.now()
            });
            return Object.assign(Object.assign({}, data), { counts: Object.assign(Object.assign({}, data.counts), { done: newDone }) });
        });
        // 6. Check for completion
        if (updatedJob && updatedJob.counts.done + (updatedJob.counts.failed || 0) >= updatedJob.counts.total) {
            console.log(`[Job ${jobId}] Final symbol processed. Triggering wrap-up.`);
            // Run wrap-up logic
            const { doAggregateStats } = await Promise.resolve().then(() => __importStar(require('./aggregateStats')));
            const { doDailyAnalytics } = await Promise.resolve().then(() => __importStar(require('./journal')));
            const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
            await jobRef.update({ stage: 'DONE' });
            await doAggregateStats(dateId);
            await doDailyAnalytics(jobId, date);
            await generateJobReport(jobId, date);
            await jobRef.update({ status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
        }
    }
    catch (err) {
        console.error(`[Job ${jobId}] Failed for ${symbol}:`, err);
        await db.collection('jobs').doc(jobId).update({
            'counts.failed': admin.firestore.FieldValue.increment(1),
            updatedAt: firestore_1.Timestamp.now()
        });
    }
}
/**
 * Task Handler: Process a single symbol for morning execution
 */
async function processMorningSymbolTask(req) {
    console.log('>>> [V2-PUB] processMorningSymbolTask ENTER', req.body);
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
            const newDone = (((_a = data.counts) === null || _a === void 0 ? void 0 : _a.done) || 0) + 1;
            t.update(jobRef, {
                'counts.done': newDone,
                updatedAt: firestore_1.Timestamp.now()
            });
            return Object.assign(Object.assign({}, data), { counts: Object.assign(Object.assign({}, data.counts), { done: newDone }) });
        });
        if (updatedJob && updatedJob.counts.done + (updatedJob.counts.failed || 0) >= updatedJob.counts.total) {
            console.log(`[Morning Job ${jobId}] All symbols processed. Wrapping up.`);
            await jobRef.update({ stage: 'DONE', status: 'DONE', updatedAt: firestore_1.Timestamp.now() });
            try {
                const { generateJobReport } = await Promise.resolve().then(() => __importStar(require('./reporting')));
                await generateJobReport(jobId, date);
            }
            catch (repErr) {
                console.error(`[Morning] Report generation failed: ${repErr}`);
            }
        }
    }
    catch (err) {
        console.error(`[Morning Job ${jobId}] Failed for ${symbol}:`, err);
        await jobRef.update({
            'counts.failed': admin.firestore.FieldValue.increment(1),
            updatedAt: firestore_1.Timestamp.now()
        });
    }
}
//# sourceMappingURL=orchestrator.js.map