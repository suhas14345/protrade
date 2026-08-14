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
exports.runReplay = runReplay;
/**
 * Synchronous replay engine.
 *
 * Faithful backtest driver: it calls the SAME stage functions the live
 * orchestrator uses (features, regime, RS ranking, signals, risk, paper broker,
 * trade manager) in the SAME order — but invokes them directly, in-process,
 * instead of via the Cloud Tasks queue (which the local emulator does not run).
 * This guarantees backtest and live share identical decision + fill logic.
 *
 * It also closes the P&L loop the production code leaves open: on each fill it
 * updates a cash ledger, reconstructs closed trades, marks open positions to
 * market at the day's close, and writes equity / peakEquity / equityEMA25 /
 * portfolioRealizedVol back to config/account so the drawdown and vol-targeting
 * risk gates actually respond during the replay.
 */
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const runtime_1 = require("../config/runtime");
const calendar_1 = require("../services/calendar");
const features_1 = require("../services/features");
const regime_1 = require("../services/regime");
const rsRanking_1 = require("../services/rsRanking");
const strategy_1 = require("../services/strategy");
const tradeManager_1 = require("../services/tradeManager");
const paperBroker_1 = require("../services/paperBroker");
const seed_1 = require("./seed");
const metrics_1 = require("./metrics");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Run the day-by-day replay. Returns the equity curve and reconstructed trades.
 */
async function runReplay(opts) {
    const db = getDb();
    // Backtest mode: disables market-hours guard and data-staleness checks.
    runtime_1.RUNTIME_CONFIG.MODE = 'REPLAY';
    const { universeId, symbols, dates } = opts;
    let cash = opts.initialEquity;
    const lots = new Map();
    const trades = [];
    const curve = [];
    let peakEquity = opts.initialEquity;
    let equityEMA25 = opts.initialEquity;
    const emaK = 2 / (25 + 1);
    for (let i = opts.tradeStartIndex; i < dates.length; i++) {
        const day = dates[i];
        const jobId = `bt_${day.dateId}`;
        // Ensure a job doc exists so stage functions' .update() calls succeed.
        await db.collection('jobs').doc(jobId).set({
            runDate: day.isoDate,
            universeId,
            type: 'EOD_RUN',
            stage: 'FETCH',
            counts: { total: symbols.length, processed: 0, failed: 0 },
            createdAt: firestore_1.Timestamp.now(),
            updatedAt: firestore_1.Timestamp.now(),
        });
        // 1. Fill yesterday's ACCEPTED orders at today's open (entries and exits).
        for (const sym of symbols) {
            await (0, paperBroker_1.doOpenFillSimulation)(jobId, day.isoDate, sym);
        }
        // 1b. Reconcile today's fills into the cash ledger and closed-trade list.
        await applyFills(db, day.dateId, lots, trades, (delta) => { cash += delta; });
        // 2. Manage open positions vs today's close → queues exit orders for tomorrow.
        await (0, tradeManager_1.doManageTrades)(day.dateId, jobId);
        // 3. Features for the index and every tradable symbol.
        await safeStage(() => (0, features_1.doComputeFeatures)(jobId, seed_1.INDEX_SYMBOL, day.isoDate));
        for (const sym of symbols) {
            await safeStage(() => (0, features_1.doComputeFeatures)(jobId, sym, day.isoDate));
        }
        // 4. Regime, 5. RS ranking.
        await (0, regime_1.doComputeRegime)(day.isoDate, jobId, seed_1.INDEX_SYMBOL, universeId);
        await (0, rsRanking_1.doComputeRsRanking)(day.dateId, jobId, universeId);
        // 6. Signals per symbol.
        for (const sym of symbols) {
            await safeStage(() => (0, strategy_1.doEvaluateSignals)(jobId, sym, day.isoDate, undefined, universeId));
        }
        // 7. Approved signals → ACCEPTED entry orders (filled tomorrow at open).
        await (0, paperBroker_1.doPlaceOrders)(day.dateId, jobId);
        // 8. Mark to market at today's close and record equity.
        const mtm = await markToMarket(db, day.dateId, lots);
        const equity = cash + mtm;
        curve.push({ dateId: day.dateId, equity });
        // Close the equity loop for the risk gates: write equity stats back.
        peakEquity = Math.max(peakEquity, equity);
        equityEMA25 = equity * emaK + equityEMA25 * (1 - emaK);
        const recentRets = (0, metrics_1.dailyReturns)(curve.slice(-21).map((p) => p.equity));
        const portfolioRealizedVol = annualisedVol(recentRets);
        await db.collection('config').doc('account').update({
            equity,
            peakEquity,
            equityEMA25,
            portfolioRealizedVol,
        });
        if (opts.onDay)
            opts.onDay(i, day.dateId, equity);
    }
    return { curve, trades };
}
/** Run a per-symbol stage but swallow "insufficient data" style errors so one bad symbol can't halt the day. */
async function safeStage(fn) {
    try {
        await fn();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/insufficient|not enough|Needs 25|No bars|missing/i.test(msg))
            throw e;
    }
}
/**
 * Read the day's fills, join each to its order (for side), update cash and the
 * lot ledger, and emit a ClosedTrade for every exit fill.
 */
