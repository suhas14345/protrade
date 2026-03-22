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
exports.computeRegimeTask = void 0;
exports.doComputeRegime = doComputeRegime;
const functionsV1 = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const toDateId = (date) => date.replace(/-/g, '');
async function getLatestBarOnOrBefore(db, symbol, dateId) {
    const snap = await db
        .collection('barsD')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'asc') // Use ASC to avoid DESC scan issues in emulator
        .get();
    if (snap.empty)
        return null;
    const doc = snap.docs[snap.docs.length - 1]; // Take the last (most recent)
    return Object.assign({ id: doc.id }, doc.data());
}
async function getEma200SlopeNeg(db, symbol, dateId, lookbackBars = 20) {
    // Try to infer slope of EMA200 using historical feature snapshots
    // slopeNeg = ema200(t) - ema200(t-lookback) < 0
    const snap = await db
        .collection('features')
        .doc(symbol)
        .collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
        .get();
    if (snap.empty || snap.size < lookbackBars + 1)
        return null;
    const docs = snap.docs.slice(-(lookbackBars + 1)); // oldest -> newest
    const first = docs[0].data();
    const last = docs[docs.length - 1].data();
    const ema200First = Number(first.ema200);
    const ema200Last = Number(last.ema200);
    if (!Number.isFinite(ema200First) || !Number.isFinite(ema200Last))
        return null;
    return (ema200Last - ema200First) < 0;
}
/**
 * HTTP Trigger to compute the Market Regime for the universe.
 */
