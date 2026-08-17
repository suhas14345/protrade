import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { taskClient } from './tasks';
import { CalendarService } from './calendar';
import { logger } from './logger';
import { ORCH_CONFIG, MARKET_HOURS, RUNTIME_CONFIG, METALS_CONFIG } from '../config/runtime';
import { isMarketClosed } from './marketdata';
import { raiseAlert, AlertType } from './alerting';

const getDb = () => {
  if (admin.apps.length === 0) {
    admin.initializeApp();
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin.firestore();
};

const toDateId = (date: string) => date.replace(/-/g, '');

/**
 * V3.0: Audit trail — logs stage transitions per symbol/job.
 */
async function auditLog(db: any, jobId: string, event: string, details: Record<string, any> = {}) {
  try {
    await db.collection('jobs').doc(jobId).collection('audit').add({
      event, ...details, timestamp: admin.firestore.Timestamp.now()
    });
  } catch { /* non-blocking */ }
}

/**
 * V3.0: Check idempotency — returns true if this stage was already completed.
 */
async function isStageCompleted(db: any, jobId: string, symbol: string, stage: string): Promise<boolean> {
  const key = `${jobId}_${symbol}_${stage}`;
  const sentinel = await db.collection('idempotency').doc(key).get();
  return sentinel.exists;
}

async function markStageCompleted(db: any, jobId: string, symbol: string, stage: string) {
  const key = `${jobId}_${symbol}_${stage}`;
  await db.collection('idempotency').doc(key).set({ completedAt: admin.firestore.Timestamp.now() });
}

/**
 * V3.0: Stuck job sweeper — call periodically to clean up orphaned jobs.
 */
export async function sweepStuckJobs() {
  const db = getDb();
  const cutoff = new Date(Date.now() - ORCH_CONFIG.JOB_TIMEOUT_MINUTES * 60000);
  const stuckJobs = await db.collection('jobs')
    .where('status', 'in', ['RUNNING', 'FINALIZING'])
    .where('startedAt', '<', Timestamp.fromDate(cutoff))
    .get();
  
  for (const doc of stuckJobs.docs) {
    await doc.ref.update({
      status: 'FAILED',
      errorMessage: `Auto-failed: exceeded ${ORCH_CONFIG.JOB_TIMEOUT_MINUTES}min timeout`,
      updatedAt: Timestamp.now()
    });
    await logger.warn(`[Orchestrator] Swept stuck job ${doc.id}`, 'Orchestrator');
  }
  return stuckJobs.size;
}

/**
 * Task Queue Trigger to get instrument map
 */
async function getInstrumentTokenMap(apiKey: string, accessToken: string): Promise<Record<string, number>> {
  const { getNSEInstrumentsMap } = await import('./marketdata');
  const instrumentsMap = await getNSEInstrumentsMap(apiKey, accessToken);
  const map: Record<string, number> = {};
  instrumentsMap.forEach((token, symbol) => {
    map[symbol] = token;
    map[symbol + '.NS'] = token;
  });
  return map;
}

/**
 * HTTP Triggers for Dashboard/Scheduler
 */
export async function doStartEodRun(req: any, res: any) {
  const { date, universe = 'nifty50', forceRegime, force } = { ...req.query, ...req.body } as any;
  if (!date) {
    res.status(400).send({ error: 'Missing "date" query parameter (YYYY-MM-DD)' });
    return;
  }

  // V3.0: Kill switch check
  if (RUNTIME_CONFIG.KILL_SWITCH) {
    res.status(503).send({ error: 'Kill switch is active — all trading halted' });
    return;
  }

  // V3.0: Market hours guard — reject if market still open (skip with force=true for paper testing)
  if (!force && RUNTIME_CONFIG.MODE !== 'BACKFILL' && RUNTIME_CONFIG.MODE !== 'REPLAY') {
    if (!isMarketClosed()) {
      res.status(400).send({ error: `Market still open. EOD can only run after ${MARKET_HOURS.EOD_SAFE_HOUR}:${String(MARKET_HOURS.EOD_SAFE_MINUTE).padStart(2,'0')} IST` });
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
  await taskClient.enqueue('orchestrateEodTask', { jobId, date, universe, forceRegime }, 'processSymbolTask');

  res.status(202).send({ message: 'EOD run triggered', jobId });
}

/**
 * Task Handler: Main EOD Orchestration Loop
 */
export async function orchestrateEodTask(req: any) {
  const { jobId, date, universe = 'nifty50', forceRegime } = req.body;
  if (!jobId || !date) {
    console.error('[Orchestrator] Missing jobId or date in task body');
    return;
  }
  
  try {
    await logger.info(`[Orchestrator] Starting orchestration task for Job ${jobId}`, 'Orchestrator');
    await runEodLogic(date, jobId, universe, forceRegime);
  } catch (err: any) {
    await logger.error(`[Orchestrator] Orchestration task failed: ${err.message}`, 'Orchestrator', { jobId });
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
export async function doStartDeepSync(req: any, res: any) {
  const { days = 90, universe = 'nifty500' } = { ...req.query, ...req.body } as any;
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

  await db.collection('jobs').doc(jobId).update({ 'counts.total': 0, updatedAt: Timestamp.now() });

  // Enqueue the deep sync orchestration loop as a task (Gap B13 Fixed)
  await taskClient.enqueue('orchestrateDeepSyncTask', { jobId, universe, days: forceDays });

  res.status(202).send({ message: 'Deep sync triggered', jobId, forceDays });
}

/**
 * Task Handler: Deep Sync Orchestration Loop
 */
export async function orchestrateDeepSyncTask(req: any) {
  const { jobId, universe = 'nifty500', days } = req.body;
  if (!jobId || !universe) {
    console.error('[Orchestrator] Missing jobId or universe in Deep Sync task body');
    return;
  }
  
  try {
    await logger.info(`[Orchestrator] Starting Deep Sync task for Job ${jobId}`, 'Orchestrator');
    await runDeepSyncLogic(jobId, universe, parseInt(days));
  } catch (err: any) {
    await logger.error(`[Orchestrator] Deep Sync task failed: ${err.message}`, 'Orchestrator', { jobId });
    const db = getDb();
    await db.collection('jobs').doc(jobId).update({ 
      status: 'FAILED', 
      errorMessage: `Deep Sync error: ${err.message}`, 
      updatedAt: Timestamp.now() 
    });
  }
}

async function runDeepSyncLogic(jobId: string, universeId: string, forceDays: number) {
  const db = getDb();
  const dateId = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const date = new Date().toISOString().split('T')[0];

  // 1. Get symbols
  const symbolsSnap = await db.collection('universes').doc(universeId).collection('members').get();
  const symbols = symbolsSnap.docs.map(d => d.id);
  
  await db.collection('jobs').doc(jobId).update({ 'counts.total': symbols.length, updatedAt: Timestamp.now() });

  // 2. Dispatch tasks
  for (const symbol of symbols) {
    await taskClient.enqueueDispatch('processSymbolTask', {
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

export async function doStartMorningExecution(req: any, res: any) {
  const { date, universe = 'nifty50' } = req.query as any;
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
        await logger.info(`[Orchestrator] Triggering Morning Execution for ${date}`, 'Orchestrator', { jobId, date, universe });
        await runMorningLogic(date, jobId, universe);
      } catch (err: any) {
        await logger.error(`[Orchestrator] Morning execution failed: ${err.message}`, 'Orchestrator', { jobId, error: err.message });
        console.error(`[Job ${jobId}] Morning execution failed:`, err);
      }
    })();

  res.status(202).send({ message: 'Morning execution triggered', jobId });
}

/**
 * Logic to sync universe members and instrument tokens. (Restored for Rule Compliance)
 */
export async function doSyncUniverse(req: any, res: any) {
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
      const { getNSEInstrumentsMap } = await import('./marketdata');
      const settingsSnap = await db.collection('settings').doc('kite').get();
      const settings = settingsSnap.data();
      if (settings?.apiKey && settings?.accessToken) await getNSEInstrumentsMap(settings.apiKey, settings.accessToken);
      await db.collection('jobs').doc(jobId).update({ status: 'DONE', stage: 'DONE', updatedAt: admin.firestore.Timestamp.now() });
    } catch (err: any) { await db.collection('jobs').doc(jobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: admin.firestore.Timestamp.now() }); }
  })();
}

export async function terminateJob(req: any, res: any) {
  const jobId = req.body?.jobId || req.query?.jobId;
  if (!jobId) { res.status(400).send({ error: 'Missing jobId' }); return; }
  const db = getDb();
  await db.collection('jobs').doc(jobId).update({ status: 'FAILED', errorMessage: 'Terminated by user', updatedAt: Timestamp.now() });
  res.status(200).send({ message: 'Terminated', jobId });
}

/**
 * Core Logic: EOD Run (Refactored Gap B4)
 */
export async function runEodLogic(targetDate: string, targetJobId: string, targetUniverse: string = 'nifty50', forceRegime?: string) {
  const db = getDb();
  const dateId = toDateId(targetDate);
  
  const settingsSnap = await db.collection('settings').doc('kite').get();
  const settingsData = settingsSnap.data();
  let tokenMap: Record<string, number> = {};

  if (settingsData?.apiKey && settingsData?.accessToken && settingsData?.status === 'ACTIVE') {
    try {
      tokenMap = await getInstrumentTokenMap(settingsData.apiKey, settingsData.accessToken);
    } catch (err) { console.error(`[Job ${targetJobId}] Instrument cache fail: ${err}`); }
  }

  // 1. Trading Day Correctness (Gap B4.2)
  const isTrading = await CalendarService.isTradingDay(dateId);
  if (!isTrading) {
    const msg = `[Job ${targetJobId}] Aborting: ${targetDate} is not a trading day according to calendar.`;
    console.warn(msg);
    await db.collection('jobs').doc(targetJobId).update({ stage: 'COMPLETED', status: 'SKIPPED', error: msg, updatedAt: admin.firestore.Timestamp.now() });
    return;
  }

  const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
  const symbols: string[] = universeSnap.docs.map((d: any) => d.id).filter((s: string) => s !== '^NSEI');
  // Metals sleeve ETFs are always part of the daily run, independent of universe membership.
  if (METALS_CONFIG.ENABLED) {
    for (const m of METALS_CONFIG.SYMBOLS) if (!symbols.includes(m)) symbols.push(m);
  }
  
  await db.collection('jobs').doc(targetJobId).update({ 'counts.total': symbols.length, stage: 'FETCH' });

  try {
    // Trade management (exits) is NOT run here: today's per-symbol bars are fetched
    // asynchronously in the fan-out below, so at this point getBarOn(symbol, today)
    // is null and every position would be skipped. It runs in the finalize step
    // (checkAndFinalizeJob), after all bars are fetched, before placing new orders.

    // 3. Index Processing (Regime)
    const { doFetchCandles } = await import('./marketdata');
    const { doComputeFeatures } = await import('./features');
    const { doComputeRegime } = await import('./regime');

    const indexSymbol = settingsData?.accessToken ? 'NIFTY 50' : '^NSEI';
    await doFetchCandles(targetJobId, indexSymbol, targetDate, tokenMap[indexSymbol]);
    await doComputeFeatures(targetJobId, indexSymbol, targetDate);
    await db.collection('jobs').doc(targetJobId).update({ stage: 'REGIME' });
    if (forceRegime) {
      await logger.info(`[Orchestrator] Forcing regime to ${forceRegime} for Job ${targetJobId}`, 'Orchestrator');
      await db.collection('jobs').doc(targetJobId).update({ marketState: forceRegime });
    } else {
      await doComputeRegime(targetDate, targetJobId, indexSymbol, targetUniverse);
    }
 
    // 4. Dispatch tasks (Gap B4.1)
    await db.collection('jobs').doc(targetJobId).update({ stage: 'SIGNALS' });
    await logger.info(`[Orchestrator] Dispatching tasks for ${symbols.length} symbols`, 'Orchestrator', { jobId: targetJobId });
    for (const symbol of symbols) {
      await taskClient.enqueueDispatch('processSymbolTask', { 
        jobId: targetJobId, symbol, date: targetDate, 
        dateId, // Pass dateId to symbol task (Gap B11 Fixed)
        token: tokenMap[symbol], universe: targetUniverse,
        forceRegime 
      });
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  } catch (err: any) {
    await db.collection('jobs').doc(targetJobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: Timestamp.now() });
    throw err;
  }
}

/**
 * Morning Execution logic
 */
export async function runMorningLogic(targetDate: string, targetJobId: string, targetUniverse: string = 'nifty50') {
  const db = getDb();
  const universeSnap = await db.collection('universes').doc(targetUniverse).collection('members').get();
  const symbols = universeSnap.docs.map(d => d.id);
  // Metals sleeve ETFs are always part of the morning fill run too.
  if (METALS_CONFIG.ENABLED) {
    for (const m of METALS_CONFIG.SYMBOLS) if (!symbols.includes(m)) symbols.push(m);
  }
  
  await db.collection('jobs').doc(targetJobId).update({ 'counts.total': symbols.length, stage: 'ORDERS' });

  try {
    for (const symbol of symbols) {
      await taskClient.enqueueDispatch('processSymbolTask', { jobId: targetJobId, date: targetDate, symbol, taskSubType: 'morning' });
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  } catch (err: any) {
    await db.collection('jobs').doc(targetJobId).update({ status: 'FAILED', errorMessage: err.message, updatedAt: Timestamp.now() });
    throw err;
  }
}

/**
 * Task Handler: Process a single symbol (Redundancy Removed Gap B1)
 */
export async function processSymbolTask(req: any) {
  // Route morning fill tasks to the dedicated handler
  if (req.body?.taskSubType === 'morning') {
    return processMorningSymbolTask(req);
  }

  const { jobId, symbol, date, forceRegime, forceDays, universe } = req.body;
  let { dateId } = req.body;
  if (!jobId || !symbol || !date) {
    console.error('[Orchestrator] Missing jobId, symbol, or date in processSymbolTask body');
    return;
  }
  const db = getDb();
  if (!dateId) dateId = date.replace(/-/g, '');
  const jobRef = db.collection('jobs').doc(jobId);

  // V3.0: Check if job is still RUNNING (don't process if FAILED/DONE)
  const jobCheck = await jobRef.get();
  if (!jobCheck.exists || !['RUNNING', 'FINALIZING'].includes(jobCheck.data()?.status)) {
    console.warn(`[Orchestrator] Skipping ${symbol}: job ${jobId} is ${jobCheck.data()?.status}`);
    return;
  }

  try {
    // 1. Fetch (with idempotency)
    if (!await isStageCompleted(db, jobId, symbol, 'FETCH')) {
      const { doFetchCandles } = await import('./marketdata');
      await doFetchCandles(jobId, symbol, date, undefined, forceDays);
      await markStageCompleted(db, jobId, symbol, 'FETCH');
    }

    // 1b. Fill prior-day orders at today's open. Runs here (after today's bar is fetched)
    // instead of a 09:15 job, which fired before the day's bar existed and left orders unfilled.
    if (jobCheck.data()?.type === 'EOD_RUN' && !await isStageCompleted(db, jobId, symbol, 'FILL')) {
      try {
        const { doOpenFillSimulation } = await import('./paperBroker');
        await doOpenFillSimulation(jobId, date, symbol);
        await markStageCompleted(db, jobId, symbol, 'FILL');
      } catch (fillErr: any) {
        await logger.warn(`[Orchestrator] Fill for ${symbol} failed (non-blocking): ${fillErr.message}`, 'Orchestrator', { jobId, symbol });
      }
    }

    // 2. Features (with idempotency)
    if (!await isStageCompleted(db, jobId, symbol, 'FEATURES')) {
      const { doComputeFeatures } = await import('./features');
      await doComputeFeatures(jobId, symbol, date);
      await markStageCompleted(db, jobId, symbol, 'FEATURES');
    }
    
    // 3. Signals (Only for EOD_RUN, with idempotency)
    const jobSnapForType = await jobRef.get();
    const jobData = jobSnapForType.data();
    if (jobData?.type === 'EOD_RUN' && !await isStageCompleted(db, jobId, symbol, 'SIGNALS')) {
      const { doEvaluateSignals } = await import('./strategy');
      await doEvaluateSignals(jobId, symbol, date, forceRegime, universe || jobData?.universeId || 'nifty500');
      await markStageCompleted(db, jobId, symbol, 'SIGNALS');
    }

    // Atomic update and wrap-up check
    const updatedJob = await db.runTransaction(async (t: any) => {
      const doc = await t.get(jobRef);
      if (!doc.exists) return null;
      const data = doc.data()!;
      if (data.status !== 'RUNNING') return null;
      
      const newDone = (data.counts?.done || 0) + 1;
      t.update(jobRef, { 'counts.done': newDone, updatedAt: Timestamp.now() });
      return { ...data, counts: { ...data.counts, done: newDone } };
    });

    await auditLog(db, jobId, 'SYMBOL_COMPLETE', { symbol, dateId });
    await checkAndFinalizeJob(db, jobRef, jobId, dateId, date, updatedJob);
  } catch (err: any) {
    await auditLog(db, jobId, 'SYMBOL_FAILED', { symbol, dateId, error: err.message });
    await logger.error(`[Orchestrator] Symbol ${symbol} failed: ${err.message}`, 'Orchestrator', { jobId, symbol });
    
    const jobRef = db.collection('jobs').doc(jobId);
    await jobRef.update({ 'counts.failed': admin.firestore.FieldValue.increment(1), updatedAt: Timestamp.now() });
    
    // V3.0: Check failure threshold — abort if too many symbols fail
    const jobSnap = await jobRef.get();
    const jobData = jobSnap.data();
    if (jobData && jobData.status === 'RUNNING') {
      const failPct = (jobData.counts?.failed || 0) / (jobData.counts?.total || 1);
      if (failPct > ORCH_CONFIG.MAX_FAILURE_PCT) {
        await logger.error(`[Orchestrator] ABORTING job ${jobId}: ${(failPct*100).toFixed(0)}% symbols failed (threshold: ${ORCH_CONFIG.MAX_FAILURE_PCT*100}%)`, 'Orchestrator', { jobId });
        await raiseAlert(AlertType.JOB_FAILED, 'CRITICAL', `Job ${jobId} aborted: ${(failPct*100).toFixed(0)}% symbol failure rate`, { jobId, failPct });
        await jobRef.update({ status: 'FAILED', errorMessage: `Aborted: ${(failPct*100).toFixed(0)}% symbol failure rate exceeded threshold`, updatedAt: Timestamp.now() });
        return;
      }
      await checkAndFinalizeJob(db, jobRef, jobId, dateId, date, { ...jobData });
    }
  }
}

/**
 * Shared helper: runs wrap-up when all tasks (done + failed) >= total.
 */
async function checkAndFinalizeJob(db: any, jobRef: any, jobId: string, dateId: string, date: string, jobData: any) {
  if (!jobData || !jobId || !dateId) {
    console.warn(`[Orchestrator] checkAndFinalizeJob aborted: Missing jobId(${jobId}) or dateId(${dateId})`);
    return;
  }
  const done = jobData.counts?.done || 0;
  const failed = jobData.counts?.failed || 0;
  const total = jobData.counts?.total || 0;

  if (done + failed < total) return; // Not finished yet

  // V3.0: Data completeness check before finalization
  const completionPct = total > 0 ? done / total : 0;
  if (ORCH_CONFIG.STAGE_BARRIER_ENABLED && completionPct < ORCH_CONFIG.MIN_DATA_COMPLETENESS_PCT) {
    await logger.error(`[Orchestrator] Job ${jobId}: Only ${(completionPct*100).toFixed(0)}% symbols succeeded (need ${ORCH_CONFIG.MIN_DATA_COMPLETENESS_PCT*100}%). Aborting.`, 'Orchestrator', { jobId });
    await raiseAlert(AlertType.DATA_STALE, 'WARN', `Job ${jobId}: data completeness ${(completionPct*100).toFixed(0)}% below threshold`, { jobId, completionPct });
    await jobRef.update({ status: 'FAILED', errorMessage: `Data completeness ${(completionPct*100).toFixed(0)}% below threshold`, updatedAt: Timestamp.now() });
    return;
  }

  // V3.0: Index bar check — ensure regime data exists
  if (ORCH_CONFIG.INDEX_BAR_REQUIRED && jobData.type === 'EOD_RUN') {
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    if (!regimeSnap.exists) {
      await logger.error(`[Orchestrator] Job ${jobId}: No regime data for ${dateId}. Cannot finalize.`, 'Orchestrator', { jobId });
      await jobRef.update({ status: 'FAILED', errorMessage: 'Regime data missing — index processing may have failed', updatedAt: Timestamp.now() });
      return;
    }
  }

  // Guard: only one task should run wrap-up (with retry counter)
  let retryCount = 0;
  try {
    await db.runTransaction(async (t: any) => {
      const snap = await t.get(jobRef);
      if (!snap.exists || snap.data().status !== 'RUNNING') throw new Error('ALREADY_FINALIZED');
      retryCount = snap.data().finalizationRetries || 0;
      if (retryCount >= ORCH_CONFIG.FINALIZATION_MAX_RETRIES) throw new Error('MAX_RETRIES_EXCEEDED');
      t.update(jobRef, { status: 'FINALIZING', finalizationRetries: retryCount + 1, updatedAt: Timestamp.now() });
    });
  } catch (e: any) {
    if (e.message === 'ALREADY_FINALIZED') return;
    if (e.message === 'MAX_RETRIES_EXCEEDED') {
      await jobRef.update({ status: 'FAILED', errorMessage: `Finalization failed after ${ORCH_CONFIG.FINALIZATION_MAX_RETRIES} retries`, updatedAt: Timestamp.now() });
      await raiseAlert(AlertType.JOB_FAILED, 'CRITICAL', `Job ${jobId} finalization exceeded max retries`, { jobId, retries: ORCH_CONFIG.FINALIZATION_MAX_RETRIES });
      await logger.error(`[Orchestrator] Job ${jobId} finalization exceeded max retries`, 'Orchestrator', { jobId });
      return;
    }
    throw e;
  }

  try {
    const { doAggregateStats } = await import('./aggregateStats');
    const { doDailyAnalytics } = await import('./journal');
    const { generateJobReport } = await import('./reporting');
    const { doPlaceOrders } = await import('./paperBroker');

    // RS Rankings
    const universeId = jobData.universeId || 'nifty500';
    try {
      await jobRef.update({ stage: 'RS_RANK' });
      const { doComputeRsRanking } = await import('./rsRanking');
      await doComputeRsRanking(dateId, jobId, universeId);
      await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'RS_RANK' });
    } catch (rsErr: any) {
      await logger.warn(`[Orchestrator] RS ranking failed (non-blocking): ${rsErr.message}`, 'Orchestrator', { jobId });
      await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'RS_RANK', error: rsErr.message });
    }

    // Correlation
    try {
      await jobRef.update({ stage: 'CORR' });
      const { doComputeCorrTopN } = await import('./corrTopN');
      await doComputeCorrTopN(dateId, jobId, universeId);
      await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'CORR' });
    } catch (corrErr: any) {
      await logger.warn(`[Orchestrator] CorrTopN failed (non-blocking): ${corrErr.message}`, 'Orchestrator', { jobId });
      await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'CORR', error: corrErr.message });
    }

    // Manage open positions against today's just-fetched close, then place orders.
    // Runs here (finalize, after all per-symbol FETCH completed) so getBarOn(today)
    // resolves — at the start of the EOD the bars don't exist yet. Covers every open
    // position, not just dispatched symbols. Exits queue as next-open orders.
    if (jobData.type === 'EOD_RUN') {
      await jobRef.update({ stage: 'MANAGE' });
      try {
        const { doManageTrades } = await import('./tradeManager');
        await doManageTrades(dateId, jobId);
        await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'MANAGE' });
      } catch (mgErr: any) {
        await logger.warn(`[Orchestrator] Trade management failed: ${mgErr.message}`, 'Orchestrator', { jobId });
        await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'MANAGE', error: mgErr.message });
      }
    }

    // Orders
    await jobRef.update({ stage: 'ORDERS' });
    try {
      // V3.0: Kill switch check before placing orders
      if (!RUNTIME_CONFIG.KILL_SWITCH) {
        await doPlaceOrders(dateId, jobId);
        await auditLog(db, jobId, 'STAGE_COMPLETE', { stage: 'ORDERS' });
      } else {
        await logger.warn(`[Orchestrator] Kill switch active — skipping order placement`, 'Orchestrator', { jobId });
        await auditLog(db, jobId, 'STAGE_SKIPPED', { stage: 'ORDERS', reason: 'KILL_SWITCH' });
      }
    } catch (err: any) {
      await logger.warn(`[Orchestrator] Order placement failed: ${err.message}`, 'Orchestrator', { jobId });
      await auditLog(db, jobId, 'STAGE_FAILED', { stage: 'ORDERS', error: err.message });
    }

    await jobRef.update({ stage: 'DONE' });
    
    // Optional wrap-up tasks
    try {
      await CalendarService.upsertToday(dateId);
      await doAggregateStats(dateId);
      await doDailyAnalytics(jobId, date);
      await generateJobReport(jobId, date);
    } catch (wrapSubErr: any) {
      await logger.error(`[Orchestrator] Non-critical wrap-up task failed: ${wrapSubErr.message}`, 'Orchestrator', { jobId });
    }

    await logger.info(`[Orchestrator] Job ${jobId} Completed. Done: ${done}, Failed: ${failed}, Total: ${total}`, 'Orchestrator', { jobId, date, done, failed, total });
    await auditLog(db, jobId, 'JOB_COMPLETE', { done, failed, total });
    await jobRef.update({ status: 'DONE', updatedAt: Timestamp.now() });
  } catch (wrapErr: any) {
    await logger.error(`[Orchestrator] Critical wrap-up error for ${jobId}: ${wrapErr.message}`, 'Orchestrator', { jobId });
    await auditLog(db, jobId, 'FINALIZATION_ERROR', { error: wrapErr.message, retryCount });
    await jobRef.update({ status: 'FAILED', errorMessage: `Wrap-up error: ${wrapErr.message}`, updatedAt: Timestamp.now() });
  }
}
 
 /**
  * Shared helper: runs wrap-up for morning jobs when all tasks >= total.
  */
 async function checkAndFinalizeMorningJob(db: any, jobRef: any, jobId: string, date: string, jobData: any) {
   if (!jobData) return;
   const done = jobData.counts?.done || 0;
   const failed = jobData.counts?.failed || 0;
   const total = jobData.counts?.total || 0;
 
   if (done + failed < total) return; // Not finished yet
 
   // Guard: only one task should run wrap-up
   try {
     await db.runTransaction(async (t: any) => {
       const snap = await t.get(jobRef);
       if (!snap.exists || snap.data().status !== 'RUNNING') throw new Error('ALREADY_FINALIZED');
       t.update(jobRef, { status: 'FINALIZING', updatedAt: Timestamp.now() });
     });
   } catch (e: any) {
     if (e.message === 'ALREADY_FINALIZED') return; 
     throw e;
   }
 
   try {
     await jobRef.update({ stage: 'DONE' });
     try {
       const { generateJobReport } = await import('./reporting');
       await generateJobReport(jobId, date);
     } catch (err: any) {
       await logger.warn(`[Orchestrator] Morning report error: ${err.message}`, 'Orchestrator', { jobId });
     }
     await jobRef.update({ status: 'DONE', updatedAt: Timestamp.now() });
     await logger.info(`[Orchestrator] Morning Job ${jobId} Completed successfully.`, 'Orchestrator', { jobId, date });
   } catch (wrapErr: any) {
     await logger.error(`[Orchestrator] Critical morning wrap-up error: ${wrapErr.message}`, 'Orchestrator', { jobId });
     await jobRef.update({ status: 'FAILED', errorMessage: `Morning wrap-up error: ${wrapErr.message}`, updatedAt: Timestamp.now() });
   }
 }

