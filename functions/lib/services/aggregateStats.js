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
exports.aggregateStatsTask = void 0;
exports.doAggregateStats = doAggregateStats;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Aggregate Stats: Computes strategy x regime performance metrics.
 */
async function doAggregateStats(dateId) {
    const db = getDb();
    console.log(`[AggregateStats] Aggregating performance for ${dateId}`);
    // Load all signals for the date that have monitor data
    const signalsSnap = await db.collection('signals')
        .doc(dateId)
        .collection('items')
        .get();
    const groups = {};
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        const key = `${signal.strategy}_${signal.reasons.marketState || 'UNKNOWN'}`;
        if (!groups[key])
            groups[key] = [];
        groups[key].push(signal);
    }
    for (const [key, signals] of Object.entries(groups)) {
        const [strategy, marketState] = key.split('_');
        const monitored = signals.filter(s => s.monitor && s.monitor.r5 !== undefined);
        if (monitored.length === 0)
            continue;
        const r5List = monitored.map(s => s.monitor.r5);
        const mfeList = monitored.map(s => s.monitor.mfeR || 0);
        const maeList = monitored.map(s => s.monitor.maeR || 0);
        const countSignals = signals.length;
        const avgR5 = r5List.reduce((a, b) => a + b, 0) / r5List.length;
        const medianR5 = r5List.sort((a, b) => a - b)[Math.floor(r5List.length / 2)];
        const avgMFE = mfeList.reduce((a, b) => a + b, 0) / mfeList.length;
        const avgMAE = maeList.reduce((a, b) => a + b, 0) / maeList.length;
        // Conservative Win Rate: R5 > 0
        const wins = r5List.filter(r => r > 0).length;
        const conservativeWinRate = (wins / r5List.length) * 100;
        // Expectancy: (WinRate * AvgWin) - (LossRate * AvgLoss)
        const avgWin = r5List.filter(r => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
        const avgLoss = Math.abs(r5List.filter(r => r <= 0).reduce((a, b) => a + b, 0) / (monitored.length - wins || 1));
        const expectancy = (conservativeWinRate / 100 * avgWin) - ((1 - conservativeWinRate / 100) * avgLoss);
        const stats = {
            countSignals,
            countMonitored: monitored.length,
            avgR5,
            medianR5,
            avgMFE,
            avgMAE,
            conservativeWinRate,
            expectancy,
            updatedAt: admin.firestore.Timestamp.now()
        };
        const path = `stats/strategies/${strategy}/regimes/${marketState}/days/${dateId}`;
        // Create nested structure if needed (Firestore does this automatically)
        await db.doc(path).set(stats);
        console.log(`[AggregateStats] Updated stats for ${strategy} in ${marketState}: Expectancy=${expectancy.toFixed(2)}`);
    }
}
exports.aggregateStatsTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId } = req.body;
    try {
        await doAggregateStats(dateId);
        res.status(200).send('Stats aggregated');
    }
    catch (error) {
        console.error('Stats aggregation failed:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=aggregateStats.js.map