async function doComputeRegime(date, jobId, providedIndexSymbol) {
    var _a, _b;
    const db = getDb();
    const dateId = toDateId(date);
    console.log(`Computing Market Regime for ${date}`);
    // 1. Fetch Index Features (Default to NIFTY 50 if providedIndexSymbol is missing but it's a Kite run)
    // We'll check settings to decide the best default
    let indexSymbol = providedIndexSymbol;
    if (!indexSymbol) {
        const settingsSnap = await db.collection('settings').doc('kite').get();
        const settings = settingsSnap.data();
        indexSymbol = (settings === null || settings === void 0 ? void 0 : settings.accessToken) ? 'NIFTY 50' : '^NSEI';
    }
    const dateObj = new Date(date + 'T00:00:00Z'); // Force UTC
    const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 6 = Saturday
    let checkDates = [dateId];
    if (dayOfWeek === 6) { // Saturday -> check Friday
        const fri = new Date(dateObj.getTime() - 86400000);
        checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
    }
    else if (dayOfWeek === 0) { // Sunday -> check Friday
        const fri = new Date(dateObj.getTime() - 2 * 86400000);
        checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
    }
    let indexFeatSnap = null;
    let effectiveDateId = dateId;
    for (const dId of checkDates) {
        const snap = await db.collection('features').doc(indexSymbol).collection('days').doc(dId).get();
        if (snap.exists) {
            indexFeatSnap = snap;
            effectiveDateId = dId;
            await logger_1.logger.info(`[Regime] Found effective features on ${dId}`, 'Regime', { jobId, indexSymbol, dId });
            break;
        }
    }
    if (!indexFeatSnap) {
        // Ultimate fallback if checkDates missed
        indexFeatSnap = await db.collection('features').doc(indexSymbol).collection('days').doc(dateId).get();
        effectiveDateId = dateId;
    }
    // Also fetch the latest bar on/before dateId
    const latestIndexBar = await getLatestBarOnOrBefore(db, indexSymbol, dateId);
    // Default: safest stance when something is missing is "no trade"
    let marketState = 'TRANSITION';
    let riskMultiplier = 0.0;
    let notes = `Computing regime for ${indexSymbol} on ${date} (using ${effectiveDateId})`;
    if (indexFeatSnap && latestIndexBar) {
        const feat = indexFeatSnap.data();
        const ema20 = Number(feat.ema20);
        const ema50 = Number(feat.ema50);
        const ema200 = Number(feat.ema200);
        const atrp = Number(feat.atrp);
        const atrpMa100 = Number(feat.atrpMa100);
        const trendState = String(feat.trendState || '');
        const currentClose = Number(latestIndexBar.close);
        // Validate critical fields
        const hasEma200 = Number.isFinite(ema200) && ema200 > 0;
        const hasVol = Number.isFinite(atrp) && Number.isFinite(atrpMa100) && atrpMa100 > 0;
        const hasClose = Number.isFinite(currentClose) && currentClose > 0;
        // Bearish determination (Short-term or Long-term)
        const isEma200Bear = hasClose && hasEma200 && currentClose < ema200;
        const isEmaTrendBear = ema20 > 0 && ema50 > 0 && ema20 < ema50;
        // Optional: EMA200 slope check (if history exists)
        const ema200SlopeNeg = await getEma200SlopeNeg(db, indexSymbol, effectiveDateId, 20);
        // Determine regime with deterministic precedence.
        if (isEma200Bear && (ema200SlopeNeg !== null && ema200SlopeNeg !== void 0 ? ema200SlopeNeg : true)) {
            marketState = 'BEAR';
            riskMultiplier = 0.5;
            notes =
                ema200SlopeNeg === null
                    ? 'Index below EMA200. (EMA200 slope unavailable; using position only.)'
                    : 'Index below EMA200 with negative EMA200 slope. Long-term bearish bias active.';
        }
        else if (isEmaTrendBear) {
            marketState = 'BEAR';
            riskMultiplier = 0.75; // More lenient for short-term bear
            notes = 'Index EMA20 < EMA50. Short-term bearish trend active.';
        }
        else if (hasVol && atrp > 1.5 * atrpMa100) {
            marketState = 'HIGH_VOL';
            riskMultiplier = 0.5;
            notes = 'Volatility spike detected on Index.';
        }
        else if (trendState === 'UP') {
            marketState = 'TREND';
            riskMultiplier = 1.0;
            notes = 'Index in confirmed uptrend.';
        }
        else {
            marketState = 'RANGE';
            riskMultiplier = 1.0;
            notes = 'Default range regime.';
        }
    }
    else {
        const errorParts = [];
        if (!indexFeatSnap) {
            errorParts.push(`Features missing for ${indexSymbol}`);
        }
        if (!latestIndexBar) {
            errorParts.push(`Latest bar missing for ${indexSymbol}`);
        }
        const errorMsg = `[Regime Fail] ${errorParts.join(' & ')} on ${date}. Cannot proceed safely.`;
        await logger_1.logger.error(errorMsg, 'Regime', { jobId, indexSymbol, date, dateId });
        // Save a transition regime so the system knows we tried but failed due to missing data
        const failRegime = {
            marketState: 'TRANSITION',
            tradeAllowed: false,
            riskMultiplier: 0,
            maxNewPositions: 0,
            minSignalScore: 100,
            notes: errorMsg
        };
        await db.collection('regime').doc(dateId).set(failRegime);
        throw new Error(errorMsg);
    }
    const regimeDoc = {
        marketState,
        tradeAllowed: true, // Data exists, so trading is theoretically allowed (subject to regime details)
        riskMultiplier,
        // Tighter max positions during stress
        maxNewPositions: marketState === 'BEAR' || marketState === 'HIGH_VOL' ? 2 : 5,
        // Keep constant for now; you can later adjust per regime/strategy
        minSignalScore: 60,
        notes,
        reason: notes, // Consistent with reporting.ts
        metrics: {
            close: Number(latestIndexBar.close),
            ema200: (_a = indexFeatSnap.data()) === null || _a === void 0 ? void 0 : _a.ema200,
            ema200Slope: await getEma200SlopeNeg(db, indexSymbol, effectiveDateId, 20) === true ? -0.01 : 0.01, // Mock slope value for display
            ema20: (_b = indexFeatSnap.data()) === null || _b === void 0 ? void 0 : _b.ema20,
        },
        // Placeholder breadth – recommend making these null/derived later
        breadth: {
            pctAboveEMA50: 65,
            pctAboveEMA200: 70,
            newHighs20: 45,
            newLows20: 5
        }
    };
    await db.collection('regime').doc(dateId).set(regimeDoc);
    if (jobId) {
        await db.collection('jobs').doc(jobId).update({
            marketState: marketState,
            updatedAt: admin.firestore.Timestamp.now()
        });
    }
    return regimeDoc;
}
exports.computeRegimeTask = functionsV1.https.onRequest(async (req, res) => {
    const { date, jobId } = req.query;
    if (!date || typeof date !== 'string') {
        res.status(400).send('Missing "date" parameter');
        return;
    }
    try {
        const regimeDoc = await doComputeRegime(date, typeof jobId === 'string' ? jobId : undefined);
        res.status(200).send({ message: 'Regime computed', regimeDoc });
    }
    catch (error) {
        console.error('Failed to compute regime:', error);
        res.status(500).send('Internal Error');
    }
});
//# sourceMappingURL=regime.js.map