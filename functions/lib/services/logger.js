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
exports.logger = void 0;
exports.log = log;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Production Logging Service
 * Captures runtime issues and logs them to Firestore for persistence and dashboard viewing.
 */
async function log(level, message, context, metadata) {
    // Backtest fast-path: the replay engine emits tens of thousands of log lines,
    // and each Firestore log write is an emulator round-trip that dominates runtime.
    // When BACKTEST_SILENCE=1 (only ever set by the backtest runner, never in
    // production), skip all log persistence; still surface ERRORs to the console.
    if (process.env.BACKTEST_SILENCE === '1') {
        if (level === 'ERROR')
            console.error(`[${context || 'SYSTEM'}] ${message}`, metadata !== null && metadata !== void 0 ? metadata : '');
        return;
    }
    const db = getDb();
    // Use metadata.dateId for partition if provided (Backfill support)
    // Otherwise default to current UTC date. Sanitize to YYYYMMDD.
    const rawDateId = (metadata === null || metadata === void 0 ? void 0 : metadata.partitionDateId) || (metadata === null || metadata === void 0 ? void 0 : metadata.dateId) || new Date().toISOString().split('T')[0];
    const dateId = rawDateId.replace(/-/g, '');
    const entry = {
        level,
        message,
        context,
        metadata,
        timestamp: firestore_1.Timestamp.now()
    };
    try {
        // Write to a persistent logs collection
        await db.collection('logs').doc(dateId).collection('entries').add(entry);
        // Also log to standard Firebase logger for Google Cloud Logs Explorer
        if (level === 'ERROR') {
            console.error(`[${context || 'SYSTEM'}] ${message}`, metadata);
            await db.collection('system_errors').add(Object.assign(Object.assign({}, entry), { createdAt: firestore_1.Timestamp.now() }));
            appendToFileLog('ERROR', message, context, metadata);
        }
        else if (level === 'WARN') {
            console.warn(`[${context || 'SYSTEM'}] ${message}`, metadata);
            appendToFileLog('WARN', message, context, metadata);
        }
        else {
            console.log(`[${context || 'SYSTEM'}] ${message}`, metadata);
        }
    }
    catch (err) {
        // Fallback if Firestore fails
        console.error('CRITICAL: Logging service failed', err);
    }
}
function appendToFileLog(level, message, context, metadata) {
    try {
        const logDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        const logFile = path.join(logDir, 'runtime_errors.log');
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] [${level}] [${context || 'SYSTEM'}] ${message} ${metadata ? JSON.stringify(metadata) : ''}\n`;
        fs.appendFileSync(logFile, logLine);
    }
    catch (err) {
        console.error('Failed to write to local log file:', err);
    }
}
exports.logger = {
    info: (msg, ctx, meta) => log('INFO', msg, ctx, meta),
    warn: (msg, ctx, meta) => log('WARN', msg, ctx, meta),
    error: (msg, ctx, meta) => log('ERROR', msg, ctx, meta),
    debug: (msg, ctx, meta) => log('DEBUG', msg, ctx, meta)
};
//# sourceMappingURL=logger.js.map