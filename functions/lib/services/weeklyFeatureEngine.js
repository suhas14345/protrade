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
exports.computeWeeklyTask = void 0;
exports.doComputeWeeklyFeatures = doComputeWeeklyFeatures;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Weekly Feature Engine: Computes weekly bars and indicators from daily data.
 */
async function doComputeWeeklyFeatures(symbol, dateId) {
    const db = getDb();
    console.log(`[WeeklyEngine] Computing weekly for ${symbol} @ ${dateId}`);
    // 1. Determine the week ID (YYYYWW)
    // Simple ISO week calculation
    const date = new Date(dateId.slice(0, 4) + '-' + dateId.slice(4, 6) + '-' + dateId.slice(6, 8));
    const weekId = getISOWeekId(date);
    // 2. Load the last 30 daily bars to aggregate the current week
    // We need all bars for the week containing dateId
    const barsSnap = await db.collection('barsD')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
        .limit(30)
        .get();
    const dailyBars = barsSnap.docs.map(d => (Object.assign({ id: d.id }, d.data()))).reverse();
    // Group by week and find the current one
    const currentWeekBars = dailyBars.filter(b => {
        const d = new Date(b.id.slice(0, 4) + '-' + b.id.slice(4, 6) + '-' + b.id.slice(6, 8));
        return getISOWeekId(d) === weekId;
    });
    if (currentWeekBars.length === 0)
        return;
    const weeklyBar = {
        open: currentWeekBars[0].open,
        high: Math.max(...currentWeekBars.map(b => b.high)),
        low: Math.min(...currentWeekBars.map(b => b.low)),
        close: currentWeekBars[currentWeekBars.length - 1].close,
        volume: currentWeekBars.reduce((sum, b) => sum + b.volume, 0),
        timestamp: admin.firestore.Timestamp.now()
    };
    await db.collection('barsW').doc(symbol).collection('weeks').doc(weekId).set(weeklyBar);
    // 3. Compute Weekly EMA (requires historical weekly bars)
    const historySnap = await db.collection('barsW')
        .doc(symbol)
        .collection('weeks')
        .where(admin.firestore.FieldPath.documentId(), '<=', weekId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
        .limit(100)
        .get();
    const history = historySnap.docs.map(d => d.data()).reverse();
    const ema20 = computeEMA(history.map(b => b.close), 20);
    const ema50 = computeEMA(history.map(b => b.close), 50);
    const weeklyFeatures = {
        ema20,
        ema50,
        computedAt: admin.firestore.Timestamp.now()
    };
    await db.collection('features').doc(symbol).collection('weeks').doc(weekId).set(weeklyFeatures);
    console.log(`[WeeklyEngine] ${symbol} Week ${weekId}: EMA20=${ema20 === null || ema20 === void 0 ? void 0 : ema20.toFixed(2)}, EMA50=${ema50 === null || ema50 === void 0 ? void 0 : ema50.toFixed(2)}`);
}
function getISOWeekId(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}${weekNo.toString().padStart(2, '0')}`;
}
// Simple EMA helper (re-using or adding here)
function computeEMA(data, period) {
    if (data.length < period)
        return undefined;
    let ema = data.slice(0, period).reduce((a, b) => a + b) / period;
    const K = 2 / (period + 1);
    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * K + ema;
    }
    return ema;
}
exports.computeWeeklyTask = functionsV1.https.onRequest(async (req, res) => {
    const { symbol, dateId } = req.body;
    try {
        await doComputeWeeklyFeatures(symbol, dateId);
        res.status(200).send('Weekly processed');
    }
    catch (error) {
        console.error('Weekly processing failed:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=weeklyFeatureEngine.js.map