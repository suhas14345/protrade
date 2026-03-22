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
const safety_1 = require("./safety");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Trade Manager: Manages open trades daily.
 */
async function doManageTrades(dateId) {
    var _a, _b, _c, _d, _e, _f;
    const db = getDb();
    console.log(`[TradeManager] Managing open trades for ${dateId}`);
    (0, safety_1.checkSafety)();
    const signalsSnap = await db.collectionGroup('items')
        .where('status', '==', 'IN_TRADE')
        .get();
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        const signalId = doc.id;
        const symbol = signal.symbol;
        const entryPrice = ((_a = signal.execution) === null || _a === void 0 ? void 0 : _a.entryPrice) || 0;
        const entryDateId = ((_b = signal.execution) === null || _b === void 0 ? void 0 : _b.entryDateId) || '';
        const stopPrice = signal.stopPrice;
        const target = signal.targets[0];
        const riskPerShare = Math.abs(entryPrice - stopPrice);
        if (riskPerShare === 0)
            continue;
        // Load bars since entry
        const barsSnap = await db.collection('barsD')
            .doc(symbol)
            .collection('days')
            .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
            .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
            .get();
        const bars = barsSnap.docs.map(d => d.data()).sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
        if (bars.length === 0)
            continue;
        const currentBar = bars[bars.length - 1];
        const highSeen = Math.max(...bars.map(b => b.high));
        const lowSeen = Math.min(...bars.map(b => b.low));
        // MFE / MAE in R units
        const mfeR = (highSeen - entryPrice) / riskPerShare;
        const maeR = (entryPrice - lowSeen) / riskPerShare;
        let exitPrice = null;
        let exitType = null;
        // 1. Hard Stop
        if (currentBar.low <= stopPrice) {
            exitPrice = Math.min(currentBar.open, stopPrice); // Gap through stop handled
            exitType = 'EXIT_STOP';
        }
        // 2. Fixed Target
        else if (currentBar.high >= target) {
            exitPrice = target;
            exitType = 'EXIT_TARGET';
        }
        // 3. Break-even logic (MFE >= 1R)
        else if (mfeR >= 1.0 && currentBar.close <= entryPrice) {
            exitPrice = currentBar.close;
            exitType = 'EXIT_THESIS'; // Breakeven
        }
        // 4. Time exit (after 5 bars, low MFE)
        else if (bars.length >= 5 && mfeR < 0.5) {
            exitPrice = currentBar.close;
            exitType = 'EXIT_TIME';
        }
        // 5. Trailing Stop (MFE >= 2R -> entry + 0.5R)
        else if (mfeR >= 2.0 && currentBar.close <= (entryPrice + 0.5 * riskPerShare)) {
            exitPrice = currentBar.close;
            exitType = 'EXIT_THESIS'; // Trailed exit
        }
        if (exitPrice !== null && exitType !== null) {
            console.log(`[TradeManager] Exiting ${symbol} at ${exitPrice.toFixed(2)} (${exitType})`);
            const exitFillId = `exit_${signalId}_${dateId}`;
            const exitFill = {
                orderId: ((_c = signal.execution) === null || _c === void 0 ? void 0 : _c.orderId) || '',
                symbol,
                fillPrice: exitPrice,
                fillQty: ((_d = signal.riskApproval) === null || _d === void 0 ? void 0 : _d.sizedQty) || 0,
                slippageBps: 5,
                feeEstimate: 0,
                fillType: exitType,
                timestamp: admin.firestore.Timestamp.now()
            };
            await db.collection('paperFills').doc(dateId).collection('items').doc(exitFillId).set(exitFill);
            const tradeId = `trade_${signalId}`;
            const trade = {
                symbol,
                direction: signal.direction,
                entryPrice,
                entryDateId,
                exitPrice,
                exitDateId: dateId,
                qty: ((_e = signal.riskApproval) === null || _e === void 0 ? void 0 : _e.sizedQty) || 0,
                pnl: (exitPrice - entryPrice) * (((_f = signal.riskApproval) === null || _f === void 0 ? void 0 : _f.sizedQty) || 0),
                rMultiple: (exitPrice - entryPrice) / riskPerShare,
                status: 'CLOSED',
                exitReason: exitType,
                mfeR,
                maeR
            };
            await db.collection('trades').doc('default').collection('items').doc(tradeId).set(trade);
            await doc.ref.update({ status: 'DONE' });
            await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({ status: 'CLOSED' });
        }
        else {
            // Update Position MFE/MAE
            await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
                lastUpdatedAt: admin.firestore.Timestamp.now(),
                mfeR,
                maeR
            });
        }
    }
}
exports.manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId } = req.body;
    try {
        await doManageTrades(dateId);
        res.status(200).send('Trades managed');
    }
    catch (error) {
        console.error('Trade management failed:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=tradeManager.js.map