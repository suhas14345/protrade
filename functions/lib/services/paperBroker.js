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
exports.doPlaceOrders = doPlaceOrders;
exports.doOpenFillSimulation = doOpenFillSimulation;
const admin = __importStar(require("firebase-admin"));
const safety_1 = require("./safety");
const runtime_1 = require("../config/runtime");
const firestore_1 = require("firebase-admin/firestore");
const calendar_1 = require("./calendar");
const portfolioEquity_1 = require("./portfolioEquity");
const barCache_1 = require("./barCache");
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * V2.4: Dynamic slippage model — f(liquidityBucket, regimeState, orderSize, medVol20).
 * Includes order-size impact: larger orders as % of ADV get proportionally worse fills.
 * Returns slippage in basis points.
 */
function computeSlippageBps(liquidityBucket, regimeState, orderQty, medVol20) {
    var _a, _b;
    const bucket = liquidityBucket !== null && liquidityBucket !== void 0 ? liquidityBucket : 'A';
    const bucketConfig = (_a = runtime_1.SLIPPAGE_CONFIG.BUCKETS[bucket]) !== null && _a !== void 0 ? _a : runtime_1.SLIPPAGE_CONFIG.BUCKETS['A'];
    const regimeMult = (_b = runtime_1.SLIPPAGE_CONFIG.REGIME_MULT[regimeState !== null && regimeState !== void 0 ? regimeState : 'TREND']) !== null && _b !== void 0 ? _b : 1.0;
    // Base slippage from bucket range
    const rawBps = bucketConfig.minBps + Math.random() * (bucketConfig.maxBps - bucketConfig.minBps);
    // V2.4: Order-size impact — participation rate scaling
    // If order is >1% of daily volume, slippage increases non-linearly
    let sizeImpactMult = 1.0;
    if (orderQty && medVol20 && medVol20 > 0) {
        const participationRate = orderQty / medVol20;
        if (participationRate > 0.01) {
            // Square-root market impact model: impact ∝ sqrt(participation rate)
            // At 2% participation: ~1.4x slippage; at 5%: ~2.2x; at 10%: ~3.2x
            sizeImpactMult = 1.0 + Math.sqrt(participationRate / 0.01) - 1.0;
        }
    }
    return Math.round(rawBps * regimeMult * sizeImpactMult);
}
/**
 * V3.0: Full Indian equity fee breakdown.
 * STT (sell), stamp duty, exchange txn, SEBI turnover, GST, brokerage.
 */
function computeFeeEstimate(fillPrice, fillQty, side) {
    const tradeValue = fillPrice * fillQty;
    const brokerage = Math.min(runtime_1.INDIAN_FEE_CONFIG.BROKERAGE_FLAT_INR, tradeValue * runtime_1.INDIAN_FEE_CONFIG.BROKERAGE_PCT / 100);
    const exchangeTxn = tradeValue * runtime_1.INDIAN_FEE_CONFIG.EXCHANGE_TXN_PCT / 100;
    const sebiTurnover = tradeValue * runtime_1.INDIAN_FEE_CONFIG.SEBI_TURNOVER_PCT / 100;
    const stampDuty = side === 'BUY' ? tradeValue * runtime_1.INDIAN_FEE_CONFIG.STAMP_DUTY_PCT / 100 : 0; // Stamp duty only on buy
    const stt = side === 'SELL' ? tradeValue * runtime_1.INDIAN_FEE_CONFIG.STT_SELL_PCT / 100 : 0; // STT on sell (delivery)
    const gst = (brokerage + exchangeTxn + sebiTurnover) * runtime_1.INDIAN_FEE_CONFIG.GST_PCT / 100;
    return Math.round((brokerage + exchangeTxn + sebiTurnover + stampDuty + stt + gst) * 100) / 100;
}
/**
 * Paper Broker: Places orders for APPROVED signals.
 */
