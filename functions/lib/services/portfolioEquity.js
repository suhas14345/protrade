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
exports.computeExitPnl = computeExitPnl;
exports.sumRealizedToDate = sumRealizedToDate;
exports.lastCloseOnOrBefore = lastCloseOnOrBefore;
exports.computeOpenUnrealized = computeOpenUnrealized;
exports.recomputeAccountEquity = recomputeAccountEquity;
/**
 * Single source of truth for account equity, drawdown, and realized-vol.
 *
 * The daily "roll realised + unrealised P&L into account equity" step used to
 * live ONLY in the backtest engine, so live never updated `config/account.equity`
 * after the seed — position sizing never compounded, the drawdown gate never
 * fired, and `portfolioRealizedVol` (which switches strategy.ts into vol-targeted
 * sizing) was never written in production. That made live and backtest diverge on
 * exactly the risk gates the strategy depends on.
 *
 * Both the live orchestrator (via aggregateStats.updateEquityCurve) and the
 * backtest engine now call `recomputeAccountEquity` so the two paths cannot drift.
 *
 * Equity is derived from AUTHORITATIVE state, never a parallel ledger:
 *   equity = initialEquity
 *          + Σ realizedPnl over all trades closed on/before dateId
 *          + Σ open-position mark-to-market at dateId's close (net of the still
 *            -unrealised share of each position's entry fee)
 */
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("../config/runtime");
const barCache_1 = require("./barCache");
/** Number of trailing equity points used for the realised-vol estimate (→ up to 20 daily returns). */
const VOL_LOOKBACK_POINTS = 21;
/**
 * Pure realised-P&L formula for one (partial or full) exit, fees included.
 *
 * Extracted so it is unit-testable and used by EXACTLY ONE place in production
 * (paperBroker exit path). The entry fee is attributed pro-rata to the exited
 * quantity so the total entry cost is counted once across all exits of a
 * position. Long vs short is netted via price difference, never signed cash.
 */
function computeExitPnl(params) {
    const grossPerShare = params.direction === 'BUY'
        ? params.exitPrice - params.avgEntryPrice
        : params.avgEntryPrice - params.exitPrice;
    const entryFeeShare = params.entryQty > 0
        ? params.entryFee * (params.exitQty / params.entryQty)
        : 0;
    const realizedPnl = grossPerShare * params.exitQty - params.exitFee - entryFeeShare;
    return { realizedPnl, entryFeeShare };
}
/** Cumulative realised P&L booked by the exit path for all trades closed on/before `dateId`. */
async function sumRealizedToDate(db, dateId) {
    const snap = await db
        .collection('portfolio').doc('default').collection('trades')
        .where('exitDateId', '<=', dateId)
        .get();
    let total = 0;
    snap.docs.forEach((d) => { total += Number(d.data().realizedPnl) || 0; });
    return total;
}
/**
 * Latest close at or before `dateId` for a symbol, or null if it has no bar on
 * or before that date. A position may still be open on a date the symbol has no
 * bar for (end of data, a halt, or a delisting), so marking to a strict `dateId`
 * lookup would silently value it at zero. Both the equity derivation and the
 * independent backtest audit use THIS function, so they value open positions
 * identically and reconcile. Ascending key-range scan (the emulator rejects
 * descending documentId scans).
 */
async function lastCloseOnOrBefore(db, symbol, dateId) {
    const bar = await (0, barCache_1.getLatestOnOrBefore)(db, symbol, dateId);
    return bar ? Number(bar.close) : null;
}
/**
 * Mark every currently-OPEN position to market at `dateId`'s close, netting the
 * still-unrealised share of its entry fee. Netting long/short via P&L (not signed
 * cash) is what makes the equity curve reconcile: when a position later closes,
 * its realised record replaces exactly this unrealised amount.
 */