async function applyFills(db, dateId, lots, trades, addCash) {
    var _a, _b;
    const fillsSnap = await db.collection('paperFills').doc(dateId).collection('items').get();
    if (fillsSnap.empty)
        return;
    const prevDateId = await calendar_1.CalendarService.getPrevTradingDateId(dateId);
    const ordersSnap = prevDateId
        ? await db.collection('paperOrders').doc(prevDateId).collection('items').get()
        : null;
    const orderById = new Map();
    ordersSnap === null || ordersSnap === void 0 ? void 0 : ordersSnap.docs.forEach((d) => orderById.set(d.id, d.data()));
    for (const doc of fillsSnap.docs) {
        const fill = doc.data();
        const order = orderById.get(fill.orderId);
        if (!order)
            continue; // exits placed on other days are rare; skip if unmatched
        const side = order.side; // 'BUY' | 'SELL'
        // Cash convention: a SELL brings cash in, a BUY takes cash out; fees always reduce cash.
        const signedValue = (side === 'SELL' ? 1 : -1) * fill.fillPrice * fill.fillQty;
        addCash(signedValue - fill.feeEstimate);
        if (fill.fillType === 'ENTRY') {
            lots.set(fill.symbol, {
                direction: side,
                qty: fill.fillQty,
                originalQty: fill.fillQty,
                entryPrice: fill.fillPrice,
                entryFee: fill.feeEstimate,
                entryDateId: dateId,
                riskAmount: (_b = (_a = order.risk) === null || _a === void 0 ? void 0 : _a.riskAmount) !== null && _b !== void 0 ? _b : 0,
            });
            continue;
        }
        // Exit fill (full or partial): realise P&L on the filled quantity.
        const lot = lots.get(fill.symbol);
        if (!lot)
            continue;
        const grossPerShare = lot.direction === 'BUY' ? fill.fillPrice - lot.entryPrice : lot.entryPrice - fill.fillPrice;
        const entryFeeShare = lot.originalQty > 0 ? lot.entryFee * (fill.fillQty / lot.originalQty) : 0;
        const pnl = grossPerShare * fill.fillQty - fill.feeEstimate - entryFeeShare;
        trades.push({
            symbol: fill.symbol,
            direction: lot.direction,
            entryDateId: lot.entryDateId,
            exitDateId: dateId,
            qty: fill.fillQty,
            entryPrice: lot.entryPrice,
            exitPrice: fill.fillPrice,
            fees: fill.feeEstimate + entryFeeShare,
            pnl,
            rMultiple: lot.riskAmount > 0 ? pnl / lot.riskAmount : undefined,
            exitReason: fill.fillType,
        });
        lot.qty -= fill.fillQty;
        if (lot.qty <= 0)
            lots.delete(fill.symbol);
    }
}
/** Sum the market value of open lots at the day's close (long = +qty*close, short = -qty*close). */
async function markToMarket(db, dateId, lots) {
    let total = 0;
    for (const [symbol, lot] of lots) {
        const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
        if (!barSnap.exists)
            continue;
        const close = Number(barSnap.data().close);
        total += (lot.direction === 'BUY' ? 1 : -1) * lot.qty * close;
    }
    return total;
}
function annualisedVol(returns) {
    if (returns.length < 2)
        return 0;
    const m = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252);
}
//# sourceMappingURL=engine.js.map