async function doPlaceOrders(dateId, jobId) {
    var _a, _b, _c, _d;
    const db = getDb();
    await logger_1.logger.info(`[PaperBroker] Placing orders for ${dateId}`, 'PaperBroker', { dateId, jobId });
    (0, safety_1.checkSafety)();
    if (!dateId) {
        console.error('[PaperBroker] Missing dateId for order placement');
        return;
    }
    const signalsSnap = await db.collection('signals').doc(dateId).collection('items')
        .where('status', '==', 'APPROVED').get();
    // SEPA: only the strongest leaders get orders. Rank the day's approved signals by
    // 126-day momentum rank and keep just enough to fill the remaining position slots
    // (MAX_POS minus currently-open positions). The rest are left APPROVED-but-unfilled.
    let allowedIds = null;
    if (runtime_1.SEPA_CONFIG.SEPA_ONLY) {
        const openSnap = await db.collection('portfolio').doc('default').collection('positions')
            .where('status', '==', 'OPEN').get();
        const slots = Math.max(0, runtime_1.SEPA_CONFIG.MAX_POS - openSnap.size);
        const ranked = signalsSnap.docs
            .filter(d => { var _a; return !((_a = d.data().execution) === null || _a === void 0 ? void 0 : _a.status); })
            .map(d => { var _a, _b; return ({ id: d.id, rank: Number((_b = (_a = d.data().features) === null || _a === void 0 ? void 0 : _a.rsRank126) !== null && _b !== void 0 ? _b : Number.MAX_SAFE_INTEGER) }); })
            .sort((a, b) => a.rank - b.rank)
            .slice(0, slots)
            .map(x => x.id);
        allowedIds = new Set(ranked);
    }
    for (const doc of signalsSnap.docs) {
        const signal = doc.data();
        if ((_a = signal.execution) === null || _a === void 0 ? void 0 : _a.status)
            continue;
        if (allowedIds && !allowedIds.has(doc.id))
            continue;
        const atrRef = signal.atrRef || ((_b = signal.features) === null || _b === void 0 ? void 0 : _b.atr14) || 0;
        const stopMult = signal.stopAtrMult || 2.0;
        const orderId = doc.id;
        const order = {
            symbol: signal.symbol,
            side: signal.direction,
            orderType: 'ENTRY',
            intendedQty: ((_c = signal.riskApproval) === null || _c === void 0 ? void 0 : _c.sizedQty) || 0,
            intendedEntryRef: 'OPEN',
            createdFromSignalId: doc.id,
            risk: { plannedR: 1.0, riskAmount: ((_d = signal.riskApproval) === null || _d === void 0 ? void 0 : _d.riskAmount) || 0, stopDistance: atrRef * stopMult },
            status: 'ACCEPTED'
        };
        await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
        await doc.ref.update({ status: 'ORDERED', execution: { status: 'ORDERED', orderId } });
        await logger_1.logger.info(`[PaperBroker] ENTRY Order: ${orderId} (${signal.direction})`, 'PaperBroker', { symbol: signal.symbol, orderId, jobId });
    }
    if (jobId)
        await db.collection('jobs').doc(jobId).update({ stage: 'ORDERS', updatedAt: admin.firestore.Timestamp.now() });
}
/**
 * Morning Fill Simulation (NEXT_OPEN for both Entry and Exit)
 */
