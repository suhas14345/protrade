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
exports.manageTradesTask = void 0;
exports.doManageTrades = doManageTrades;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("../config/runtime");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Trade Manager: Manages open trades daily with V1.1 Prioritized Exits.
 *
 * Enforces Priority: 1. HARD STOP -> 2. TIME STOP -> 3. PARTIAL PROFIT -> 4. TARGET
 */
async function doManageTrades(dateId) {
    var _a, _b, _c, _d, _e;
    const db = getDb();
    console.log(`[TradeManager] Managing open trades for ${dateId} (V1.1 Priority)`);
    const signalsSnap = await db.collectionGroup('items')
        .where('status', '==', 'IN_TRADE')
        .get();
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        const signalId = doc.id;
        const symbol = signal.symbol;
        // V1.1: Use ATR at entry for MFE tracking (consistent with Gap 4 anchoring)
        const atrAtEntry = Number(signal.atrRef || ((_a = signal.features) === null || _a === void 0 ? void 0 : _a.atr14) || 0);
        const entryPrice = ((_b = signal.execution) === null || _b === void 0 ? void 0 : _b.entryPrice) || 0;
        const entryDateId = ((_c = signal.execution) === null || _c === void 0 ? void 0 : _c.entryDateId) || '';
        // Load existing position state for definitive stop/target (Gap 4)
        const posDoc = await db.collection('portfolio').doc('default').collection('positions').doc(symbol).get();
        if (!posDoc.exists)
            continue;
        const position = posDoc.data();
        const stopPrice = position.stopPrice;
        const target = position.targets[0];
        if (!atrAtEntry || !entryPrice || !stopPrice || !target)
            continue;
        // Load bars since entry to track duration and MFE
        const barsSnap = await db.collection('barsD')
            .doc(symbol)
            .collection('days')
            .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
            .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
            .get();
        const bars = barsSnap.docs.map(d => (Object.assign({ id: d.id }, d.data()))).sort((a, b) => a.id.localeCompare(b.id));
        if (bars.length === 0)
            continue;
        const currentBar = bars[bars.length - 1];
        const highSeen = Math.max(...bars.map(b => b.high));
        const lowSeen = Math.min(...bars.map(b => b.low));
        // Update MFE in ATR units (V1.1 requirement)
        const mfeAtr = signal.direction === 'BUY'
            ? (highSeen - entryPrice) / atrAtEntry
            : (entryPrice - lowSeen) / atrAtEntry;
        let exitPrice = null;
        let exitType = null;
        let exitQty = position.qty || ((_d = signal.riskApproval) === null || _d === void 0 ? void 0 : _d.sizedQty) || 0;
        // EXIT PRIORITY: 1) HARD_STOP -> 2) TIME_STOP -> 3) PARTIAL -> 4) TARGET (Gap 6)
        // 1. Hard Stop
        const isStopHit = signal.direction === 'BUY' ? currentBar.low <= stopPrice : currentBar.high >= stopPrice;
        if (isStopHit) {
            exitPrice = stopPrice;
            exitType = 'EXIT_STOP';
        }
        // 2. Time Stop (after 5 trading days if mfeAtr < 1.0)
        else if (bars.length >= runtime_1.STRATEGY_V11.TIME_STOP_DAYS && mfeAtr < runtime_1.STRATEGY_V11.TIME_STOP_PROGRESS_ATR) {
            exitPrice = currentBar.close;
            exitType = 'EXIT_TIME';
        }
        // 3. Partial Profit (+1.5 ATR take 33% and move stop to breakeven)
        else if (runtime_1.STRATEGY_V11.PARTIAL_PROFIT_ENABLED && !position.partialTaken && mfeAtr >= runtime_1.STRATEGY_V11.PARTIAL_PROFIT_ATR) {
            exitPrice = currentBar.close;
            exitType = 'PARTIAL_PROFIT';
            exitQty = Math.floor(exitQty * runtime_1.STRATEGY_V11.PARTIAL_PROFIT_FRACTION);
        }
        // 4. Profit Target
        else {
            const isTargetHit = signal.direction === 'BUY' ? currentBar.high >= target : currentBar.low <= target;
            if (isTargetHit) {
                exitPrice = target;
                exitType = 'EXIT_TARGET';
            }
        }
        if (exitPrice !== null && exitType !== null) {
            console.log(`[TradeManager] v1.1 Event for ${symbol}: ${exitType} at ${exitPrice.toFixed(2)} (MFE_ATR: ${mfeAtr.toFixed(2)})`);
            if (exitType === 'PARTIAL_PROFIT') {
                const remainingQty = position.qty - exitQty;
                // Handle Partial (Gap 6): Move stop to breakeven and stay in trade
                await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
                    partialTaken: true,
                    stopPrice: entryPrice, // Move to breakeven
                    qty: remainingQty,
                    lastUpdatedAt: admin.firestore.Timestamp.now()
                });
                // We also need to update the signal's final stopPrice so subsequent days use the new stop
                await doc.ref.update({ stopPrice: entryPrice });
                const fillId = `partial_${signalId}_${dateId}`;
                await db.collection('paperFills').doc(dateId).collection('items').doc(fillId).set({
                    symbol, fillPrice: exitPrice, fillQty: exitQty, fillType: 'PARTIAL_PROFIT', timestamp: admin.firestore.Timestamp.now()
                });
            }
            else {
                // Full Exit
                const exitFillId = `exit_${signalId}_${dateId}`;
                const exitFill = {
                    orderId: ((_e = signal.execution) === null || _e === void 0 ? void 0 : _e.orderId) || 'MANUAL',
                    symbol,
                    fillPrice: exitPrice,
                    fillQty: position.qty,
                    slippageBps: 5,
                    feeEstimate: 0,
                    fillType: exitType,
                    timestamp: admin.firestore.Timestamp.now()
                };
                await db.collection('paperFills').doc(dateId).collection('items').doc(exitFillId).set(exitFill);
                await doc.ref.update({ status: 'DONE' });
                await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
                    status: 'CLOSED',
                    exitReason: exitType,
                    closedAt: admin.firestore.Timestamp.now()
                });
            }
        }
        else {
            // Just update MFE/MAE for monitoring
            await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
                lastUpdatedAt: admin.firestore.Timestamp.now(),
                mfeAtr,
                barsActive: bars.length
            });
        }
    }
}
exports.manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId } = req.body;
    if (!dateId) {
        res.status(400).send('Missing dateId');
        return;
    }
    try {
        await doManageTrades(dateId);
        res.status(200).send('Trades managed');
    }
    catch (error) {
        console.error('Trade management failed:', error);
        res.status(500).send(error instanceof Error ? error.message : 'Internal Error');
    }
});
//# sourceMappingURL=tradeManager.js.map