async function computeOpenUnrealized(db, dateId) {
    var _a, _b;
    const snap = await db
        .collection('portfolio').doc('default').collection('positions')
        .where('status', '==', 'OPEN')
        .get();
    let total = 0;
    for (const doc of snap.docs) {
        const p = doc.data();
        if (!p.qty || p.qty <= 0)
            continue;
        const close = await lastCloseOnOrBefore(db, p.symbol, dateId);
        if (close === null)
            continue;
        const gross = (p.direction === 'BUY' ? close - p.avgEntryPrice : p.avgEntryPrice - close) * p.qty;
        const entryQty = (_a = p.entryQty) !== null && _a !== void 0 ? _a : p.qty;
        const openEntryFeeShare = ((_b = p.entryFee) !== null && _b !== void 0 ? _b : 0) * (entryQty > 0 ? p.qty / entryQty : 0);
        total += gross - openEntryFeeShare;
    }
    return total;
}
/** Simple period-over-period returns from an equity series (skips non-positive prevs). */
function dailyReturns(equity) {
    const out = [];
    for (let i = 1; i < equity.length; i++) {
        const prev = equity[i - 1];
        if (prev > 0)
            out.push(equity[i] / prev - 1);
    }
    return out;
}
/** Annualised (252d) standard deviation of a return series. */
function annualisedVol(returns) {
    if (returns.length < 2)
        return 0;
    const m = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252);
}
/**
 * Recompute account equity from authoritative state at `dateId`, persist a daily
 * equity snapshot, refresh peak / EMA / realised-vol, and write them back to
 * `config/account`. Returns the update, or null if there is no account config.
 *
 * Idempotent per `dateId`: re-running overwrites that day's snapshot and account
 * fields with the same derived values.
 */
async function recomputeAccountEquity(db, dateId) {
    var _a, _b, _c, _d, _e;
    const accountRef = db.collection('config').doc('account');
    const accountSnap = await accountRef.get();
    if (!accountSnap.exists)
        return null;
    const account = accountSnap.data();
    // Anchor for the derivation. Falls back to the seed value if an older account
    // doc predates the initialEquity field.
    const initial = (_c = (_b = (_a = account.initialEquity) !== null && _a !== void 0 ? _a : account.peakEquity) !== null && _b !== void 0 ? _b : account.equity) !== null && _c !== void 0 ? _c : 1000000;
    const realizedToDate = await sumRealizedToDate(db, dateId);
    const openUnrealized = await computeOpenUnrealized(db, dateId);
    const equity = initial + realizedToDate + openUnrealized;
    // Persist today's equity snapshot (idempotent per dateId).
    await db.collection('stats').doc('equityCurve').collection('days').doc(dateId).set({
        equity, dateId, recordedAt: admin.firestore.Timestamp.now(),
    });
    // Refresh EMA + realised-vol from the snapshot series. Bounded ascending
    // key-range scan (the emulator rejects descending key scans, and limitToLast
    // is rewritten into one by the SDK).
    const period = runtime_1.DRAWDOWN_CONFIG.EQUITY_EMA_PERIOD;
    const lb = new Date(Date.UTC(+dateId.slice(0, 4), +dateId.slice(4, 6) - 1, +dateId.slice(6, 8)));
    lb.setUTCDate(lb.getUTCDate() - Math.ceil(Math.max(period, VOL_LOOKBACK_POINTS) * 1.7) - 15);
    const lowerBound = `${lb.getUTCFullYear()}${String(lb.getUTCMonth() + 1).padStart(2, '0')}${String(lb.getUTCDate()).padStart(2, '0')}`;
    const snapshots = await db.collection('stats').doc('equityCurve').collection('days')
        .where(admin.firestore.FieldPath.documentId(), '>=', lowerBound)
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
        .get();
    const series = snapshots.docs.map((d) => d.data().equity);
    const emaWindow = series.slice(-period);
    let equityEMA25 = (_d = emaWindow[0]) !== null && _d !== void 0 ? _d : equity;
    const k = 2 / (period + 1);
    for (let i = 1; i < emaWindow.length; i++) {
        equityEMA25 = emaWindow[i] * k + equityEMA25 * (1 - k);
    }
    const volWindow = series.slice(-VOL_LOOKBACK_POINTS);
    const portfolioRealizedVol = annualisedVol(dailyReturns(volWindow));
    const peakEquity = Math.max((_e = account.peakEquity) !== null && _e !== void 0 ? _e : equity, equity);
    await accountRef.update({ equity, peakEquity, equityEMA25, portfolioRealizedVol });
    return { equity, peakEquity, equityEMA25, portfolioRealizedVol, realizedToDate, openUnrealized };
}
//# sourceMappingURL=portfolioEquity.js.map