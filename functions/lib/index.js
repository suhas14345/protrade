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
exports.processStageTask = exports.processMorningSymbolTask = exports.processSymbolTask = exports.manageTradesTask = exports.riskApproveTask = exports.evaluateSignalsTask = exports.computeFeaturesTask = exports.fetchCandlesTask = exports.downloadReport = exports.probeInventory = exports.diagnostics = exports.updateKiteCredentials = exports.updateKitetoken = exports.checkKiteHealth = exports.updateUniverseFromCsv = exports.validateUniverseCsv = exports.cleanupUniverse = exports.seedUniverse = exports.purgeJobs = exports.cleanupData = exports.auditJobs = exports.probeLogs = exports.terminateJob = exports.startMorningExecution = exports.startEodRun = void 0;
const https_1 = require("firebase-functions/v2/https");
// Import services
const orchestrator = __importStar(require("./services/orchestrator"));
const maintenance = __importStar(require("./services/maintenance"));
const marketdata = __importStar(require("./services/marketdata"));
const universe = __importStar(require("./services/universe"));
const diag = __importStar(require("./services/diag"));
const features = __importStar(require("./services/features"));
const strategy = __importStar(require("./services/strategy"));
const risk = __importStar(require("./services/risk"));
const tradeManager = __importStar(require("./services/tradeManager"));
// Options for public functions to avoid auth issues during transition
const publicOptions = {
    memory: '512MiB',
    timeoutSeconds: 900,
    cors: true,
    invoker: 'public',
};
// --- Orchestrator / Job Control ---
exports.startEodRun = (0, https_1.onRequest)(publicOptions, (req, res) => orchestrator.doStartEodRun(req, res));
exports.startMorningExecution = (0, https_1.onRequest)(publicOptions, (req, res) => orchestrator.doStartMorningExecution(req, res));
exports.terminateJob = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => orchestrator.terminateJob(req, res));
exports.probeLogs = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => {
    res.status(200).send({ message: "probeLogs placeholder - check Firestore for real-time status" });
});
// --- Maintenance & Jobs ---
exports.auditJobs = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => maintenance.auditJobs(req, res));
exports.cleanupData = (0, https_1.onRequest)({ timeoutSeconds: 540, memory: '512MiB', cors: true, invoker: 'public' }, (req, res) => maintenance.cleanupData(req, res));
exports.purgeJobs = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => maintenance.purgeJobs(req, res));
// --- Universe Management ---
exports.seedUniverse = (0, https_1.onRequest)({ memory: '512MiB', timeoutSeconds: 300, cors: true, invoker: 'public' }, (req, res) => universe.seedUniverse(req, res));
exports.cleanupUniverse = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => universe.cleanupUniverse(req, res));
exports.validateUniverseCsv = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => universe.validateUniverseCsv(req, res));
exports.updateUniverseFromCsv = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => universe.updateUniverseFromCsv(req, res));
// --- Market Data & Kite ---
exports.checkKiteHealth = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => marketdata.checkKiteHealth(req, res));
exports.updateKitetoken = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => marketdata.updateKiteToken(req, res));
exports.updateKiteCredentials = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => marketdata.updateKiteCredentials(req, res));
// --- Diagnostics & Reporting ---
exports.diagnostics = diag.diagnostics;
exports.probeInventory = diag.probeInventory;
exports.downloadReport = (0, https_1.onRequest)({ cors: true, invoker: 'public' }, (req, res) => diag.downloadReport(req, res));
// --- Task Queue Handlers (V2) ---
// We use public onRequest here to resolve 401 Unauthorized errors from Cloud Tasks.
// Each wrapper ensures a 200 OK response is sent back to Cloud Tasks to prevent retries.
exports.fetchCandlesTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await marketdata.fetchCandlesTask(req, {});
    res.status(200).send({ success: true });
});
exports.computeFeaturesTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await features.computeFeaturesTask(req, {});
    res.status(200).send({ success: true });
});
exports.evaluateSignalsTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await strategy.evaluateSignalsTask(req, {});
    res.status(200).send({ success: true });
});
exports.riskApproveTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await risk.riskApproveTask(req, {});
    res.status(200).send({ success: true });
});
exports.manageTradesTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await tradeManager.manageTradesTask(req, {});
    res.status(200).send({ success: true });
});
exports.processSymbolTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await orchestrator.processSymbolTask(req);
    res.status(200).send({ success: true });
});
exports.processMorningSymbolTask = (0, https_1.onRequest)(publicOptions, async (req, res) => {
    await orchestrator.processMorningSymbolTask(req);
    res.status(200).send({ success: true });
});
exports.processStageTask = (0, https_1.onRequest)(publicOptions, (req, res) => {
    console.log('processStageTask called (legacy). No action taken.');
    res.status(200).send({ message: 'OK' });
});
//# sourceMappingURL=index.js.map