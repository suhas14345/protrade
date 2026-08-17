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
exports.runResetTradingState = runResetTradingState;
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
// Trade/run state cleared on reset. Price history (barsD/barsW), settings,
// universes, calendar, and event data are intentionally preserved.
const RESET_COLLECTIONS = [
    'jobs', 'logs', 'signals', 'paperOrders', 'paperFills',
    'regime', 'rsRanking', 'corrTopN', 'features',
    'aggregateStats', 'stats', 'accountLedger', 'alerts',
    'idempotency', 'journals',
];
async function runResetTradingState(opts) {
    if (!Number.isFinite(opts.equity) || opts.equity <= 0) {
        throw new Error('equity must be a positive number');
    }
    const db = getDb();
    const cleared = [];
    for (const name of RESET_COLLECTIONS) {
        await db.recursiveDelete(db.collection(name));
        cleared.push(name);
    }
    // Positions live under portfolio/default/positions.
    await db.recursiveDelete(db.collection('portfolio'));
    cleared.push('portfolio');
    // Reset the account: fresh equity, drawdown-tracking fields cleared.
    await db.collection('config').doc('account').set({
        equity: opts.equity,
        peakEquity: opts.equity,
        initialEquity: opts.equity, // immutable anchor — equity is derived off THIS, never peakEquity
        baseRiskPct: 0.005,
        maxOpenRiskR: 6,
        maxPositions: 10,
        strategyRiskWeights: {
            PullbackEOD: 1.0,
            BreakoutCloseEOD: 1.2,
            MeanReversionEOD: 0.8,
            ShortBounceEOD: 0.8,
            BearBounceEOD: 0.8,
            RSLeaderEOD: 1.0,
        },
        realizedPnl: 0,
        equityEMA25: admin.firestore.FieldValue.delete(),
        portfolioRealizedVol: admin.firestore.FieldValue.delete(),
        lastRealizedPnl: admin.firestore.FieldValue.delete(),
        lastRealizedSymbol: admin.firestore.FieldValue.delete(),
        lastRealizedAt: admin.firestore.FieldValue.delete(),
        resetAt: admin.firestore.Timestamp.now(),
    }, { merge: true });
    return { cleared, equity: opts.equity };
}
//# sourceMappingURL=resetState.js.map