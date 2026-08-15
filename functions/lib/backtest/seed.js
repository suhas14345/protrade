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
exports.INDEX_SYMBOL = void 0;
exports.seedBacktest = seedBacktest;
/**
 * Emulator seeder for backtests.
 *
 * Writes the minimum Firestore state the real stage functions require:
 *   - calendar/{dateId}            (trading-day index + prev/next links)
 *   - universes/{id}/members/{sym} (tradable symbol set)
 *   - config/account               (equity + risk config the risk gates read)
 *   - barsD/{symbol}/days/{dateId} (daily OHLCV, incl. the ^NSEI index)
 *
 * In synthetic mode it fabricates deterministic OHLCV so the engine can be
 * validated without any broker data. A `bars` map can also be supplied to seed
 * real (e.g. Kite) history instead.
 */
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const calendar_1 = require("../services/calendar");
const syntheticData_1 = require("./syntheticData");
exports.INDEX_SYMBOL = '^NSEI';
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/** Deterministic 32-bit hash so each symbol's synthetic series is stable. */
function hashSeed(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
/** Commit an array of write closures in chunks that respect the 500-op batch limit. */
async function chunkedWrite(db, ops, chunkSize = 400) {
    for (let i = 0; i < ops.length; i += chunkSize) {
        const batch = db.batch();
        for (const op of ops.slice(i, i + chunkSize))
            op(batch);
        await batch.commit();
    }
}
async function writeSeries(db, symbol, bars) {
    const ops = bars.map((b) => (batch) => {
        const ref = db.collection('barsD').doc(symbol).collection('days').doc(b.dateId);
        batch.set(ref, {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
            dateId: b.dateId,
            timestamp: firestore_1.Timestamp.fromDate(new Date(b.isoDate + 'T00:00:00Z')),
        });
    });
    await chunkedWrite(db, ops);
}
/**
 * Seed everything needed for a replay. Returns the ordered list of trading dates.
 */
async function seedBacktest(opts) {
    var _a, _b, _c, _d, _e, _f;
    const db = getDb();
    // Real mode = caller supplied actual bars. Trading days then come from the
    // index series itself (real NSE holidays are absent), matching production's
    // calendar source-of-truth. Synthetic mode uses every weekday in range.
    const realMode = !!(opts.bars && opts.bars[exports.INDEX_SYMBOL]);
    const dates = realMode
        ? opts.bars[exports.INDEX_SYMBOL].map((b) => ({ dateId: b.dateId, isoDate: b.isoDate }))
        : (0, syntheticData_1.tradingDates)(opts.startISO, opts.endISO);
    // 2. Universe members (doc id === symbol; index is intentionally excluded).
    const memberOps = opts.symbols.map((sym) => (batch) => {
        batch.set(db.collection('universes').doc(opts.universeId).collection('members').doc(sym), {
            symbol: sym,
            addedAt: firestore_1.Timestamp.now(),
        });
    });
    await chunkedWrite(db, memberOps);
    // 3. Account config (shape mirrors maintenance.seedConfig).
    await db.collection('config').doc('account').set({
        equity: (_a = opts.initialEquity) !== null && _a !== void 0 ? _a : 1000000,
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
        peakEquity: (_b = opts.initialEquity) !== null && _b !== void 0 ? _b : 1000000,
    }, { merge: true });
    // 4. Bars for the index, then every tradable symbol.
    const indexBars = (_d = (_c = opts.bars) === null || _c === void 0 ? void 0 : _c[exports.INDEX_SYMBOL]) !== null && _d !== void 0 ? _d : (0, syntheticData_1.generateSeries)(hashSeed(exports.INDEX_SYMBOL), dates, { annualDrift: 0.10, annualVol: 0.15 });
    await writeSeries(db, exports.INDEX_SYMBOL, indexBars);
    for (const sym of opts.symbols) {
        const series = (_f = (_e = opts.bars) === null || _e === void 0 ? void 0 : _e[sym]) !== null && _f !== void 0 ? _f : (0, syntheticData_1.generateSeries)(hashSeed(sym), dates);
        await writeSeries(db, sym, series);
    }
    // 5. Calendar. In real mode derive it from the seeded index bars (production
    // source-of-truth: real trading days + non-trading gaps). In synthetic mode
    // reuse the weekday seeder for identical prev/next semantics.
    if (realMode) {
        await calendar_1.CalendarService.syncFromIndexData(exports.INDEX_SYMBOL);
    }
    else {
        await calendar_1.CalendarService.seedCalendar(opts.startISO, opts.endISO);
    }
    return dates;
}
//# sourceMappingURL=seed.js.map