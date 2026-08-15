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
/** Max concurrent per-symbol stage calls against the emulator. Override with BT_CONCURRENCY. */
const STAGE_CONCURRENCY = Math.max(1, parseInt(process.env.BT_CONCURRENCY || '16', 10));
/** Firestore path prefix for the paper portfolio (matches production paperBroker/tradeManager). */
const positionsCol = (db) => db.collection('portfolio').doc('default').collection('positions');
const tradesCol = (db) => db.collection('portfolio').doc('default').collection('trades');
/**
 * Run the day-by-day replay. Returns the equity curve and reconstructed trades.
 */
async function runReplay(opts) {
    const db = getDb();
    // Backtest mode: disables market-hours guard and data-staleness checks.
    runtime_1.RUNTIME_CONFIG.MODE = 'REPLAY';
    const { universeId, symbols, dates } = opts;
    const initial = opts.initialEquity;
    const curve = [];
    let peakEquity = initial;
    let equityEMA25 = initial;
    const emaK = 2 / (25 + 1);
    // Running realised P&L booked by the authoritative exit path (portfolio/default/trades).
    let realizedToDate = 0;
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
        // 1. Fill yesterday's ACCEPTED orders at today's open (entries and exits). This
        //    is the SAME production path that writes authoritative position docs and,
        //    on every exit, appends an immutable realised-trade record. The engine no
        //    longer keeps a parallel cash ledger — it reads that authoritative state.
        await mapPool(symbols, STAGE_CONCURRENCY, (sym) => (0, paperBroker_1.doOpenFillSimulation)(jobId, day.isoDate, sym));
        // 2. Manage open positions vs today's close → queues exit orders for tomorrow.
        await (0, tradeManager_1.doManageTrades)(day.dateId, jobId);
        // 3. Features for the index and every tradable symbol.
        await safeStage(() => (0, features_1.doComputeFeatures)(jobId, seed_1.INDEX_SYMBOL, day.isoDate));
        await mapPool(symbols, STAGE_CONCURRENCY, (sym) => safeStage(() => (0, features_1.doComputeFeatures)(jobId, sym, day.isoDate)));
        // 4. Regime, 5. RS ranking.
        await (0, regime_1.doComputeRegime)(day.isoDate, jobId, seed_1.INDEX_SYMBOL, universeId);
        await (0, rsRanking_1.doComputeRsRanking)(day.dateId, jobId, universeId);
        // 6. Signals per symbol.
        await mapPool(symbols, STAGE_CONCURRENCY, (sym) => safeStage(() => (0, strategy_1.doEvaluateSignals)(jobId, sym, day.isoDate, undefined, universeId)));
        // 7. Approved signals → ACCEPTED entry orders (filled tomorrow at open).
        await (0, paperBroker_1.doPlaceOrders)(day.dateId, jobId);
        // 8. Equity from AUTHORITATIVE state — no parallel ledger:
        //    realised P&L booked so far + open positions marked to market at today's close.
        realizedToDate += await sumRealizedForDate(db, day.dateId);
        const openUnrealized = await computeOpenUnrealized(db, day.dateId);
        const equity = initial + realizedToDate + openUnrealized;
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
    // Authoritative closed-trade list from the append-only trades ledger.
    const trades = await loadClosedTrades(db);
    // Reconciliation invariant: the equity curve MUST equal realised P&L plus the
    // open positions still marked to market on the final day. If these ever drift,
    // the ledger has a bug — fail loudly rather than report a fabricated number.
    const lastDateId = dates[dates.length - 1].dateId;
    const totalRealized = trades.reduce((a, t) => a + t.pnl, 0);
    const finalOpenUnrealized = await computeOpenUnrealized(db, lastDateId);
    const expectedEquity = initial + totalRealized + finalOpenUnrealized;
    const curveEnd = curve.length ? curve[curve.length - 1].equity : initial;
    const drift = Math.abs(curveEnd - expectedEquity);
    console.log(`[backtest] ledger reconciled: curveEnd=₹${curveEnd.toFixed(0)} ` +
        `realised=₹${totalRealized.toFixed(0)} openUnreal=₹${finalOpenUnrealized.toFixed(0)} ` +
        `drift=₹${drift.toFixed(2)}`);
    if (drift > 1) {
        throw new Error(`[backtest] Ledger reconciliation FAILED: equity curve end ₹${curveEnd.toFixed(2)} != ` +
            `realised+unrealised ₹${expectedEquity.toFixed(2)} (drift ₹${drift.toFixed(2)}).`);
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
 * Run `fn` over `items` with bounded concurrency. The per-symbol stages
 * (fill sim, feature compute, signal eval) are independent within a stage —
 * each reads/writes only its own symbol's documents — so parallelising them
 * changes only wall-clock time, not results. Aggregate stages (regime, RS
 * ranking, order placement) stay sequential and run after these complete.
 */
async function mapPool(items, concurrency, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const idx = next++;
            if (idx >= items.length)
                return;
            await fn(items[idx]);
        }
    });
    await Promise.all(workers);
}
/** Sum realised P&L of all trades that closed on `dateId` (append-only ledger). */
async function sumRealizedForDate(db, dateId) {
    const snap = await tradesCol(db).where('exitDateId', '==', dateId).get();
    let total = 0;
    snap.docs.forEach((d) => { total += Number(d.data().realizedPnl) || 0; });
    return total;
}
/**
 * Mark every currently-OPEN position to market at `dateId` close, netting the
 * still-unrealised share of its entry fee. Netting long/short via P&L (not signed
 * cash) is what makes the curve reconcile: when a position later closes, its
 * realised record replaces exactly this unrealised amount.
 */
async function computeOpenUnrealized(db, dateId) {
    var _a, _b;
    const snap = await positionsCol(db).where('status', '==', 'OPEN').get();
    let total = 0;
    for (const doc of snap.docs) {
        const p = doc.data();
        if (!p.qty || p.qty <= 0)
            continue;
        const barSnap = await db.collection('barsD').doc(p.symbol).collection('days').doc(dateId).get();
        if (!barSnap.exists)
            continue;
        const close = Number(barSnap.data().close);
        const gross = (p.direction === 'BUY' ? close - p.avgEntryPrice : p.avgEntryPrice - close) * p.qty;
        const entryQty = (_a = p.entryQty) !== null && _a !== void 0 ? _a : p.qty;
        const openEntryFeeShare = ((_b = p.entryFee) !== null && _b !== void 0 ? _b : 0) * (entryQty > 0 ? p.qty / entryQty : 0);
        total += gross - openEntryFeeShare;
    }
    return total;
}
/** Load the authoritative closed-trade list from the append-only trades ledger. */
async function loadClosedTrades(db) {
    const snap = await tradesCol(db).get();
    const out = snap.docs.map((d) => {
        const t = d.data();
        const ct = {
            symbol: t.symbol,
            direction: t.direction,
            entryDateId: t.entryDateId,
            exitDateId: t.exitDateId,
            qty: t.qty,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            fees: t.fees,
            pnl: t.realizedPnl,
            rMultiple: t.rMultiple,
            exitReason: t.exitReason,
        };
        return ct;
    });
    out.sort((a, b) => (a.exitDateId < b.exitDateId ? -1 : a.exitDateId > b.exitDateId ? 1 : 0));
    return out;
}
function annualisedVol(returns) {
    if (returns.length < 2)
        return 0;
    const m = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252);
}
//# sourceMappingURL=engine.js.map