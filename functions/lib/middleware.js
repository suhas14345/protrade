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
exports.validateRequest = validateRequest;
exports.validateApiKey = validateApiKey;
exports.checkRateLimit = checkRateLimit;
exports.checkKiteHealth = checkKiteHealth;
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("./config/runtime");
// ---------------------------------------------------------------------------
// 1. Request validation
// ---------------------------------------------------------------------------
const KNOWN_ACTIONS = new Set([
    'startEod', 'startDeepSync', 'terminate',
    'fetchCandles', 'computeFeatures', 'evaluateSignals',
    'computeRsRanking', 'computeCorrTopN', 'manageTrades',
    'processSymbol', 'orchestrateEod', 'orchestrateDeepSync',
    'diagnostics', 'checkHealth', 'updateToken', 'updateCredentials', 'seedUniverse',
    'systemHealth', 'sweepStuckJobs', 'getAlerts',
    'probeInventory', 'auditJobs', 'downloadReport',
    'scheduledKiteRenew', 'scheduledEod', 'scheduledMorning',
    'startMorningExecution', 'getKiteSettings',
    'syncNseHolidays',
]);
function validateRequest(body) {
    const action = body === null || body === void 0 ? void 0 : body.action;
    if (!action || typeof action !== 'string') {
        return { valid: false, error: 'Missing or non-string "action" field' };
    }
    if (!KNOWN_ACTIONS.has(action)) {
        return { valid: false, error: `Unknown action: ${action}` };
    }
    return { valid: true };
}
// ---------------------------------------------------------------------------
// 2. API-key auth
// ---------------------------------------------------------------------------
async function validateApiKey(req) {
    var _a;
    if (!runtime_1.SECURITY_CONFIG.REQUIRE_AUTH)
        return { authenticated: true };
    const key = req.headers[runtime_1.SECURITY_CONFIG.API_KEY_HEADER];
    if (!key || typeof key !== 'string') {
        return { authenticated: false, error: 'Missing API key' };
    }
    const doc = await admin.firestore().doc('config/apiKey').get();
    const storedKey = (_a = doc.data()) === null || _a === void 0 ? void 0 : _a.key;
    if (!storedKey || key !== storedKey) {
        return { authenticated: false, error: 'Invalid API key' };
    }
    return { authenticated: true };
}
// ---------------------------------------------------------------------------
// 3. Rate limiting (in-memory sliding window)
// ---------------------------------------------------------------------------
const WINDOW_MS = 60000;
const MAX_REQUESTS = 60;
const hits = new Map();
function checkRateLimit(_action, ip) {
    var _a;
    const now = Date.now();
    const timestamps = ((_a = hits.get(ip)) !== null && _a !== void 0 ? _a : []).filter((t) => now - t < WINDOW_MS);
    if (timestamps.length >= MAX_REQUESTS) {
        const oldest = timestamps[0];
        return { allowed: false, retryAfterMs: WINDOW_MS - (now - oldest) };
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    return { allowed: true };
}
// ---------------------------------------------------------------------------
// 4. Kite health pre-check
// ---------------------------------------------------------------------------
async function checkKiteHealth(db) {
    var _a, _b, _c;
    const doc = await db.doc('config/kiteSession').get();
    if (!doc.exists) {
        return { healthy: false, reason: 'kiteSession doc missing' };
    }
    const data = doc.data();
    if (!data.accessToken) {
        return { healthy: false, reason: 'No access token stored' };
    }
    const expiresAt = (_c = (_b = (_a = data.expiresAt) === null || _a === void 0 ? void 0 : _a.toDate) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : data.expiresAt;
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
        return { healthy: false, reason: 'Kite token expired' };
    }
    return { healthy: true };
}
//# sourceMappingURL=middleware.js.map