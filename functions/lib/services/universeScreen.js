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
exports.evaluateScreenStats = evaluateScreenStats;
exports.doScreenUniverse = doScreenUniverse;
const admin = __importStar(require("firebase-admin"));
const barCache_1 = require("./barCache");
const runtime_1 = require("../config/runtime");
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Pure per-symbol screen evaluation. Applies SEPA's necessary preconditions (price, liquidity,
 * history, above-200DMA, within 25% of 52w high) and returns 126-day momentum for cross-sectional
 * RS ranking done by the caller. No I/O — unit-testable.
 */
function evaluateScreenStats(bars, cfg = runtime_1.SCREEN_CONFIG) {
    const empty = {
        close: NaN, medTradedValue20: NaN, barsCount: bars.length, sma200: NaN, high252: NaN,
        ret126: null, priceOk: false, liquidOk: false, historyOk: false, above200: false, nearHigh: false,
        eligibleBase: false, failedGate: 'history',
    };
    if (bars.length < cfg.MIN_BARS)
        return empty;
    const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c));
    if (closes.length < cfg.MIN_BARS)
        return empty;
    const close = closes[closes.length - 1];
    const recent20 = bars.slice(-20);
    const tradedValues = recent20.map((b) => (Number(b.close) || 0) * (Number(b.volume) || 0)).sort((a, b) => a - b);
    const medTradedValue20 = tradedValues[Math.floor(tradedValues.length / 2)] || 0;
    const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    const win252 = closes.slice(-252);
    const high252 = Math.max(...win252);
    const ret126 = closes.length >= 127 ? close / closes[closes.length - 127] - 1 : null;
    const priceOk = close >= cfg.MIN_PRICE;
    const liquidOk = medTradedValue20 >= cfg.MIN_MED_TRADED_VALUE;
    const historyOk = closes.length >= cfg.MIN_BARS;
    const above200 = !cfg.REQUIRE_ABOVE_200DMA || close > sma200;
    const nearHigh = high252 > 0 && close >= high252 * (1 - cfg.NEAR_HIGH_PCT);
    let failedGate = null;
    if (!historyOk)
        failedGate = 'history';
    else if (!priceOk)
        failedGate = 'price';
    else if (!liquidOk)
        failedGate = 'liquidity';
    else if (!above200)
        failedGate = 'below_200dma';
    else if (!nearHigh)
        failedGate = 'far_from_high';
    return {
        close, medTradedValue20, barsCount: closes.length, sma200, high252, ret126,
        priceOk, liquidOk, historyOk, above200, nearHigh,
        eligibleBase: failedGate === null, failedGate,
    };
}
function istTodayDateId() {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10).replace(/-/g, '');
}
/** Calendar-day gap between two YYYYMMDD ids (a - b). */
function daysBetween(aId, bId) {
    const p = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    return Math.round((p(aId) - p(bId)) / 86400000);
}
async function pool(items, worker, concurrency) {
    let i = 0;
    const run = async () => { while (i < items.length) {
        const idx = i++;
        try {
            await worker(items[idx]);
        }
        catch ( /* fail-soft per symbol */_a) { /* fail-soft per symbol */ }
    } };
    await Promise.all(Array.from({ length: concurrency }, run));
}
async function rewriteMembers(targetRef, rows) {
    const existing = await targetRef.get();
    for (let i = 0; i < existing.docs.length; i += 400) {
        const batch = targetRef.firestore.batch();
        existing.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    const now = admin.firestore.Timestamp.now();
    for (let i = 0; i < rows.length; i += 400) {
        const batch = targetRef.firestore.batch();
        rows.slice(i, i + 400).forEach((c) => batch.set(targetRef.doc(c.symbol), { symbol: c.symbol, sector: c.sector, liquidityBucket: 'A', screenedAt: now }));
        await batch.commit();
    }
}
/**
 * Screen the source pool into two universes (Phase 4, two-speed):
 *   - universes/{ELIGIBLE_TARGET}  slow pool — everything passing the necessary preconditions
 *   - universes/{TRADE_TARGET}     fast pool — the top-momentum cut the hunt trades (the default universe)
 * Lossless: only SEPA necessary preconditions gate. Guardrails: stale-bar TTL skip, MAX_CANDIDATES
 * budget cap, and a MIN_CANDIDATES fail-safe floor (never wipe the live universe on a bad data day).
 * Non-disruptive to bars — read-only over barsD.
 */
async function doScreenUniverse(req, res) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const db = getDb();
    const source = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.source) || runtime_1.SCREEN_CONFIG.SOURCE_UNIVERSE;
    const target = ((_b = req.body) === null || _b === void 0 ? void 0 : _b.target) || runtime_1.SCREEN_CONFIG.TRADE_TARGET;
    const eligibleTarget = ((_c = req.body) === null || _c === void 0 ? void 0 : _c.eligibleTarget) || runtime_1.SCREEN_CONFIG.ELIGIBLE_TARGET;
    const dateId = ((_d = req.body) === null || _d === void 0 ? void 0 : _d.date) ? String(req.body.date).replace(/-/g, '') : istTodayDateId();
    const force = ((_e = req.body) === null || _e === void 0 ? void 0 : _e.force) === true || ((_f = req.body) === null || _f === void 0 ? void 0 : _f.force) === '1';
    // TTL: skip a redundant rebuild if the trade pool was screened within TTL_HOURS (unless forced).
    if (!force) {
        const meta = await db.collection('universes').doc(target).collection('members').limit(1).get();
        const screenedAt = (_h = (_g = meta.docs[0]) === null || _g === void 0 ? void 0 : _g.data()) === null || _h === void 0 ? void 0 : _h.screenedAt;
        if (screenedAt && (Date.now() - screenedAt.toMillis()) < runtime_1.SCREEN_CONFIG.TTL_HOURS * 3600000) {
            res.status(200).send({ skipped: 'fresh', ageMs: Date.now() - screenedAt.toMillis(), target });
            return;
        }
    }
    const memSnap = await db.collection('universes').doc(source).collection('members').get();
    const members = memSnap.docs.map((d) => { var _a; return ({ symbol: d.id, sector: ((_a = d.data()) === null || _a === void 0 ? void 0 : _a.sector) || 'UNKNOWN' }); });
    if (members.length === 0) {
        res.status(400).send({ error: `Source universe '${source}' has no members` });
        return;
    }
    const gateFails = { history: 0, price: 0, liquidity: 0, below_200dma: 0, far_from_high: 0 };
    const survivors = [];
    let screened = 0;
    let stale = 0;
    await pool(members, async ({ symbol, sector }) => {
        var _a;
        const bars = await (0, barCache_1.getWindowOnOrBefore)(db, symbol, dateId, runtime_1.SCREEN_CONFIG.WINDOW);
        screened++;
        // TTL/staleness: a symbol whose latest stored bar is too old (dropped from the daily
        // delta, delisted, or token-fail) must not enter either pool.
        const lastId = bars.length ? bars[bars.length - 1].dateId : null;
        if (!lastId || daysBetween(dateId, String(lastId)) > runtime_1.SCREEN_CONFIG.MAX_BAR_STALENESS_DAYS) {
            stale++;
            return;
        }
        const s = evaluateScreenStats(bars);
        if (!s.eligibleBase) {
            if (s.failedGate)
                gateFails[s.failedGate] = (gateFails[s.failedGate] || 0) + 1;
            return;
        }
        survivors.push({ symbol, sector, ret126: (_a = s.ret126) !== null && _a !== void 0 ? _a : -Infinity });
    }, 20);
    // Top-momentum cut, then the budget cap: keep the strongest MOMENTUM_TOP_PCT by 126-day return.
    survivors.sort((a, b) => b.ret126 - a.ret126);
    const keepByPct = Math.max(1, Math.ceil(survivors.length * runtime_1.SCREEN_CONFIG.MOMENTUM_TOP_PCT));
    const candidates = survivors.slice(0, Math.min(keepByPct, runtime_1.SCREEN_CONFIG.MAX_CANDIDATES));
    // Fail-safe: a too-small candidate set signals a bad data day — do NOT wipe the live universe.
    if (candidates.length < runtime_1.SCREEN_CONFIG.MIN_CANDIDATES) {
        await logger_1.logger.warn(`[Screen] Aborting rewrite: only ${candidates.length} candidates (< MIN ${runtime_1.SCREEN_CONFIG.MIN_CANDIDATES}); keeping prior '${target}'`, 'Screen', { source, target, dateId, screened, stale });
        res.status(200).send({ aborted: 'too_few_candidates', screened, stale, eligibleBase: survivors.length, candidates: candidates.length, gateFails });
        return;
    }
    // Two-speed write: full eligible pool, then the traded momentum cut.
    await rewriteMembers(db.collection('universes').doc(eligibleTarget).collection('members'), survivors.map((s) => ({ symbol: s.symbol, sector: s.sector })));
    await rewriteMembers(db.collection('universes').doc(target).collection('members'), candidates.map((c) => ({ symbol: c.symbol, sector: c.sector })));
    await logger_1.logger.info(`[Screen] ${source}→${eligibleTarget}(${survivors.length})/${target}(${candidates.length}): ${screened} screened, ${stale} stale`, 'Screen', { source, target, eligibleTarget, dateId });
    res.status(200).send({
        source, eligibleTarget, target, dateId, screened, stale,
        eligibleBase: survivors.length,
        candidates: candidates.length,
        gateFails,
        topCandidates: candidates.slice(0, 15).map((c) => c.symbol),
    });
}
//# sourceMappingURL=universeScreen.js.map