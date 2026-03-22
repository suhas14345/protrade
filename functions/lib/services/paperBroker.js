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
exports.simulateFillsTask = exports.placeOrdersTask = void 0;
exports.doPlaceOrders = doPlaceOrders;
exports.doOpenFillSimulation = doOpenFillSimulation;
exports.doSimulateFills = doSimulateFills;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const safety_1 = require("./safety");
const firestore_1 = require("firebase-admin/firestore");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Paper Broker: Places orders for APPROVED signals.
 */
async function doPlaceOrders(dateId, jobId) {
    var _a, _b, _c;
    const db = getDb();
    console.log(`[PaperBroker] Placing orders for ${dateId}`);
    (0, safety_1.checkSafety)();
    const signalsSnap = await db.collection('signals')
        .doc(dateId)
        .collection('items')
        .where('riskApproval.status', '==', 'APPROVED')
        .get();
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        const signalId = doc.id;
        if ((_a = signal.execution) === null || _a === void 0 ? void 0 : _a.status)
            continue;
        const orderId = signalId;
        const order = {
            symbol: signal.symbol,
            side: signal.direction,
            orderType: 'NEXT_OPEN',
            intendedQty: ((_b = signal.riskApproval) === null || _b === void 0 ? void 0 : _b.sizedQty) || 0,
            intendedEntryRef: 'OPEN',
            createdFromSignalId: signalId,
            risk: {
                plannedR: 1.0,
                riskAmount: ((_c = signal.riskApproval) === null || _c === void 0 ? void 0 : _c.riskAmount) || 0,
                stopDistance: Math.abs((signal.reasons.close || 0) - signal.indicativeStopPrice)
            },
            status: 'ACCEPTED'
        };
        await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
        await db.collection('signals').doc(dateId).collection('items').doc(signalId).update({
            status: 'ORDERED',
            execution: {
                status: 'ORDERED',
                orderId
            }
        });
        console.log(`[PaperBroker] Order placed for ${signal.symbol}: ${orderId} (${signal.direction})`);
    }
    if (jobId) {
        await db.collection('jobs').doc(jobId).update({
            stage: 'ORDERS',
            updatedAt: admin.firestore.Timestamp.now()
        });
    }
}
/**
 * Open Fill Simulation for Orchestrator loop (One symbol at a time)
 */
async function doOpenFillSimulation(jobId, runDate, symbol) {
    const db = getDb();
    console.log(`[Job ${jobId}] Simulating open fills for ${symbol} on ${runDate}`);
    const dateId = runDate.replace(/-/g, '');
    const prevDate = new Date(runDate);
    prevDate.setDate(prevDate.getDate() - 1);
    const prevDateId = prevDate.toISOString().split('T')[0].replace(/-/g, '');
    const ordersSnap = await db.collection('paperOrders')
        .doc(prevDateId)
        .collection('items')
        .where('symbol', '==', symbol)
        .where('status', '==', 'ACCEPTED')
        .get();
    const batch = db.batch();
    for (const doc of ordersSnap.docs) {
        const order = doc.data();
        const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
        if (!barSnap.exists)
            continue;
        const bar = barSnap.data();
        const sigSnap = await db.collection('signals').doc(prevDateId).collection('items').doc(order.createdFromSignalId).get();
        if (!sigSnap.exists)
            continue;
        const signal = sigSnap.data();
        const fillPrice = order.side === 'BUY' ? bar.open * 1.0005 : bar.open * 0.9995;
        const fillId = `fill_${doc.id}`;
        // Gap 4: Definitive price anchoring at fill (V1.1 precision)
        const atrRef = signal.atrRef || signal.reasons.atr14 || 0;
        const stopMult = signal.stopAtrMult || 2.0;
        const targetMult = signal.targetAtrMult || 3.0;
        const finalStop = order.side === 'BUY'
            ? fillPrice - (atrRef * stopMult)
            : fillPrice + (atrRef * stopMult);
        const finalTarget = order.side === 'BUY'
            ? fillPrice + (atrRef * targetMult)
            : fillPrice - (atrRef * targetMult);
        const fill = {
            orderId: doc.id,
            symbol,
            fillPrice,
            fillQty: order.intendedQty,
            slippageBps: 5,
            feeEstimate: 20,
            fillType: 'ENTRY',
            timestamp: firestore_1.Timestamp.now()
        };
        const position = {
            symbol,
            avgEntryPrice: fillPrice,
            qty: order.intendedQty,
            stopPrice: finalStop,
            targets: [finalTarget],
            status: 'OPEN',
            unrealizedPnl: 0,
            realizedPnl: 0,
            openedAt: firestore_1.Timestamp.now(),
            lastUpdatedAt: firestore_1.Timestamp.now(),
            entryFillId: fillId,
            // V1.1 Fields
            atrAtEntry: atrRef,
            partialTaken: false,
            mfeAtr: 0,
            entryDateId: dateId
        };
        batch.set(db.collection('paperFills').doc(dateId).collection('items').doc(fillId), fill);
        batch.set(db.collection('portfolio').doc('default').collection('positions').doc(symbol), position);
        batch.update(doc.ref, { status: 'FILLED' });
        batch.update(sigSnap.ref, {
            status: 'IN_TRADE',
            stopPrice: finalStop, // Final anchored value
            targets: [finalTarget], // Final anchored value
            rr: targetMult / stopMult, // Final R:R
            execution: {
                status: 'FILLED',
                orderId: doc.id,
                fillId,
                entryPrice: fillPrice,
                entryDateId: dateId
            }
        });
        console.log(`[PaperBroker] ${symbol} ${order.side} FILLED at ${fillPrice.toFixed(2)}. Stop: ${finalStop.toFixed(2)}, Target: ${finalTarget.toFixed(2)}`);
    }
    await batch.commit();
}
/**
 * Legacy Fill Simulation (Fallback)
 */
async function doSimulateFills(dateId, nextDateId) {
    const db = getDb();
    const ordersSnap = await db.collection('paperOrders').doc(dateId).collection('items').where('status', '==', 'ACCEPTED').get();
    for (const doc of ordersSnap.docs) {
        const order = doc.data();
        await doOpenFillSimulation('manual', nextDateId, order.symbol);
    }
}
exports.placeOrdersTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId, jobId } = req.body;
    try {
        await doPlaceOrders(dateId, jobId);
        res.status(200).send('Orders placed');
    }
    catch (error) {
        console.error('Order placement failed:', error);
        res.status(500).send('Internal Error');
    }
});
exports.simulateFillsTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId, nextDateId } = req.body;
    try {
        await doSimulateFills(dateId, nextDateId);
        res.status(200).send('Fills simulated');
    }
    catch (error) {
        console.error('Fill simulation failed:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=paperBroker.js.map