export async function processMorningSymbolTask(req: any) {
  const { jobId, date, symbol } = req.body;
  if (!jobId || !symbol || !date) return;
  const db = getDb();
  const jobRef = db.collection('jobs').doc(jobId);

  try {
    const { doOpenFillSimulation } = await import('./paperBroker');
    await doOpenFillSimulation(jobId, date, symbol);

    const updatedJob = await db.runTransaction(async (t) => {
      const doc = await t.get(jobRef);
      if (!doc.exists) return null;
      const data = doc.data()!;
      if (data.status !== 'RUNNING') return null;
      
      const newDone = (data.counts?.done || 0) + 1;
      t.update(jobRef, { 'counts.done': newDone, updatedAt: Timestamp.now() });
      return { ...data, counts: { ...data.counts, done: newDone } };
    });

    await checkAndFinalizeMorningJob(db, jobRef, jobId, date, updatedJob);
  } catch (err: any) {
    const jobRef = db.collection('jobs').doc(jobId);
    await jobRef.update({ 'counts.failed': admin.firestore.FieldValue.increment(1), updatedAt: Timestamp.now() });
    const jobSnap = await jobRef.get();
    const jobData = jobSnap.data();
    if (jobData && jobData.status === 'RUNNING') {
       await checkAndFinalizeMorningJob(db, jobRef, jobId, date, { ...jobData });
    }
  }
}

/**
 * Migration Utility: One-off historical sync
 */
export async function doSyncCalendar(req: any, res: any) {
  const { symbol = '^NSEI' } = req.query || {};
  try {
    await CalendarService.syncFromIndexData(String(symbol));
    res.status(200).send({ message: 'Calendar historical sync complete' });
  } catch (e: any) { res.status(500).send(e.message); }
}
