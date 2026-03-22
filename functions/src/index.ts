import { onRequest } from 'firebase-functions/v2/https';

// Import services
import * as orchestrator from './services/orchestrator';
import * as maintenance from './services/maintenance';
import * as marketdata from './services/marketdata';
import * as universe from './services/universe';
import * as diag from './services/diag';
import * as features from './services/features';
import * as strategy from './services/strategy';
import * as risk from './services/risk';
import * as tradeManager from './services/tradeManager';

// Options for orchestrator functions (need more time for sequential enqueuing)
const orchestratorOptions = {
  memory: '1GiB' as const,
  timeoutSeconds: 3600,
  cors: true,
  invoker: 'public' as const,
};

// Options for normal task handlers
const publicOptions = {
  memory: '512MiB' as const,
  timeoutSeconds: 900,
  cors: true,
  invoker: 'public' as const,
};

// --- Orchestrator / Job Control ---
export const startEodRun = onRequest(orchestratorOptions, (req, res) => orchestrator.doStartEodRun(req, res));
export const startMorningExecution = onRequest(orchestratorOptions, (req, res) => orchestrator.doStartMorningExecution(req, res));
export const terminateJob = onRequest({ cors: true, invoker: 'public' }, (req, res) => orchestrator.terminateJob(req, res));
export const probeLogs = onRequest({ cors: true, invoker: 'public' }, (req, res) => {
    res.status(200).send({ message: "probeLogs placeholder - check Firestore for real-time status" });
});

// --- Maintenance & Jobs ---
export const auditJobs = onRequest({ cors: true, invoker: 'public' }, (req, res) => maintenance.auditJobs(req, res));
export const cleanupData = onRequest({ timeoutSeconds: 540, memory: '512MiB', cors: true, invoker: 'public' }, (req, res) => maintenance.cleanupData(req, res));
export const purgeJobs = onRequest({ cors: true, invoker: 'public' }, (req, res) => maintenance.purgeJobs(req, res));

// --- Universe Management ---
export const seedUniverse = onRequest({ memory: '512MiB', timeoutSeconds: 300, cors: true, invoker: 'public' }, (req, res) => universe.seedUniverse(req, res));
export const cleanupUniverse = onRequest({ cors: true, invoker: 'public' }, (req, res) => universe.cleanupUniverse(req, res));
export const validateUniverseCsv = onRequest({ cors: true, invoker: 'public' }, (req, res) => universe.validateUniverseCsv(req, res));
export const updateUniverseFromCsv = onRequest({ cors: true, invoker: 'public' }, (req, res) => universe.updateUniverseFromCsv(req, res));

// --- Market Data & Kite ---
export const checkKiteHealth = onRequest({ cors: true, invoker: 'public' }, (req, res) => marketdata.checkKiteHealth(req, res));
export const updateKitetoken = onRequest({ cors: true, invoker: 'public' }, (req, res) => marketdata.updateKiteToken(req, res));
export const updateKiteCredentials = onRequest({ cors: true, invoker: 'public' }, (req, res) => marketdata.updateKiteCredentials(req, res));

// --- Diagnostics & Reporting ---
export const diagnostics = diag.diagnostics; 
export const probeInventory = diag.probeInventory;
export const downloadReport = onRequest({ cors: true, invoker: 'public' }, (req, res) => diag.downloadReport(req, res));

// --- Task Queue Handlers (V2) ---
// We use public onRequest here to resolve 401 Unauthorized errors from Cloud Tasks.
// Each wrapper ensures a 200 OK response is sent back to Cloud Tasks to prevent retries.

export const fetchCandlesTask = onRequest(publicOptions, async (req, res) => {
    await marketdata.fetchCandlesTask(req as any, {} as any);
    res.status(200).send({ success: true });
});

export const computeFeaturesTask = onRequest(publicOptions, async (req, res) => {
    await features.computeFeaturesTask(req as any, {} as any);
    res.status(200).send({ success: true });
});

export const evaluateSignalsTask = onRequest(publicOptions, async (req, res) => {
    await strategy.evaluateSignalsTask(req as any, {} as any);
    res.status(200).send({ success: true });
});

export const riskApproveTask = onRequest(publicOptions, async (req, res) => {
    await risk.riskApproveTask(req as any, {} as any);
    res.status(200).send({ success: true });
});

export const manageTradesTask = onRequest(publicOptions, async (req, res) => {
    await tradeManager.manageTradesTask(req as any, {} as any);
    res.status(200).send({ success: true });
});

export const processSymbolTask = onRequest(publicOptions, async (req, res) => {
    await orchestrator.processSymbolTask(req);
    res.status(200).send({ success: true });
});

export const processMorningSymbolTask = onRequest(publicOptions, async (req, res) => {
    await orchestrator.processMorningSymbolTask(req);
    res.status(200).send({ success: true });
});

export const processStageTask = onRequest(publicOptions, (req, res) => {
    console.log('processStageTask called (legacy). No action taken.');
    res.status(200).send({ message: 'OK' });
});
