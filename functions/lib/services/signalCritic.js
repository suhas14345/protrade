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
exports.worstSeverity = worstSeverity;
exports.checkJob = checkJob;
exports.checkFeatureStats = checkFeatureStats;
exports.checkSignals = checkSignals;
exports.checkOrders = checkOrders;
exports.checkCrossStrategyDup = checkCrossStrategyDup;
exports.checkPositions = checkPositions;
exports.checkCapital = checkCapital;
exports.checkLedger = checkLedger;
exports.doAuditSignals = doAuditSignals;
exports.auditSignalsTask = auditSignalsTask;
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const runtime_1 = require("../config/runtime");
const portfolioEquity_1 = require("./portfolioEquity");
const alerting_1 = require("./alerting");
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const SEV_RANK = { INFO: 0, WARN: 1, CRITICAL: 2 };
function worstSeverity(findings) {
    return findings.reduce((w, f) => (SEV_RANK[f.severity] > SEV_RANK[w] ? f.severity : w), 'INFO');
}
const VALID_STRATEGIES = new Set([
    'PullbackEOD', 'BreakoutCloseEOD', 'ShortBounceEOD', 'MeanReversionEOD',
    'BearBounceEOD', 'RSLeaderEOD', 'SepaBreakoutEOD', 'MetalsRotation', 'ATHPullbackEOD',
]);
// ── Pure checks (unit-tested in isolation) ───────────────────────────
/** EOD job completed cleanly and every dispatched symbol finished. */
function checkJob(job) {
    if (!job)
        return [{ code: 'JOB_MISSING', severity: 'CRITICAL', message: 'No EOD job found for the date' }];
    const f = [];
    if (job.status !== 'DONE')
        f.push({ code: 'JOB_NOT_DONE', severity: 'CRITICAL', message: `EOD job status is ${job.status}`, context: { stage: job.stage } });
    const c = job.counts || {};
    const total = Number(c.total || 0), done = Number(c.done || 0), failed = Number(c.failed || 0);
    if (failed > 0)
        f.push({ code: 'JOB_SYMBOLS_FAILED', severity: 'CRITICAL', message: `${failed} symbols failed in fan-out`, context: { failed, total } });
    if (total > 0 && done + failed < total)
        f.push({ code: 'JOB_INCOMPLETE', severity: 'WARN', message: `fan-out incomplete: ${done + failed}/${total}` });
    return f;
}
/** Feature-window health — the class of bug that silently zeroed all signals. */
function checkFeatureStats(s, indexUp) {
    if (s.total === 0)
        return [{ code: 'FEATURES_MISSING', severity: 'CRITICAL', message: 'No feature docs for the universe on this date' }];
    const f = [];
    // The exact Aug-2026 defect: a rising 200-SMA impossible for the whole universe.
    if (indexUp && s.sma200RisingTrue === 0) {
        f.push({ code: 'TREND_TEMPLATE_IMPOSSIBLE', severity: 'CRITICAL', message: 'Index is up but sma200Rising is FALSE for the entire universe — the trend template can never pass (feature-window/slope bug)', context: { total: s.total } });
    }
    if (s.criticalNaN > 0)
        f.push({ code: 'FEATURE_NAN', severity: 'CRITICAL', message: `${s.criticalNaN} symbols have non-finite critical features (sma50/150/200/high252)`, context: { count: s.criticalNaN } });
    const deepPct = s.deepBars / s.total;
    if (deepPct < 0.8)
        f.push({ code: 'SHALLOW_HISTORY', severity: 'WARN', message: `${Math.round((1 - deepPct) * 100)}% of universe has < 260 bars — feature window not full`, context: { deepBars: s.deepBars, total: s.total } });
    if (s.rsMissing / s.total > 0.1)
        f.push({ code: 'RS_RANK_MISSING', severity: 'WARN', message: `${s.rsMissing} symbols missing rsRank126 (RS pass gap)`, context: { rsMissing: s.rsMissing, total: s.total } });
    if (s.athSeeded < s.total)
        f.push({ code: 'ATH_SEED_PENDING', severity: 'INFO', message: `true-ATH full-history seed pending for ${s.total - s.athSeeded} symbols`, context: { seeded: s.athSeeded, total: s.total } });
    return f;
}
/** Signal integrity + presence given the regime/leadership context. */
function checkSignals(signals, ctx) {
    var _a;
    const f = [];
    for (const s of signals) {
        if (!VALID_STRATEGIES.has(s.strategy))
            f.push({ code: 'SIGNAL_BAD_STRATEGY', severity: 'WARN', message: `signal ${s.symbol} has unknown strategy "${s.strategy}"` });
        if (s.status === 'APPROVED') {
            if (!(Number((_a = s.riskApproval) === null || _a === void 0 ? void 0 : _a.sizedQty) > 0))
                f.push({ code: 'SIGNAL_ZERO_QTY', severity: 'WARN', message: `APPROVED signal ${s.symbol} has non-positive sizedQty`, context: { strategy: s.strategy } });
            if (!(Number(s.atrRef) > 0))
                f.push({ code: 'SIGNAL_BAD_ATRREF', severity: 'WARN', message: `signal ${s.symbol} has atrRef <= 0 (stop distance undefined)` });
        }
    }
    const equity = signals.filter((s) => s.strategy === 'SepaBreakoutEOD' || s.strategy === 'ATHPullbackEOD');
    // Leaders exist and the index is up, yet nothing fired — legit if none are near-high, but worth a look.
    if (ctx.indexUp && ctx.sma200RisingTrue > 0 && equity.length === 0) {
        f.push({ code: 'NO_EQUITY_SIGNALS', severity: 'WARN', message: `index up with ${ctx.sma200RisingTrue} trend-leaders, but 0 equity signals — verify near-high / pullback gates`, context: { sma200RisingTrue: ctx.sma200RisingTrue } });
    }
    return f;
}
/** Orders map to real signals, are sized, and limit orders carry a ceiling. */
function checkOrders(entryOrders, signalIds) {
    const f = [];
    for (const o of entryOrders) {
        if (o.createdFromSignalId && !signalIds.has(o.createdFromSignalId))
            f.push({ code: 'ORDER_ORPHAN', severity: 'WARN', message: `entry order ${o.symbol} references a missing signal`, context: { signalId: o.createdFromSignalId } });
        if (!(Number(o.intendedQty) > 0))
            f.push({ code: 'ORDER_ZERO_QTY', severity: 'WARN', message: `entry order ${o.symbol} has qty <= 0` });
        if (o.intendedEntryRef === 'LIMIT' && !(Number(o.limitHi) > 0))
            f.push({ code: 'ORDER_LIMIT_NO_CEILING', severity: 'WARN', message: `LIMIT order ${o.symbol} has no limitHi ceiling` });
    }
    return f;
}
/** No symbol ordered by more than one equity strategy on the same day (double-entry guard). */
function checkCrossStrategyDup(entryOrders) {
    const bySym = new Map();
    for (const o of entryOrders) {
        if (!bySym.has(o.symbol))
            bySym.set(o.symbol, new Set());
        bySym.get(o.symbol).add(o.strategy);
    }
    const f = [];
    for (const [sym, strats] of bySym) {
        if (strats.size > 1)
            f.push({ code: 'DUP_SYMBOL_ORDERS', severity: 'CRITICAL', message: `${sym} ordered by multiple strategies same day: ${[...strats].join(', ')}` });
    }
    return f;
}
/** Open positions: one per symbol, positive qty, sane entry. */
function checkPositions(openPositions) {
    const f = [];
    const seen = new Set();
    for (const p of openPositions) {
        if (seen.has(p.symbol))
            f.push({ code: 'DUP_OPEN_POSITION', severity: 'CRITICAL', message: `duplicate OPEN position for ${p.symbol}` });
        seen.add(p.symbol);
        if (!(Number(p.qty) > 0))
            f.push({ code: 'POSITION_ZERO_QTY', severity: 'CRITICAL', message: `OPEN position ${p.symbol} has qty <= 0` });
        if (!(Number(p.avgEntryPrice) > 0))
            f.push({ code: 'POSITION_BAD_ENTRY', severity: 'WARN', message: `OPEN position ${p.symbol} has avgEntryPrice <= 0` });
    }
    return f;
}
/** Gross equity capital never exceeds the shared book (settled cash × BOOK_PCT). */
function checkCapital(openEquityCost, settled, bookPct) {
    const book = settled * bookPct;
    if (openEquityCost > book * 1.001)
        return [{ code: 'BOOK_OVER_DEPLOYED', severity: 'CRITICAL', message: `equity deployed ${openEquityCost.toFixed(0)} exceeds book ${book.toFixed(0)}`, context: { openEquityCost, book } }];
    return [];
}
/** Ledger identities to the rupee: equity = initial + realized + unrealized; cash = settled − deployed. */
function checkLedger(l, tolInr = 1) {
    const f = [];
    const anchor = l.initialEquity + l.realizedPnl + l.unrealized;
    if (Math.abs(l.equity - anchor) > tolInr)
        f.push({ code: 'EQUITY_IDENTITY_BREAK', severity: 'CRITICAL', message: `equity ${l.equity.toFixed(2)} != initial+realized+unrealized ${anchor.toFixed(2)} (diff ${(l.equity - anchor).toFixed(2)})` });
    const cash = l.initialEquity + l.realizedPnl - l.deployed;
    if (l.cashBalance != null && Math.abs(l.cashBalance - cash) > tolInr)
        f.push({ code: 'CASH_IDENTITY_BREAK', severity: 'CRITICAL', message: `cashBalance ${l.cashBalance.toFixed(2)} != settledCash-deployed ${cash.toFixed(2)}` });
    if (cash < -tolInr)
        f.push({ code: 'NEGATIVE_CASH', severity: 'CRITICAL', message: `available cash is negative: ${cash.toFixed(2)}` });
    if (l.sumTradesRealized != null && Math.abs(l.realizedPnl - l.sumTradesRealized) > tolInr)
        f.push({ code: 'REALIZED_MISMATCH', severity: 'WARN', message: `account.realizedPnl ${l.realizedPnl.toFixed(2)} != Σ trades ${l.sumTradesRealized.toFixed(2)}` });
    return f;
}
// ── Orchestrator ─────────────────────────────────────────────────────
function toDateId(d) { return d.replace(/-/g, ''); }
function toDate(d) { return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d; }
/**
 * Daily signal critic: runs the full battery of invariant checks over one day's
 * features/regime/signals/orders/positions/ledger and returns a report. Writes the
 * report to critic/{dateId}; raises an alert only when opts.alert is true.
 */
