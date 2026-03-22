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
exports.evaluateOutcomesTask = void 0;
exports.doEvaluateOutcomes = doEvaluateOutcomes;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Outcome Evaluator: Tracks forward performance of signals over a 5-day window.
 */
async function doEvaluateOutcomes(dateId) {
    var _a, _b, _c;
    const db = getDb();
    console.log(`[OutcomeEvaluator] Evaluating returns for signals on ${dateId}`);
    // Find signals that were FILLED or more and are missing monitor data
    // Note: we might run this multiple times as days pass to fill in R3, R5
    const signalsSnap = await db.collection('signals')
        .doc(dateId)
        .collection('items')
        .where('status', 'in', ['IN_TRADE', 'DONE'])
        .get();
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        const signalId = doc.id;
        if (!((_a = signal.execution) === null || _a === void 0 ? void 0 : _a.entryPrice) || !((_b = signal.execution) === null || _b === void 0 ? void 0 : _b.entryDateId))
            continue;
        const entryPrice = signal.execution.entryPrice;
        const entryDateId = signal.execution.entryDateId;
        const stopPrice = signal.stopPrice;
        const riskPerShare = Math.abs(entryPrice - stopPrice);
        if (riskPerShare === 0)
            continue;
        // Load next 10 bars from entry date to find R1, R3, R5
        const barsSnap = await db.collection('barsD')
            .doc(signal.symbol)
            .collection('days')
            .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
            .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
            .limit(10)
            .get();
        const forwardBars = barsSnap.docs.map(d => d.data());
        if (forwardBars.length < 2)
            continue; // Need at least one bar after entry
        const monitor = signal.monitor || {};
        // R-multiples (normalized returns)
        const getR = (price) => (price - entryPrice) / riskPerShare * (signal.direction === 'BUY' ? 1 : -1);
        if (forwardBars[1])
            monitor.r1 = getR(forwardBars[1].close);
        if (forwardBars[3])
            monitor.r3 = getR(forwardBars[3].close);
        if (forwardBars[5])
            monitor.r5 = getR(forwardBars[5].close);
        // MFE/MAE over the first 5 days
        const window = forwardBars.slice(0, 6);
        const highs = window.map(b => b.high);
        const lows = window.map(b => b.low);
        if (signal.direction === 'BUY') {
            monitor.mfeR = (Math.max(...highs) - entryPrice) / riskPerShare;
            monitor.maeR = (entryPrice - Math.min(...lows)) / riskPerShare;
            monitor.hitStop = Math.min(...lows) <= stopPrice;
            monitor.hitTarget = Math.max(...highs) >= (signal.targets[0] || 0);
        }
        else {
            monitor.mfeR = (entryPrice - Math.min(...lows)) / riskPerShare;
            monitor.maeR = (Math.max(...highs) - entryPrice) / riskPerShare;
            monitor.hitStop = Math.max(...highs) >= stopPrice;
            monitor.hitTarget = Math.min(...lows) <= (signal.targets[0] || 0);
        }
        await db.collection('signals').doc(dateId).collection('items').doc(signalId).update({ monitor });
        console.log(`[OutcomeEvaluator] Updated monitor for ${signal.symbol}: R5=${(_c = monitor.r5) === null || _c === void 0 ? void 0 : _c.toFixed(2)}`);
    }
}
exports.evaluateOutcomesTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId } = req.body;
    try {
        await doEvaluateOutcomes(dateId);
        res.status(200).send('Outcomes evaluated');
    }
    catch (error) {
        console.error('Outcome evaluation failed:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=outcomeEvaluator.js.map