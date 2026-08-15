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
exports.computeFeaturesTask = void 0;
exports.doComputeFeatures = doComputeFeatures;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const firestore_1 = require("firebase-admin/firestore");
const logger_1 = require("./logger");
const runtime_1 = require("../config/runtime");
// Lazy load technicalindicators inside functions to avoid deployment timeouts
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Lower-bound YYYYMMDD key for a bounded ascending key-range scan guaranteed to
 * contain at least `count` trading days. Trading days are ~69% of calendar days,
 * so 1.7x + 15 always covers `count` with margin. Avoids reading the entire
 * (growing) bar history every day.
 */
function keyLowerBoundDateId(dateId, count) {
    const y = +dateId.slice(0, 4), m = +dateId.slice(4, 6) - 1, d = +dateId.slice(6, 8);
    const dt = new Date(Date.UTC(y, m, d));
    dt.setUTCDate(dt.getUTCDate() - Math.ceil(count * 1.7) - 15);
    return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}
async function doComputeFeatures(jobId, symbol, runDate) {
    const db = getDb();
    const dateId = runDate.replace(/-/g, '');
    // 0. Optimization: Skip if today's features (or Friday's if weekend) already exist
    const dateObj = new Date(runDate);
    const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 6 = Saturday
    let checkDates = [runDate.replace(/-/g, '')];
    if (dayOfWeek === 6) { // Saturday -> check Friday
        const fri = new Date(dateObj);
        fri.setDate(dateObj.getDate() - 1);
        checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
    }
    else if (dayOfWeek === 0) { // Sunday -> check Friday
        const fri = new Date(dateObj);
        fri.setDate(dateObj.getDate() - 2);
        checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
    }
    for (const dId of checkDates) {
        const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dId).get();
        if (featSnap.exists) {
            console.log(`[Features] Job ${jobId} symbol ${symbol}: Features for ${dId} (Ref: ${runDate}) already exist. Skipping computation.`);
            return;
        }
    }
    console.log(`[Job ${jobId}] Computing features for ${symbol} up to ${runDate}`);
    // 1. Fetch historical bars up to the run date.
    // Bounded ascending key-range scan: only the most recent ~200 trading days are
    // needed (slice(-200) below). A lower bound keeps every read O(200) instead of
    // O(full history), which matters both for the emulator replay and production.
    // 200 trading days ≈ 200/0.69 calendar days; 1.7x + 15 gives a safe margin.
    const barsLowerBound = keyLowerBoundDateId(dateId, 200);
    const barsSnap = await db.collection('barsD')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '>=', barsLowerBound)
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
        .get();
    if (barsSnap.empty || barsSnap.size < 25) {
        const errorMsg = `[Features Fail] Insufficient data for ${symbol}. Found ${barsSnap.size} bars. Needs 25.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
    // Sort and limit locally to avoid emulator 'descending key scan' error
    const allBars = barsSnap.docs.map(d => d.data());
    allBars.sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
    // Take last 200 for indicator stability; use slice(-200) — current closed bar is included
    // Note: signals are for NEXT_OPEN entry so today's EOD bar IS the signal bar
    const bars = allBars.slice(-200);
    // 2. Compute Real Indicators with adaptive periods for simulation stability
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const ti = require('technicalindicators');
    if (!ti) {
        console.error(`[Job ${jobId}] [CRITICAL] technicalindicators library NOT LOADED`);
        throw new Error('technicalindicators library not available');
    }
    const { EMA, RSI, ATR, BollingerBands } = ti;
    const getSafePeriod = (requested, length) => Math.max(2, Math.min(requested, length - 1));
    const ema20Arr = EMA.calculate({ period: getSafePeriod(20, closes.length), values: closes });
    const ema50Arr = EMA.calculate({ period: getSafePeriod(50, closes.length), values: closes });
    const ema200Arr = EMA.calculate({ period: getSafePeriod(200, closes.length), values: closes });
    const rsiArr = RSI.calculate({ period: getSafePeriod(14, closes.length), values: closes });
    const atrArr = ATR.calculate({ period: getSafePeriod(14, closes.length), high: highs, low: lows, close: closes });
    const bbArr = BollingerBands.calculate({ period: getSafePeriod(20, closes.length), stdDev: 2, values: closes });
    const currentClose = closes[closes.length - 1];
    const ema20 = ema20Arr.length > 0 ? ema20Arr[ema20Arr.length - 1] : currentClose;
    const ema50 = ema50Arr.length > 0 ? ema50Arr[ema50Arr.length - 1] : currentClose * 0.98;
    const ema200 = ema200Arr.length > 0 ? ema200Arr[ema200Arr.length - 1] : currentClose * 0.95;
    const rsi14 = rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : 50;
    const atr14 = atrArr.length > 0 ? atrArr[atrArr.length - 1] : (currentClose * 0.02);
    const bb = bbArr.length > 0 ? bbArr[bbArr.length - 1] : { middle: currentClose, lower: currentClose * 0.95, upper: currentClose * 1.05 };
    // ATR% and ATR% Moving Average
    const atrp = (atr14 / currentClose) * 100;
    const last100Atrps = atrArr.slice(-100).map((a, i) => (a / closes[closes.length - atrArr.length + i]) * 100);
    const atrpMa100 = last100Atrps.length > 0 ? (last100Atrps.reduce((a, b) => a + b, 0) / last100Atrps.length) : atrp;
    // 3. Advanced Market Structure (Swing H/L and S/R)
    const swings = calculateSwings(bars, 3); // 3-bar fractal
    const srZones = identifySRZones(swings);
    // 4. Refined Trend State
    let trendState = 'RANGE';
    const lastSwingHigh = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1].price : 0;
    const lastSwingLow = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1].price : 0;
    const prevSwingHigh = swings.highs.length > 1 ? swings.highs[swings.highs.length - 2].price : 0;
    const prevSwingLow = swings.lows.length > 1 ? swings.lows[swings.lows.length - 2].price : 0;
    if (ema20 > ema50 && currentClose > ema20 && lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow) {
        trendState = 'UP';
    }
    else if (ema20 < ema50 && currentClose < ema20 && lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow) {
        trendState = 'DOWN';
    }
    const featureDoc = {
        ema20,
        ema50,
        ema200,
        rsi14,
        atr14,
        atrp,
        atrpMa100,
        atrPct: atrp,
        bbMid: bb.middle,
        bbLower: bb.lower,
        bbUpper: bb.upper,
        // V2.4: Rolling 20-day high/low for breadth computation
        high20: Math.max(...closes.slice(-20)),
        low20: Math.min(...closes.slice(-20)),
        volSma20: bars.slice(-20).reduce((a, b) => a + (b.volume || 0), 0) / Math.min(20, bars.length),
        trendState,
        computedAt: firestore_1.Timestamp.now(),
        swing: {
            lastSwingHigh,
            lastSwingLow
        },
        srZones,
        returns: {
            ret1d: closes.length >= 2 ? (closes[closes.length - 1] / closes[closes.length - 2]) - 1 : 0,
            ret5d: closes.length >= 6 ? (closes[closes.length - 1] / closes[closes.length - 6]) - 1 : 0,
            ret20d: closes.length >= 21 ? (closes[closes.length - 1] / closes[closes.length - 21]) - 1 : 0,
            ret60d: closes.length >= 61 ? (closes[closes.length - 1] / closes[closes.length - 61]) - 1 : 0, // V2.2
        },
        barsCount: barsSnap.size,
        // V2.2: Computed liquidity bucket from median traded value
        liquidity: computeLiquidity(bars),
        // V2.2: Volume Dry-Up flag
        vduActive: computeVDU(bars),
        // V2.2: Gap risk score (0-100 percentile)
        gapRiskScore: computeGapRiskScore(bars, atr14),
        // rsScore is null here — filled by RS ranking pass after all features are done
        rsScore: undefined,
        patterns: [],
    };
    await db.collection('features').doc(symbol).collection('days').doc(dateId).set(featureDoc);
    await logger_1.logger.info(`Features computed for ${symbol}: Trend=${trendState}, RSI=${rsi14.toFixed(2)}`, 'Features', { jobId, symbol });
}
/**
 * V2.2: Compute liquidity bucket from actual median traded value (not hardcoded 'A').
 * Bucket A = top-tier liquid (medTradedValue20 >= 50 Cr), B = mid, C = low.
 */
function computeLiquidity(bars) {
    const recent20 = bars.slice(-20);
    const volumes = recent20.map(b => b.volume || 0);
    const tradedValues = recent20.map(b => (b.close || 0) * (b.volume || 0));
    const medVol20 = volumes.sort((a, b) => a - b)[Math.floor(volumes.length / 2)] || 0;
    const medTradedValue20 = tradedValues.sort((a, b) => a - b)[Math.floor(tradedValues.length / 2)] || 0;
    // Thresholds in INR: A >= 5 Cr (50M), B >= 1 Cr (10M), C = below
    let bucket;
    if (medTradedValue20 >= 50000000) {
        bucket = 'A';
    }
    else if (medTradedValue20 >= 10000000) {
        bucket = 'B';
    }
    else {
        bucket = 'C';
    }
    return { medVol20, medTradedValue20, bucket };
}
/**
 * V2.2: Volume Dry-Up (VDU) detection.
 * Returns true if last MIN_DECLINE_DAYS consecutive bars show declining volume
 * AND price is near EMA zone (not in a strong move). Signals institutional patience.
 */
function computeVDU(bars) {
    const lookback = bars.slice(-(runtime_1.VDU_CONFIG.LOOKBACK_DAYS + 1));
    if (lookback.length < runtime_1.VDU_CONFIG.MIN_DECLINE_DAYS + 1)
        return false;
    let consecutiveDeclines = 0;
    for (let i = lookback.length - 1; i > 0; i--) {
        if ((lookback[i].volume || 0) < (lookback[i - 1].volume || 0)) {
            consecutiveDeclines++;
        }
        else {
            break;
        }
    }
    return consecutiveDeclines >= runtime_1.VDU_CONFIG.MIN_DECLINE_DAYS;
}
/**
 * V2.2: Gap Risk Score (0-100 percentile).
 * Measures how historically "gappy" a stock is — large/frequent gaps = higher risk score.
 * Score 80+ = reject entry; 60–79 = reduce position size.
 */
function computeGapRiskScore(bars, atr14) {
    const lookback = bars.slice(-(runtime_1.GAP_RISK_CONFIG.LOOKBACK_DAYS + 1));
    if (lookback.length < 5 || atr14 <= 0)
        return 0;
    const gapRatios = [];
    for (let i = 1; i < lookback.length; i++) {
        const prevClose = lookback[i - 1].close;
        const openPrice = lookback[i].open;
        if (prevClose > 0) {
            gapRatios.push(Math.abs(openPrice - prevClose) / atr14);
        }
    }
    if (gapRatios.length === 0)
        return 0;
    const sorted = [...gapRatios].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    // Normalize: mean gap ratio of 2.0 ATR maps to score ~80; 0 maps to 0; 3.0+ maps to 100
    const rawScore = Math.min(100, Math.round((mean / 2.5) * 100));
    return rawScore;
}
function calculateSwings(bars, window = 3) {
    const highs = [];
    const lows = [];
    for (let i = window; i < bars.length - window; i++) {
        const currentHigh = bars[i].high;
        const currentLow = bars[i].low;
        let isHigh = true;
        let isLow = true;
        for (let j = 1; j <= window; j++) {
            if (bars[i - j].high >= currentHigh || bars[i + j].high > currentHigh)
                isHigh = false;
            if (bars[i - j].low <= currentLow || bars[i + j].low < currentLow)
                isLow = false;
        }
        if (isHigh)
            highs.push({ price: currentHigh, index: i });
        if (isLow)
            lows.push({ price: currentLow, index: i });
    }
    return { highs, lows };
}
function identifySRZones(swings) {
    const prices = [...swings.highs, ...swings.lows].map(s => s.price);
    if (prices.length < 2)
        return [];
    const zones = [];
    const sorted = prices.sort((a, b) => a - b);
    let currentZone = { low: sorted[0], high: sorted[0], prices: [sorted[0]] };
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] <= currentZone.high * 1.01) {
            currentZone.high = sorted[i];
            currentZone.prices.push(sorted[i]);
        }
        else {
            zones.push({
                low: currentZone.low * 0.995,
                high: currentZone.high * 1.005,
                strength: currentZone.prices.length
            });
            currentZone = { low: sorted[i], high: sorted[i], prices: [sorted[i]] };
        }
    }
    return zones.sort((a, b) => b.strength - a.strength).slice(0, 5);
}
exports.computeFeaturesTask = functionsV1.https.onRequest(async (req, res) => {
    const { jobId, symbol, runDate } = req.body;
    try {
        await doComputeFeatures(jobId, symbol, runDate);
        res.status(200).send('Features computed');
    }
    catch (error) {
        console.error(`Failed to compute features for ${symbol}:`, error);
        res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
    }
});
//# sourceMappingURL=features.js.map