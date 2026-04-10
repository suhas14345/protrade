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
exports.THRESHOLDS = exports.AlertType = void 0;
exports.raiseAlert = raiseAlert;
exports.checkSystematicBias = checkSystematicBias;
exports.checkReconciliationDrift = checkReconciliationDrift;
exports.getUnacknowledgedAlerts = getUnacknowledgedAlerts;
exports.acknowledgeAlert = acknowledgeAlert;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
// ── Alert types ──────────────────────────────────────────────────────
var AlertType;
(function (AlertType) {
    AlertType["DATA_STALE"] = "DATA_STALE";
    AlertType["JOB_FAILED"] = "JOB_FAILED";
    AlertType["DRAWDOWN_WARNING"] = "DRAWDOWN_WARNING";
    AlertType["DRAWDOWN_HALT"] = "DRAWDOWN_HALT";
    AlertType["KILL_SWITCH"] = "KILL_SWITCH";
    AlertType["SYSTEMATIC_BIAS"] = "SYSTEMATIC_BIAS";
    AlertType["CORPORATE_ACTION"] = "CORPORATE_ACTION";
    AlertType["EXECUTION_DRIFT"] = "EXECUTION_DRIFT";
    AlertType["RECONCILIATION_WARN"] = "RECONCILIATION_WARN";
    AlertType["RECONCILIATION_HALT"] = "RECONCILIATION_HALT";
    AlertType["SESSION_EXPIRED"] = "SESSION_EXPIRED";
})(AlertType || (exports.AlertType = AlertType = {}));
// ── Thresholds ───────────────────────────────────────────────────────
exports.THRESHOLDS = {
    RECONCILIATION_WARN_BPS: 30,
    RECONCILIATION_HALT_BPS: 50,
    DRAWDOWN_WARN_PCT: 10,
    DRAWDOWN_HALT_PCT: 20,
    SYSTEMATIC_BIAS_STREAK: 5,
};
// ── Core functions ───────────────────────────────────────────────────
/**
 * Write an alert to the `alerts` Firestore collection.
 * TODO: Add external notification channels (email, Telegram, etc.) here.
 */
async function raiseAlert(type, severity, message, metadata) {
    const db = getDb();
    const alert = {
        type,
        severity,
        message,
        metadata: metadata !== null && metadata !== void 0 ? metadata : {},
        timestamp: firestore_1.Timestamp.now(),
        acknowledged: false,
    };
    const ref = await db.collection('alerts').add(alert);
    console.log(`[Alert] ${severity} ${type}: ${message}`);
    return ref.id;
}
/**
 * Detect N consecutive same-direction execution biases.
 * Each trade should carry a numeric `biasDirection` (positive = over-fill, negative = under-fill).
 */
async function checkSystematicBias(recentTrades) {
    if (recentTrades.length < exports.THRESHOLDS.SYSTEMATIC_BIAS_STREAK)
        return false;
    const tail = recentTrades.slice(-exports.THRESHOLDS.SYSTEMATIC_BIAS_STREAK);
    const allPositive = tail.every((t) => t.biasDirection > 0);
    const allNegative = tail.every((t) => t.biasDirection < 0);
    if (allPositive || allNegative) {
        const direction = allPositive ? 'positive' : 'negative';
        await raiseAlert(AlertType.SYSTEMATIC_BIAS, 'WARN', `${exports.THRESHOLDS.SYSTEMATIC_BIAS_STREAK} consecutive ${direction} execution biases detected`, { streak: exports.THRESHOLDS.SYSTEMATIC_BIAS_STREAK, direction, trades: tail });
        return true;
    }
    return false;
}
/**
 * Compare expected vs actual P&L and raise reconciliation alerts
 * when drift exceeds warning / halt thresholds (in basis points).
 */
async function checkReconciliationDrift(expectedPnl, actualPnl) {
    const base = Math.abs(expectedPnl) || 1; // avoid division by zero
    const driftBps = (Math.abs(actualPnl - expectedPnl) / base) * 10000;
    if (driftBps >= exports.THRESHOLDS.RECONCILIATION_HALT_BPS) {
        const alertId = await raiseAlert(AlertType.RECONCILIATION_HALT, 'CRITICAL', `Reconciliation drift ${driftBps.toFixed(1)} bps exceeds halt threshold`, { expectedPnl, actualPnl, driftBps });
        return { driftBps, alertId };
    }
    if (driftBps >= exports.THRESHOLDS.RECONCILIATION_WARN_BPS) {
        const alertId = await raiseAlert(AlertType.RECONCILIATION_WARN, 'WARN', `Reconciliation drift ${driftBps.toFixed(1)} bps exceeds warning threshold`, { expectedPnl, actualPnl, driftBps });
        return { driftBps, alertId };
    }
    return { driftBps };
}
/** Return all unacknowledged alerts, newest first. */
async function getUnacknowledgedAlerts() {
    const db = getDb();
    const snap = await db
        .collection('alerts')
        .where('acknowledged', '==', false)
        .orderBy('timestamp', 'desc')
        .get();
    return snap.docs.map((doc) => (Object.assign({ id: doc.id }, doc.data())));
}
/** Mark an alert as acknowledged. */
async function acknowledgeAlert(alertId) {
    const db = getDb();
    await db.collection('alerts').doc(alertId).update({ acknowledged: true });
}
//# sourceMappingURL=alerting.js.map