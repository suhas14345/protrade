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
exports.evaluateSignalsTask = void 0;
exports.doEvaluateSignals = doEvaluateSignals;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("../config/runtime");
const safety_1 = require("./safety");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const toDateId = (date) => date.replace(/-/g, '');
/**
 * Helper: V1.1 Mandatory ATR Proximity (Strict)
 */
function isAtrNormalizedEmaTouch(close, ema20, ema50, atr14) {
    if (atr14 <= 0)
        return false;
    if (Math.abs(close - ema20) <= runtime_1.STRATEGY_V11.EMA_TOUCH_ATR_MULT * atr14)
        return true;
    const lo = Math.min(ema20, ema50);
    const hi = Math.max(ema20, ema50);
    if (close >= lo && close <= hi)
        return true;
    return false;
}
/**
 * Helper: V1.1 Volume Breakout Confirm (Strict)
 */
function breakoutVolumeOk(symbol, volume, volSma20) {
    const v = Number(volume);
    const vsma = Number(volSma20);
    if (!vsma || vsma <= 0) {
        console.warn(`[Strategy] Strict volume check failed for ${symbol}: volSma20 missing or zero.`);
        return false;
    }
    return v >= runtime_1.STRATEGY_V11.BREAKOUT_VOL_MULT * vsma;
}
/**
 * Helper: V1.1 Trend Neutrality
 */
function isTrendNeutral(close, ema20, ema50) {
    return (Math.abs(ema20 - ema50) / close) < runtime_1.STRATEGY_V11.RANGE_TREND_NEUTRAL_MAX;
}
/**
 * Helper: V1.1 Earnings Block (Hardened Gap 1 & 5)
 * Blocks entries within 2 trading days of earnings using Date math.
 */
