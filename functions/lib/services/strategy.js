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
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const toDateId = (date) => date.replace(/-/g, '');
async function getRecentBarsOnOrBefore(db, symbol, dateId, limit) {
    const snap = await db
        .collection('barsD')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .get();
    if (snap.empty)
        return [];
    // Emulator might not support desc, so we sort in memory
    return snap.docs
        .map(d => (Object.assign({ id: d.id }, d.data())))
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(-limit);
}
function isFinitePos(n) {
    const x = Number(n);
    return Number.isFinite(x) && x > 0;
}
/**
 * Evaluate strategies and generate signals for a symbol.
 */
async function doEvaluateSignals(jobId, symbol, runDate) {
    var _a, _b, _c;
    const db = getDb();
    const dateId = toDateId(runDate);
    // Optimization: Skip if signals already exist for this symbol/date
    // We check for one known strategy ID to infer if evaluation already happened
    const checkId = `${symbol}_${dateId}_PullbackEOD`;
    const existingSig = await db.collection('signals').doc(dateId).collection('items').doc(checkId).get();
    if (existingSig.exists) {
        console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Signals for ${runDate} already exist. Skipping.`);
        return;
    }
    console.log(`[Job ${jobId}] Evaluating signals for ${symbol} on ${runDate}`);
    // 1. Load Features (must exist for the exact run date)
    const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
    if (!featSnap.exists) {
        await logger_1.logger.warn(`Features not found for ${symbol} on ${runDate}`, 'Strategy', { jobId, symbol });
        return;
    }
    const features = featSnap.data();
    // 2. Load Regime
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    if (!regimeSnap.exists) {
        await logger_1.logger.warn(`Regime not found for ${runDate}`, 'Strategy', { jobId });
        return;
    }
    const regime = regimeSnap.data();
    if (!regime.tradeAllowed) {
        console.log(`Trading disabled for ${runDate} (marketState=${regime.marketState}). Skipping ${symbol}.`);
        return;
    }
    // 3. Load enough bars for all strategies (breakout needs 21)
    const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
    if (bars.length === 0) {
        await logger_1.logger.warn(`No bars found for ${symbol} on or before ${runDate}`, 'Strategy', { jobId, symbol });
        return;
    }
    // Prevent feature/bar mismatch: require the bar for dateId to exist.
    // If your ingestion is always aligned, this is a strong safety check.
    const lastBar = bars[bars.length - 1];
    (0, safety_1.checkSafety)(lastBar);
    if (lastBar.id > dateId) {
        await logger_1.logger.error(`Latest bar for ${symbol} is ${lastBar.id}, which is AFTER ${dateId}. Data integrity error; skipping.`, 'Strategy', { jobId, symbol });
        return;
    }
    if (lastBar.id < dateId) {
        console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Using latest available bar ${lastBar.id} for run date ${dateId} (Weekend/Holiday).`);
    }
    // 4. Extract key indicators with safety guards
    const ema20 = Number(features.ema20);
    const ema50 = Number(features.ema50);
    const rsi = Number((_c = (_b = (_a = features.rsi14) !== null && _a !== void 0 ? _a : features.rsi14) !== null && _b !== void 0 ? _b : features.rsi) !== null && _c !== void 0 ? _c : 50);
    const atr = Number(features.atr14);
    const bbLower = Number(features.bbLower);
    const currentClose = Number(lastBar.close);
    // If critical indicators are missing, don't evaluate.
    if (!isFinitePos(currentClose) || !isFinitePos(ema20) || !isFinitePos(ema50) || !Number.isFinite(rsi) || !isFinitePos(atr)) {
        await logger_1.logger.warn(`Missing/invalid indicators for ${symbol} on ${runDate}. Skipping.`, 'Strategy', { jobId, symbol });
        return;
    }
    const touchedEmaBand = () => {
        const lower = Math.min(ema20, ema50);
        const upper = Math.max(ema20, ema50);
        // "Touch" means the candle range intersects the band
        const touched = (Number(lastBar.low) <= upper) && (Number(lastBar.high) >= lower);
        // Near EMA20 based on close distance
        const nearEma20 = Math.abs(currentClose - ema20) / ema20 <= 0.005;
        return touched || nearEma20;
    };
    // 4b. Weekly Bias Check
    let weeklyTrendOk = true;
    if (runtime_1.RUNTIME_CONFIG.USE_WEEKLY_BIAS) {
        const date = new Date(runDate);
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
        const weekId = `${d.getUTCFullYear()}${weekNo.toString().padStart(2, '0')}`;
        const weeklyFeatSnap = await db.collection('features').doc(symbol).collection('weeks').where(admin.firestore.FieldPath.documentId(), '<=', weekId).limit(1).get();
        if (!weeklyFeatSnap.empty) {
            const weeklyFeat = weeklyFeatSnap.docs[0].data();
            const wEma20 = weeklyFeat.ema20 || 0;
            const wEma50 = weeklyFeat.ema50 || 0;
            weeklyTrendOk = wEma20 > wEma50;
        }
    }
    // 5. Strategy conditions (as per your description)
    // A) PullbackEOD (Bullish / Trend Following)
    const isLongPullback = (regime.marketState === 'TREND' || regime.marketState === 'RANGE') &&
        ema20 > ema50 &&
        touchedEmaBand() &&
        rsi >= 40 && rsi <= 55;
    // B) BreakoutCloseEOD (Bullish / Momentum)
    // Needs at least 21 bars to compute previous 20-day high excluding today
    let isBreakout = false;
    if (regime.marketState === 'TREND' && ema20 > ema50 && bars.length >= 21) {
        const prev20 = bars.slice(-21, -1); // excludes today
        const prev20High = Math.max(...prev20.map(b => Number(b.high)));
        isBreakout = currentClose > prev20High;
    }
    // C) MeanReversionEOD (Bullish / Contrarian)
    const isMeanReversion = regime.marketState === 'RANGE' &&
        isFinitePos(bbLower) &&
        currentClose < bbLower &&
        rsi < 30;
    // D) ShortBounceEOD (Bearish / Trend Following)
    const isShortBounce = (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') &&
        ema20 < ema50 &&
        touchedEmaBand() &&
        rsi >= 45 && rsi <= 65;
    // 6. Create signals for all active strategies (monitoring mode)
    const activeStrategies = [
        { condition: isLongPullback && weeklyTrendOk, name: 'PullbackEOD', direction: 'BUY' },
        { condition: isShortBounce, name: 'ShortBounceEOD', direction: 'SELL' },
        { condition: isBreakout && weeklyTrendOk, name: 'BreakoutCloseEOD', direction: 'BUY' },
        { condition: isMeanReversion && weeklyTrendOk, name: 'MeanReversionEOD', direction: 'BUY' },
    ].filter(s => s.condition);
    if (activeStrategies.length === 0)
        return;
    for (const strat of activeStrategies) {
        const score = 80;
        // honor regime min score gate if present
        if (typeof regime.minSignalScore === 'number' && score < regime.minSignalScore) {
            continue;
        }
        const stopPrice = strat.direction === 'BUY'
            ? currentClose - (atr * 2)
            : currentClose + (atr * 2);
        const targetPrice = strat.direction === 'BUY'
            ? currentClose + (atr * 3)
            : currentClose - (atr * 3);
        const signal = {
            symbol,
            direction: strat.direction,
            strategy: strat.name,
            score,
            features: features,
            // You’re using NEXT_OPEN; for production you may want to compute stop/targets off fill.
            entryPlan: { type: 'NEXT_OPEN' },
            stopPrice,
            targets: [targetPrice],
            rr: 1.5,
            checklist: { regimeAligned: true, indicatorMatch: true },
            reasons: {
                rsi,
                close: currentClose,
                ema20,
                ema50,
                marketState: regime.marketState
            },
            status: 'NEW',
            // If your Signal model allows extra fields, these are useful:
            // createdAt: admin.firestore.Timestamp.now(),
            // runDateId: dateId,
            // riskMultiplierAtSignal: regime.riskMultiplier
        };
        const signalId = `${symbol}_${dateId}_${strat.name}`;
        await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
        await logger_1.logger.info(`Generated ${strat.name} signal for ${symbol} at ${currentClose}`, 'Strategy', { jobId, symbol });
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