async function doAuditSignals(dateInput, opts = {}) {
    var _a, _b, _c, _d, _e;
    const db = getDb();
    const date = toDate(dateInput || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
    const dateId = toDateId(date);
    const universe = opts.universe || 'nifty200';
    // 1. EOD job for the date
    const jobsSnap = await db.collection('jobs').where('runDate', '==', date).get();
    const eodJobs = jobsSnap.docs.map((d) => d.data()).filter((j) => j.type === 'EOD_RUN');
    eodJobs.sort((a, b) => { var _a, _b, _c, _d, _e, _f; return String((_c = (_b = (_a = b.updatedAt) === null || _a === void 0 ? void 0 : _a.toMillis) === null || _b === void 0 ? void 0 : _b.call(_a)) !== null && _c !== void 0 ? _c : 0).localeCompare(String((_f = (_e = (_d = a.updatedAt) === null || _d === void 0 ? void 0 : _d.toMillis) === null || _e === void 0 ? void 0 : _e.call(_d)) !== null && _f !== void 0 ? _f : 0)); });
    const job = eodJobs[0] || null;
    // 2. Regime → indexUp
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    const regime = regimeSnap.exists ? regimeSnap.data() : null;
    const m = regime === null || regime === void 0 ? void 0 : regime.metrics;
    const indexUp = !!m && Number(m.close) > Number(m.ema200) && Number((_a = m.ema200Slope) !== null && _a !== void 0 ? _a : 0) > 0 && regime.marketState !== 'BEAR';
    // 3. Feature stats across the universe
    const membersSnap = await db.collection('universes').doc(universe).collection('members').get();
    const symbols = membersSnap.docs.map((d) => d.id);
    const featRefs = symbols.map((s) => db.collection('features').doc(s).collection('days').doc(dateId));
    const parentRefs = symbols.map((s) => db.collection('features').doc(s));
    const stats = { total: 0, deepBars: 0, sma200RisingTrue: 0, criticalNaN: 0, rsMissing: 0, athSeeded: 0 };
    for (let i = 0; i < featRefs.length; i += 200) {
        const [daySnaps, parentSnaps] = await Promise.all([
            db.getAll(...featRefs.slice(i, i + 200)),
            db.getAll(...parentRefs.slice(i, i + 200)),
        ]);
        daySnaps.forEach((snap, k) => {
            var _a;
            if (!snap.exists)
                return;
            const d = snap.data();
            stats.total++;
            if (Number(d.barsCount) >= 260)
                stats.deepBars++;
            if (d.sma200Rising === true)
                stats.sma200RisingTrue++;
            const finite = [d.sma50, d.sma150, d.sma200, d.high252].every((x) => Number.isFinite(Number(x)));
            if (!finite)
                stats.criticalNaN++;
            if (!Number.isFinite(Number(d.rsRank126)))
                stats.rsMissing++;
            const p = (_a = parentSnaps[k]) === null || _a === void 0 ? void 0 : _a.data();
            if ((p === null || p === void 0 ? void 0 : p.athHighFullScan) === true)
                stats.athSeeded++;
        });
    }
    // 4. Signals / orders / positions / account
    const [sigSnap, ordSnap, posSnap, accSnap] = await Promise.all([
        db.collection('signals').doc(dateId).collection('items').get(),
        db.collection('paperOrders').doc(dateId).collection('items').get(),
        db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get(),
        db.collection('config').doc('account').get(),
    ]);
    const signals = sigSnap.docs.map((d) => (Object.assign({ id: d.id }, d.data())));
    const signalIds = new Set(signals.map((s) => s.id));
    const signalStrategyById = new Map(signals.map((s) => [s.id, s.strategy]));
    const orders = ordSnap.docs.map((d) => d.data());
    const entryOrders = orders.filter((o) => o.orderType === 'ENTRY');
    const entryOrdersWithStrat = entryOrders.map((o) => ({ symbol: o.symbol, strategy: signalStrategyById.get(o.createdFromSignalId) || 'UNKNOWN' }));
    const openPositions = posSnap.docs.map((d) => d.data());
    const account = accSnap.exists ? accSnap.data() : {};
    // 5. Ledger inputs (independent recompute)
    const EQUITY = new Set(runtime_1.EQUITY_STRATEGIES);
    const openEquityCost = openPositions
        .filter((p) => EQUITY.has(p.strategy || ''))
        .reduce((s, p) => s + Math.abs(Number(p.avgEntryPrice) * Number(p.qty)), 0);
    const [deployed, unrealized] = await Promise.all([
        (0, portfolioEquity_1.computeDeployedCost)(db),
        (0, portfolioEquity_1.computeOpenUnrealized)(db, dateId),
    ]);
    const initialEquity = Number((_c = (_b = account.initialEquity) !== null && _b !== void 0 ? _b : account.equity) !== null && _c !== void 0 ? _c : 0);
    const realizedPnl = Number((_d = account.realizedPnl) !== null && _d !== void 0 ? _d : 0);
    // 6. Run the battery
    const findings = [
        ...checkJob(job),
        ...checkFeatureStats(stats, indexUp),
        ...checkSignals(signals, { indexUp, sma200RisingTrue: stats.sma200RisingTrue }),
        ...checkOrders(entryOrders, signalIds),
        ...checkCrossStrategyDup(entryOrdersWithStrat),
        ...checkPositions(openPositions),
        ...checkCapital(openEquityCost, (0, portfolioEquity_1.settledCash)(account), runtime_1.SEPA_CONFIG.BOOK_PCT),
        ...checkLedger({
            equity: Number((_e = account.equity) !== null && _e !== void 0 ? _e : 0),
            deployed: Number(deployed),
            unrealized: Number(unrealized),
            realizedPnl,
            initialEquity,
            cashBalance: account.cashBalance != null ? Number(account.cashBalance) : null,
        }),
    ];
    const severity = worstSeverity(findings);
    const report = {
        dateId,
        date,
        universe,
        generatedAt: firestore_1.Timestamp.now(),
        severity,
        indexUp,
        counts: {
            signals: signals.length,
            approvedSignals: signals.filter((s) => s.status === 'APPROVED').length,
            entryOrders: entryOrders.length,
            openPositions: openPositions.length,
            findings: findings.length,
            critical: findings.filter((f) => f.severity === 'CRITICAL').length,
            warn: findings.filter((f) => f.severity === 'WARN').length,
        },
        featureStats: stats,
        findings,
    };
    await db.collection('critic').doc(dateId).set(report);
    await logger_1.logger.info(`[Critic] ${dateId} severity=${severity} findings=${findings.length} (crit=${report.counts.critical} warn=${report.counts.warn})`, 'Critic', { dateId });
    if (opts.alert && severity !== 'INFO') {
        const top = findings.filter((f) => f.severity === 'CRITICAL').slice(0, 5).map((f) => f.code).join(', ') || findings.filter((f) => f.severity === 'WARN').slice(0, 5).map((f) => f.code).join(', ');
        await (0, alerting_1.raiseAlert)(alerting_1.AlertType.SIGNAL_AUDIT, severity === 'CRITICAL' ? 'CRITICAL' : 'WARN', `Daily signal critic ${dateId}: ${report.counts.critical} critical, ${report.counts.warn} warn (${top})`, { dateId, findings });
    }
    return report;
}
/** Gateway task wrapper: { action:"auditSignals", date?, universe?, alert? } */
async function auditSignalsTask(req, res) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    try {
        const date = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.date) || ((_b = req.query) === null || _b === void 0 ? void 0 : _b.date);
        const universe = ((_c = req.body) === null || _c === void 0 ? void 0 : _c.universe) || ((_d = req.query) === null || _d === void 0 ? void 0 : _d.universe);
        const alert = String((_h = (_f = (_e = req.body) === null || _e === void 0 ? void 0 : _e.alert) !== null && _f !== void 0 ? _f : (_g = req.query) === null || _g === void 0 ? void 0 : _g.alert) !== null && _h !== void 0 ? _h : 'false') === 'true';
        const report = await doAuditSignals(date, { alert, universe });
        res.status(200).send(report);
    }
    catch (e) {
        res.status(500).send({ error: e.message });
    }
}
//# sourceMappingURL=signalCritic.js.map