async function isEntryBlockedByEarnings(symbol, runDateId) {
    var _a;
    if (!runtime_1.STRATEGY_V11.ENABLE_EARNINGS_BLOCK)
        return false;
    const db = getDb();
    // Location: Clean earnings root doc (Gap 5)
    const earningsSnap = await db.collection('earnings').doc(symbol).get();
    const nextEarningsDateId = (_a = earningsSnap.data()) === null || _a === void 0 ? void 0 : _a.nextEarningsDateId;
    if (!nextEarningsDateId)
        return false;
    // Real Date Math to avoid YYYYMMDD subtraction errors (Gap 1)
    const parseDateId = (id) => new Date(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`);
    const d1 = parseDateId(runDateId);
    const d2 = parseDateId(nextEarningsDateId);
    const diffDays = Math.ceil((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
    // Rule: Gap of 0 (today) to 4 (approx 2 trading days + weekend)
    if (diffDays >= 0 && diffDays <= 4) {
        console.log(`[Strategy] ${symbol} blocked by earnings on ${nextEarningsDateId} (Days: ${diffDays})`);
        return true;
    }
    return false;
}
/**
 * Optimized Historical Bar Fetch (Gap 3)
 */
async function getRecentBarsOnOrBefore(db, symbol, dateId, limit) {
    const snap = await db
        .collection('barsD')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc') // Optimized
        .limit(limit)
        .get();
    if (snap.empty)
        return [];
    return snap.docs
        .map(d => (Object.assign({ id: d.id }, d.data())))
        .reverse(); // Back to chronological order
}
function isFinitePos(n) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0;
}
/**
 * Evaluate strategies and generate signals for a symbol.
 */
async function doEvaluateSignals(jobId, symbol, runDate) {
    var _a;
    const db = getDb();
    const dateId = toDateId(runDate);
    // Atomic Sentinel Lock for Race-Safety (Gap 2)
    const sentinelRef = db.collection('signals').doc(dateId).collection('status').doc(`${symbol}_DONE`);
    try {
        await sentinelRef.create({
            status: 'RUNNING',
            jobId,
            startedAt: admin.firestore.Timestamp.now()
        });
    }
    catch (e) {
        // create() fails if doc already exists -> Atomically guarded
        console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Task already in progress or completed for ${runDate}. skipping.`);
        return;
    }
    let status = 'DONE';
    let reason = '';
    try {
        // 1. Load Features
        const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
        if (!featSnap.exists) {
            status = 'SKIPPED';
            reason = 'Features missing';
            return;
        }
        const features = featSnap.data();
        // 2. Load Regime
        const regimeSnap = await db.collection('regime').doc(dateId).get();
        if (!regimeSnap.exists) {
            status = 'SKIPPED';
            reason = 'Regime missing';
            return;
        }
        const regime = regimeSnap.data();
        if (!regime.tradeAllowed) {
            status = 'SKIPPED';
            reason = 'Trading barred by regime';
            return;
        }
        // 3. Load bars
        const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
        if (bars.length === 0) {
            status = 'SKIPPED';
            reason = 'Recent bars missing';
            return;
        }
        const lastBar = bars[bars.length - 1];
        (0, safety_1.checkSafety)(lastBar);
        // 4. Extract key indicators
        const ema20 = Number(features.ema20);
        const ema50 = Number(features.ema50);
        const rsi = Number((_a = features.rsi14) !== null && _a !== void 0 ? _a : 50);
        const atr = Number(features.atr14);
        const bbLower = Number(features.bbLower);
        const volSma20 = Number(features.volSma20 || 0);
        const currentClose = Number(lastBar.close);
        if (!isFinitePos(currentClose) || !isFinitePos(ema20) || !isFinitePos(ema50) || !Number.isFinite(rsi) || !isFinitePos(atr)) {
            status = 'SKIPPED';
            reason = 'Numeric validation failed';
            return;
        }
        // Earnings Block Check (Hardened)
        const earningsBlocked = await isEntryBlockedByEarnings(symbol, dateId);
        // 5. Strategy conditions
        const isLongPullback = !earningsBlocked && (regime.marketState === 'TREND' || regime.marketState === 'RANGE') && ema20 > ema50 && isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) && rsi >= 40 && rsi <= 55;
        let isBreakout = false;
        const volumeRatio = Number(lastBar.volume) / Number(volSma20 || 1);
        if (!earningsBlocked && regime.marketState === 'TREND' && ema20 > ema50 && bars.length >= 21) {
            const prev20 = bars.slice(-21, -1);
            const prev20High = Math.max(...prev20.map(b => Number(b.high)));
            isBreakout = currentClose > prev20High && breakoutVolumeOk(symbol, Number(lastBar.volume), volSma20);
        }
        const isMeanReversion = !earningsBlocked && regime.marketState === 'RANGE' && currentClose < bbLower && rsi < 30 && isTrendNeutral(currentClose, ema20, ema50);
        const isShortBounce = !earningsBlocked && (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') && ema20 < ema50 && isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) && rsi >= 45 && rsi <= 65;
        // 6. Create signals with Scoring and Indicative Pricing (Gap 4 & 6)
        const activeStrategies = [
            { condition: isLongPullback, name: 'PullbackEOD', direction: 'BUY',
                baseScore: 70 + (30 - Math.min(30, (Math.abs(currentClose - ema20) / atr) * 10)) },
            { condition: isShortBounce, name: 'ShortBounceEOD', direction: 'SELL',
                baseScore: 70 + (30 - Math.min(30, (Math.abs(currentClose - ema20) / atr) * 10)) },
            { condition: isBreakout, name: 'BreakoutCloseEOD', direction: 'BUY',
                baseScore: 75 + Math.min(25, (volumeRatio - 1.2) * 20) },
            { condition: isMeanReversion, name: 'MeanReversionEOD', direction: 'BUY',
                baseScore: 80 + Math.min(20, (Math.abs(currentClose - bbLower) / atr) * 10) },
        ].filter(s => s.condition);
        for (const strat of activeStrategies) {
            const stopMult = 2.0;
            let targetMult = 3.0;
            if (strat.name === 'ShortBounceEOD' && regime.marketState === 'HIGH_VOL') {
                targetMult = runtime_1.STRATEGY_V11.HIGH_VOL_SHORT_TARGET_ATR;
            }
            const signal = {
                symbol,
                direction: strat.direction,
                strategy: strat.name,
                score: Math.max(0, Math.min(100, Math.round(strat.baseScore))),
                features,
                entryPlan: { type: 'NEXT_OPEN' },
                indicativeStopPrice: strat.direction === 'BUY' ? currentClose - (atr * stopMult) : currentClose + (atr * stopMult),
                indicativeTargets: [strat.direction === 'BUY' ? currentClose + (atr * targetMult) : currentClose - (atr * targetMult)],
                indicativeRr: targetMult / stopMult,
                checklist: { regimeAligned: true, indicatorMatch: true },
                reasons: { rsi, close: currentClose, ema20, ema50, marketState: regime.marketState, v11: true },
                status: 'NEW',
                atrRef: atr,
                stopAtrMult: stopMult,
                targetAtrMult: targetMult
            };
            const signalId = `${symbol}_${dateId}_${strat.name}`;
            await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
        }
    }
    catch (err) {
        status = 'ERROR';
        reason = err.message || String(err);
        console.error(`[Strategy] Error for ${symbol}:`, err);
    }
    finally {
        await sentinelRef.set({
            status,
            reason,
            completedAt: admin.firestore.Timestamp.now(),
            jobId
        }, { merge: true });
    }
}
exports.evaluateSignalsTask = functionsV1.https.onRequest(async (req, res) => {
    const { jobId, symbol, runDate } = req.body || {};
    if (!jobId || !symbol || !runDate) {
        res.status(400).send('Missing required fields: jobId, symbol, runDate');
        return;
    }
    try {
        await doEvaluateSignals(String(jobId), String(symbol), String(runDate));
        res.status(200).send('Signals evaluated');
    }
    catch (error) {
        console.error(`Failed to evaluate signals for ${symbol}:`, error);
        res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
    }
});
//# sourceMappingURL=strategy.js.map