async function doOpenFillSimulation(jobId, runDate, symbol) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const db = getDb();
    const dateId = runDate.replace(/-/g, '');
    const prevDateId = await calendar_1.CalendarService.getPrevTradingDateId(dateId);
    if (!prevDateId)
        return;
    if (!dateId || !prevDateId) {
        console.warn(`[PaperBroker] Skipping fill simulation: missing dateId(${dateId}) or prevDateId(${prevDateId})`);
        return;
    }
    const ordersSnap = await db.collection('paperOrders').doc(prevDateId).collection('items')
        .where('symbol', '==', symbol).where('status', '==', 'ACCEPTED').get();
    if (ordersSnap.empty)
        return;
    const bar = await (0, barCache_1.getBarOn)(db, symbol, dateId);
    if (!bar)
        return;
    const batch = db.batch();
    for (const doc of ordersSnap.docs) {
        const order = doc.data();
        // V2.2: Fetch regime and liquidity bucket for dynamic slippage
        const [regimeSnap, signalSnap] = await Promise.all([
            db.collection('regime').doc(prevDateId).get(),
            order.createdFromSignalId
                ? db.collection('signals').doc(prevDateId).collection('items').doc(order.createdFromSignalId).get()
                : Promise.resolve(null),
        ]);
        const regimeState = regimeSnap.exists ? (_b = (_a = regimeSnap.data()) === null || _a === void 0 ? void 0 : _a.marketState) !== null && _b !== void 0 ? _b : 'TREND' : 'TREND';
        const liquidityBucket = (_f = ((signalSnap === null || signalSnap === void 0 ? void 0 : signalSnap.exists) ? (_e = (_d = (_c = signalSnap.data()) === null || _c === void 0 ? void 0 : _c.features) === null || _d === void 0 ? void 0 : _d.liquidity) === null || _e === void 0 ? void 0 : _e.bucket : undefined)) !== null && _f !== void 0 ? _f : 'A';
        const medVol20 = (_k = ((signalSnap === null || signalSnap === void 0 ? void 0 : signalSnap.exists) ? (_j = (_h = (_g = signalSnap.data()) === null || _g === void 0 ? void 0 : _g.features) === null || _h === void 0 ? void 0 : _h.liquidity) === null || _j === void 0 ? void 0 : _j.medVol20 : undefined)) !== null && _k !== void 0 ? _k : 0;
        const slippageBps = computeSlippageBps(liquidityBucket, regimeState, order.intendedQty, medVol20);
        const slippageMult = order.side === 'BUY' ? (1 + slippageBps / 10000) : (1 - slippageBps / 10000);
        let fillPrice = bar.open * slippageMult;
        // V3.0: Fill price bounds — clamp to [bar.low, bar.high]
        fillPrice = Math.max(bar.low, Math.min(bar.high, fillPrice));
        // V3.0: Gap-through-stop simulation — if open gaps past stop, fill at open (not stop)
        if (order.orderType === 'EXIT' || order.exitType) {
            const posRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
            const posCheck = await posRef.get();
            if (posCheck.exists) {
                const pos = posCheck.data();
                if (pos.direction === 'BUY' && bar.open < pos.stopPrice) {
                    fillPrice = bar.open; // Gap down through stop — fill at open, not stop
                    await logger_1.logger.warn(`[PaperBroker] GAP THROUGH STOP: ${symbol} opened at ${bar.open} below stop ${pos.stopPrice}`, 'PaperBroker', { symbol, jobId });
                }
                else if (pos.direction === 'SELL' && bar.open > pos.stopPrice) {
                    fillPrice = bar.open; // Gap up through stop for shorts
                    await logger_1.logger.warn(`[PaperBroker] GAP THROUGH STOP: ${symbol} opened at ${bar.open} above stop ${pos.stopPrice}`, 'PaperBroker', { symbol, jobId });
                }
            }
        }
        // V3.0: Reject illiquid orders (bucket C with > 5% ADV)
        if (liquidityBucket === 'C' && medVol20 > 0 && order.intendedQty > medVol20 * runtime_1.ADV_LIMITS.MAX_ADV_PCT * 2.5) {
            await logger_1.logger.warn(`[PaperBroker] REJECTING illiquid order: ${symbol} qty ${order.intendedQty} > ${(runtime_1.ADV_LIMITS.MAX_ADV_PCT * 250).toFixed(0)}% of ADV`, 'PaperBroker', { symbol, jobId });
            batch.update(doc.ref, { status: 'REJECTED', rejectReason: 'ILLIQUID_ORDER' });
            continue;
        }
        const feeEstimate = computeFeeEstimate(fillPrice, order.intendedQty, order.side);
        const fillId = `fill_${doc.id}_${dateId}`;
        const fill = {
            orderId: doc.id, symbol, side: order.side, fillPrice, fillQty: order.intendedQty,
            slippageBps, feeEstimate, fillType: order.exitType || 'ENTRY', timestamp: firestore_1.Timestamp.now()
        };
        const fillRef = db.collection('paperFills').doc(dateId).collection('items').doc(fillId);
        // The fill is recorded ONLY once we know it establishes (entry) or settles
        // (exit) a tracked position — see the guarded writes below. Writing it up
        // front left "phantom" fills for orders that then aborted on a missing
        // signal/position: cash the equity ledger never saw (an audit break) and,
        // in live, a filled order with no position behind it.
        if (order.orderType === 'ENTRY') {
            const signalPath = `signals/${prevDateId}/items/${order.createdFromSignalId}`;
            const sigSnap = await db.doc(signalPath).get();
            if (!sigSnap.exists) {
                batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'SIGNAL_MISSING' });
                continue;
            }
            // One position per symbol. The position doc is keyed by symbol, so a second
            // ENTRY while one is still OPEN would OVERWRITE the first — spending cash on
            // shares the system then stops tracking and never exits (a capital leak that
            // broke the independent cash-flow audit). Reject the stacked entry instead.
            const posDocRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
            const existingPos = await posDocRef.get();
            if (existingPos.exists && existingPos.data().status === 'OPEN') {
                batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'POSITION_ALREADY_OPEN' });
                await logger_1.logger.warn(`[PaperBroker] REJECTING stacked entry: ${symbol} already has an OPEN position`, 'PaperBroker', { symbol, jobId });
                continue;
            }
            batch.set(fillRef, fill);
            const signal = sigSnap.data();
            const atrRef = signal.atrRef || 0;
            const finalStop = order.side === 'BUY' ? fillPrice - (atrRef * (signal.stopAtrMult || 2.0)) : fillPrice + (atrRef * (signal.stopAtrMult || 2.0));
            const finalTarget = order.side === 'BUY' ? fillPrice + (atrRef * (signal.targetAtrMult || 3.0)) : fillPrice - (atrRef * (signal.targetAtrMult || 3.0));
            const position = {
                symbol: order.symbol,
                direction: order.side === 'BUY' ? 'BUY' : 'SELL',
                avgEntryPrice: fillPrice,
                qty: order.intendedQty,
                stopPrice: finalStop, targets: [finalTarget],
                status: 'OPEN', unrealizedPnl: 0, realizedPnl: 0, openedAt: firestore_1.Timestamp.now(), lastUpdatedAt: firestore_1.Timestamp.now(),
                entryFillId: fillId, atrAtEntry: atrRef, partialTaken: false, mfeAtr: 0, entryDateId: dateId,
                riskAmount: order.risk.riskAmount, signalId: order.createdFromSignalId, signalPath,
                // V2.4: Strategy field for per-strategy exit profiles
                strategy: signal.strategy,
                // V3.1: fee/qty basis for realised-P&L attribution across (partial) exits
                entryFee: feeEstimate,
                entryQty: order.intendedQty,
            };
            batch.set(db.collection('portfolio').doc('default').collection('positions').doc(symbol), position);
            batch.update(sigSnap.ref, {
                status: 'IN_TRADE', stopPrice: finalStop, targets: [finalTarget], rr: (signal.targetAtrMult || 3.0) / (signal.stopAtrMult || 2.0),
                execution: { status: 'FILLED', orderId: doc.id, fillId, entryPrice: fillPrice, entryDateId: dateId }
            });
        }
        else {
            // EXIT Order Logic
            const posRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
            const posSnap = await posRef.get();
            if (!posSnap.exists) {
                batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'POSITION_MISSING' });
                continue;
            }
            batch.set(fillRef, fill);
            const pos = posSnap.data();
            // V3.1: Realise P&L on the exited quantity (partial or full). Attribute a
            // prorated share of the entry fee so entry cost is counted exactly once
            // across all exits of this position. Netting long and short here avoids the
            // broken signed-cash convention entirely.
            const exitQty = order.intendedQty; // == fill.fillQty
            const entryQty = (_l = pos.entryQty) !== null && _l !== void 0 ? _l : pos.qty;
            const { realizedPnl, entryFeeShare } = (0, portfolioEquity_1.computeExitPnl)({
                direction: pos.direction,
                avgEntryPrice: pos.avgEntryPrice,
                exitPrice: fillPrice,
                exitQty,
                entryQty,
                entryFee: (_m = pos.entryFee) !== null && _m !== void 0 ? _m : 0,
                exitFee: feeEstimate,
            });
            const rMultiple = pos.riskAmount && pos.riskAmount > 0 && entryQty > 0
                ? realizedPnl / (pos.riskAmount * (exitQty / entryQty))
                : undefined;
            const tradeRec = {
                symbol,
                direction: pos.direction,
                strategy: pos.strategy,
                entryDateId: pos.entryDateId || '',
                exitDateId: dateId,
                entryPrice: pos.avgEntryPrice,
                exitPrice: fillPrice,
                qty: exitQty,
                fees: feeEstimate + entryFeeShare,
                realizedPnl,
                exitReason: order.exitType,
                entryFillId: pos.entryFillId,
                exitFillId: fillId,
                closedAt: firestore_1.Timestamp.now(),
            };
            if (rMultiple !== undefined)
                tradeRec.rMultiple = rMultiple;
            // Append-only: keyed by the (unique) exit fill id, never overwritten on re-entry.
            batch.set(db.collection('portfolio').doc('default').collection('trades').doc(fillId), tradeRec);
            if (order.exitType === 'PARTIAL_PROFIT') {
                batch.update(posRef, {
                    qty: admin.firestore.FieldValue.increment(-exitQty),
                    realizedPnl: admin.firestore.FieldValue.increment(realizedPnl),
                    stopPrice: pos.avgEntryPrice, // Breakeven (Gap B3 Rules)
                    partialTaken: true,
                    lastUpdatedAt: firestore_1.Timestamp.now()
                });
                // Update signal doc also
                if (pos.signalPath)
                    batch.update(db.doc(pos.signalPath), { stopPrice: pos.avgEntryPrice });
            }
            else {
                // Full Exit
                batch.update(posRef, {
                    status: 'CLOSED',
                    realizedPnl: admin.firestore.FieldValue.increment(realizedPnl),
                    exitReason: order.exitType,
                    exitFillId: fillId,
                    exitPrice: fillPrice,
                    exitDateId: dateId,
                    closedAt: firestore_1.Timestamp.now(),
                });
                if (pos.signalPath)
                    batch.update(db.doc(pos.signalPath), { status: 'DONE' });
            }
        }
        batch.update(doc.ref, { status: 'FILLED' });
        await logger_1.logger.info(`[PaperBroker] ${order.orderType} FILLED for ${symbol} at ${fillPrice.toFixed(2)}`, 'PaperBroker', { symbol, jobId, orderType: order.orderType });
    }
    await batch.commit();
}
//# sourceMappingURL=paperBroker.js.map