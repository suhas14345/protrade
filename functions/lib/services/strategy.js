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
const calendar_1 = require("./calendar");
const eventCalendar_1 = require("./eventCalendar");
const logger_1 = require("./logger");
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
    if (!vsma || vsma <= 0)
        return false;
    return v >= runtime_1.STRATEGY_V11.BREAKOUT_VOL_MULT * vsma;
}
/**
 * Helper: V1.1 Trend Neutrality
 */
function isTrendNeutral(close, ema20, ema50) {
    return (Math.abs(ema20 - ema50) / close) < runtime_1.STRATEGY_V11.RANGE_TREND_NEUTRAL_MAX;
}
/**
 * Helper: V1.1 Earnings Block — V2.3 now delegates to EventCalendarService
 * Kept for backward compat but extended with strategy-aware windows.
 */
async function isEntryBlockedByEvents(symbol, runDateId, strategy) {
    return eventCalendar_1.EventCalendarService.checkEntryBlock(symbol, runDateId, strategy);
}
/**
 * V2.3: ADV (Average Daily Volume) check — cap position as % of daily volume.
 */
function computeAdvCheck(features, sizedQty, price) {
    var _a;
    const medVol20 = ((_a = features.liquidity) === null || _a === void 0 ? void 0 : _a.medVol20) || 0;
    const maxQtyByAdv = medVol20 > 0 ? Math.floor(medVol20 * runtime_1.ADV_LIMITS.MAX_ADV_PCT) : sizedQty;
    const minOrderValue = runtime_1.ADV_LIMITS.MIN_ORDER_VALUE_INR;
    const minQtyByValue = price > 0 ? Math.ceil(minOrderValue / price) : 0;
    let cappedQty = Math.min(sizedQty, maxQtyByAdv);
    const capped = cappedQty < sizedQty;
    // Ensure minimum order value
    if (cappedQty * price < minOrderValue && sizedQty >= minQtyByValue) {
        cappedQty = minQtyByValue;
    }
    return { medVol20, maxQtyByAdv, capped, cappedQty };
}
/**
 * V2.3: Gap stress test — estimate worst-case overnight gap loss.
 */
function computeGapStress(atrAtEntry, qty, price, riskAmount) {
    const stressGap = runtime_1.GAP_STRESS_CONFIG.STRESS_GAP_ATR_MULT * atrAtEntry;
    const worstCaseLossInr = stressGap * qty;
    const worstCaseLossR = riskAmount > 0 ? worstCaseLossInr / riskAmount : 0;
    return { worstCaseLossInr, worstCaseLossR };
}
/**
 * Optimized Historical Bar Fetch
 */
async function getRecentBarsOnOrBefore(db, symbol, dateId, limit) {
    const snap = await db.collection('barsD').doc(symbol).collection('days')
        .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
        .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
        .limit(limit).get();
    if (snap.empty)
        return [];
    return snap.docs.map(d => (Object.assign({ id: d.id }, d.data()))).reverse();
}
/**
 * V2.2: Compute drawdown multiplier from peak equity.
 * Returns { multiplier, shouldHalt, drawdownPct }.
 */
function computeDrawdownMultiplier(account) {
    const equity = account.equity;
    const peakEquity = account.peakEquity || equity;
    const equityEMA25 = account.equityEMA25;
    const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    let multiplier;
    if (drawdownPct >= runtime_1.DRAWDOWN_CONFIG.HALT_AT_PCT) {
        return { multiplier: 0, shouldHalt: true, drawdownPct };
    }
    else if (drawdownPct >= runtime_1.DRAWDOWN_CONFIG.DD_15_PCT) {
        multiplier = runtime_1.DRAWDOWN_CONFIG.MULT_15_TO_20;
    }
    else if (drawdownPct >= runtime_1.DRAWDOWN_CONFIG.DD_10_PCT) {
        multiplier = runtime_1.DRAWDOWN_CONFIG.MULT_10_TO_15;
    }
    else if (drawdownPct >= runtime_1.DRAWDOWN_CONFIG.DD_5_PCT) {
        multiplier = runtime_1.DRAWDOWN_CONFIG.MULT_5_TO_10;
    }
    else {
        multiplier = runtime_1.DRAWDOWN_CONFIG.MULT_0_TO_5;
    }
    // Equity curve filter: halve size if equity is below its 25-day EMA
    if (equityEMA25 && equity < equityEMA25) {
        multiplier *= runtime_1.DRAWDOWN_CONFIG.EQUITY_EMA_MULT;
    }
    return { multiplier, shouldHalt: false, drawdownPct };
}
/**
 * V2.2: Compute dynamic signal score based on RS, VDU, regime, and liquidity.
 */
function computeDynamicScore(baseScore, features, regime, strategyName) {
    var _a, _b;
    let score = baseScore;
    // Regime adjustment
    if (regime.marketState === 'TREND')
        score += 5;
    else if (regime.marketState === 'HIGH_VOL')
        score -= 10;
    // V3.1: BEAR regime scoring — shorts and bear-specific strategies get a boost
    else if (regime.marketState === 'BEAR') {
        if (strategyName === 'ShortBounceEOD')
            score += 5;
        else if (strategyName === 'BearBounceEOD')
            score += 0; // Neutral — base score is already calibrated
        else if (strategyName === 'RSLeaderEOD')
            score += 5; // Leaders in BEAR deserve extra credit
        else
            score -= 5; // Penalize generic longs in BEAR
    }
    // RS score boost
    const rsScore = (_a = features.rsScore) !== null && _a !== void 0 ? _a : 50;
    if (rsScore >= runtime_1.RS_CONFIG.ELITE_THRESHOLD)
        score += 10;
    else if (rsScore >= runtime_1.RS_CONFIG.BOOST_THRESHOLD)
        score += 5;
    // V3.1: Inverse RS boost for shorts — weak stocks are better short candidates
    if (strategyName === 'ShortBounceEOD' && rsScore <= 20)
        score += 5;
    // VDU boost (only meaningful on pullback — signals institutional patience)
    if (features.vduActive && (strategyName === 'PullbackEOD' || strategyName === 'RSLeaderEOD')) {
        score += runtime_1.VDU_CONFIG.SCORE_BOOST;
    }
    // Liquidity penalty for bucket C
    if (((_b = features.liquidity) === null || _b === void 0 ? void 0 : _b.bucket) === 'C')
        score -= 5;
    return Math.max(0, Math.min(100, score));
}
/**
 * Consolidated Risk Approval Logic (V2.3 — with vol-targeting, ADV limits, gap stress)
 */
async function doRiskApproval(signal, account, regime, openPositions, sessionApprovals, dateId, universeId = 'nifty500') {
    var _a, _b, _c, _d, _e, _f, _g;
    const db = getDb();
    // 1. Symbol Meta (Sector + Liquidity Bucket)
    const symbolMetaSnap = await db.collection('universes').doc(universeId).collection('members').doc(signal.symbol).get();
    const sector = symbolMetaSnap.exists ? symbolMetaSnap.data().sector : 'UNKNOWN';
    // 2. Sizing: ATR-based stop distance
    const atrRef = signal.atrRef || ((_a = signal.features) === null || _a === void 0 ? void 0 : _a.atr14) || 0;
    const stopMult = signal.stopAtrMult || 2.0;
    const stopDistance = atrRef * stopMult;
    if (stopDistance <= 0) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: 'Invalid stop distance' }, status: 'REJECTED_BY_RISK' };
    }
    // 3. V3.1: Strategy-aware RS Filter — different strategies have different RS needs
    const rsScore = (_c = (_b = signal.features) === null || _b === void 0 ? void 0 : _b.rsScore) !== null && _c !== void 0 ? _c : 50;
    const rsThresholds = runtime_1.RS_STRATEGY_THRESHOLDS[signal.strategy] || { min: runtime_1.RS_CONFIG.MIN_RS_SCORE, max: 100 };
    if (rsScore < rsThresholds.min) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `RS score ${rsScore} below strategy min ${rsThresholds.min} (${signal.strategy})` }, status: 'REJECTED_BY_RISK' };
    }
    if (rsScore > rsThresholds.max) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `RS score ${rsScore} above strategy max ${rsThresholds.max} — too strong to short (${signal.strategy})` }, status: 'REJECTED_BY_RISK' };
    }
    // 4. V2.2: Gap Risk Gate
    const gapRiskScore = (_e = (_d = signal.features) === null || _d === void 0 ? void 0 : _d.gapRiskScore) !== null && _e !== void 0 ? _e : 0;
    if (gapRiskScore >= runtime_1.GAP_RISK_CONFIG.REJECT_THRESHOLD) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Gap risk score ${gapRiskScore} exceeds reject threshold ${runtime_1.GAP_RISK_CONFIG.REJECT_THRESHOLD}` }, status: 'REJECTED_BY_RISK' };
    }
    // 5. V2.2: Drawdown Multiplier
    const { multiplier: drawdownMult, shouldHalt, drawdownPct } = computeDrawdownMultiplier(account);
    if (shouldHalt) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Drawdown circuit breaker: ${(drawdownPct * 100).toFixed(1)}% DD exceeds halt threshold` }, status: 'REJECTED_BY_RISK' };
    }
    // 6. V2.3: Vol-targeting position sizing (replaces 6-multiplier cascade)
    const baseRiskPct = account.baseRiskPct || 0.005;
    let riskAmount;
    if (account.portfolioRealizedVol && account.portfolioRealizedVol > 0) {
        // Professional vol-targeting: scale risk to target constant portfolio volatility
        const volRatio = runtime_1.VOL_TARGET_CONFIG.TARGET_ANNUAL_VOL / account.portfolioRealizedVol;
        const volAdjustedPct = Math.min(runtime_1.VOL_TARGET_CONFIG.MAX_POSITION_PCT, Math.max(runtime_1.VOL_TARGET_CONFIG.MIN_POSITION_PCT, baseRiskPct * volRatio));
        riskAmount = account.equity * volAdjustedPct * drawdownMult;
    }
    else {
        // Fallback: simplified sizing (strategy weight + drawdown only — fewer multipliers)
        const strategyWeight = account.strategyRiskWeights[signal.strategy] || 1.0;
        riskAmount = account.equity * baseRiskPct * strategyWeight * regime.riskMultiplier * drawdownMult;
    }
    // 7. Gap risk position reduction (partial)
    const gapSizeMultiplier = gapRiskScore >= runtime_1.GAP_RISK_CONFIG.REDUCE_THRESHOLD ? 0.5 : 1.0;
    const adjustedRiskAmount = riskAmount * gapSizeMultiplier;
    let sizedQty = Math.floor(adjustedRiskAmount / stopDistance);
    if (sizedQty <= 0) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: 'Position size rounds to zero after multipliers' }, status: 'REJECTED_BY_RISK' };
    }
    // 8. V2.3: ADV liquidity cap
    const entryPrice = ((_f = signal.entryPlan) === null || _f === void 0 ? void 0 : _f.type) === 'NEXT_OPEN' ? (((_g = signal.features) === null || _g === void 0 ? void 0 : _g.ema20) || 0) : 0;
    if (signal.features && entryPrice > 0) {
        const advCheck = computeAdvCheck(signal.features, sizedQty, entryPrice);
        if (advCheck.capped) {
            sizedQty = advCheck.cappedQty;
            console.log(`[Strategy] ${signal.symbol} ADV-capped: ${advCheck.maxQtyByAdv} max (medVol20=${advCheck.medVol20})`);
        }
        signal.advCheck = advCheck;
        // Check minimum traded value threshold
        if (advCheck.medVol20 > 0 && advCheck.medVol20 * entryPrice < runtime_1.ADV_LIMITS.MIN_TRADED_VALUE_20D) {
            return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Insufficient liquidity: median traded value below ${runtime_1.ADV_LIMITS.MIN_TRADED_VALUE_20D / 10000000}Cr threshold` }, status: 'REJECTED_BY_RISK' };
        }
        // V2.4: Absolute position value cap (₹2Cr max regardless of sizing)
        const positionValue = sizedQty * entryPrice;
        if (positionValue > runtime_1.ADV_LIMITS.MAX_POSITION_VALUE_INR) {
            sizedQty = Math.floor(runtime_1.ADV_LIMITS.MAX_POSITION_VALUE_INR / entryPrice);
            console.log(`[Strategy] ${signal.symbol} abs-cap: ₹${(runtime_1.ADV_LIMITS.MAX_POSITION_VALUE_INR / 10000000).toFixed(1)}Cr max position value`);
        }
    }
    // 9. V2.3: Gap stress test — portfolio-level worst-case overnight loss
    const gapStress = computeGapStress(atrRef, sizedQty, entryPrice || 1, adjustedRiskAmount);
    signal.gapStress = gapStress;
    const existingGapLoss = openPositions.reduce((sum, p) => sum + (p.worstCaseGapLoss || 0), 0);
    const totalGapLoss = existingGapLoss + gapStress.worstCaseLossInr;
    const maxGapLoss = account.equity * runtime_1.GAP_STRESS_CONFIG.MAX_PORTFOLIO_GAP_LOSS_PCT;
    if (totalGapLoss > maxGapLoss) {
        return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Portfolio gap stress exceeded: ₹${Math.round(totalGapLoss)} > ₹${Math.round(maxGapLoss)} (${(runtime_1.GAP_STRESS_CONFIG.MAX_PORTFOLIO_GAP_LOSS_PCT * 100).toFixed(0)}% cap)` }, status: 'REJECTED_BY_RISK' };
    }
    if (gapStress.worstCaseLossR > runtime_1.GAP_STRESS_CONFIG.PER_POSITION_MAX_GAP_LOSS_R) {
        console.warn(`[Strategy] ${signal.symbol} high gap stress: ${gapStress.worstCaseLossR.toFixed(1)}R worst-case loss`);
    }
    // 10. Portfolio constraints + cluster enforcement
    const activeSectorCount = openPositions.filter(p => p.sector === sector).length;
    const currentHeatR = openPositions.reduce((sum, p) => sum + (p.riskAmount || 0), 0) / (account.equity * baseRiskPct);
    const signalHeatR = adjustedRiskAmount / (account.equity * baseRiskPct);
    let rejected = false;
    let reason = '';
    if (openPositions.length + sessionApprovals >= account.maxPositions) {
        rejected = true;
        reason = 'Max portfolio positions reached';
    }
    else if (activeSectorCount >= runtime_1.RISK_LIMITS.maxPerSectorPositions) {
        rejected = true;
        reason = `Sector cap reached for ${sector}`;
    }
    else if (currentHeatR + signalHeatR > runtime_1.RISK_LIMITS.maxPortfolioHeatR) {
        rejected = true;
        reason = 'Portfolio Heat threshold exceeded';
    }
    // 11. V2.4: Correlation cluster enforcement (FAIL-CLOSED — reject if unavailable)
    if (!rejected) {
        try {
            const { getClusterInfo } = await Promise.resolve().then(() => __importStar(require('./corrTopN')));
            const prevDateId = await calendar_1.CalendarService.getPrevTradingDateId(dateId);
            if (prevDateId) {
                const baseRiskUnit = account.equity * baseRiskPct;
                const { clusterPositionCount, clusterHeatR, clusterSymbols } = await getClusterInfo(db, signal.symbol, openPositions, prevDateId, baseRiskUnit);
                if (clusterPositionCount >= runtime_1.CORR_CONFIG.MAX_POSITIONS_PER_CLUSTER) {
                    rejected = true;
                    reason = `Correlation cluster cap: ${clusterPositionCount} positions already in cluster (${clusterSymbols.join(', ')})`;
                }
                else if (clusterHeatR + signalHeatR > runtime_1.CORR_CONFIG.MAX_CLUSTER_RISK_R) {
                    rejected = true;
                    reason = `Cluster risk cap: adding ${signalHeatR.toFixed(2)}R would exceed ${runtime_1.CORR_CONFIG.MAX_CLUSTER_RISK_R}R cluster limit (current: ${clusterHeatR.toFixed(2)}R)`;
                }
            }
        }
        catch (corrErr) {
            // V2.4: FAIL-CLOSED — reject entry if correlation data unavailable (prevents hidden concentration risk)
            rejected = true;
            reason = `Correlation check failed (fail-closed): ${corrErr.message}`;
            console.error(`[Strategy] CorrTopN FAIL-CLOSED for ${signal.symbol}: ${corrErr.message}`);
        }
    }
    return {
        riskApproval: {
            status: rejected ? 'REJECTED' : 'APPROVED',
            sizedQty,
            riskAmount: adjustedRiskAmount,
            reason: rejected ? reason : (gapSizeMultiplier < 1 ? `Gap risk reduced qty by 50% (gapScore=${gapRiskScore})` : undefined),
        },
        status: rejected ? 'REJECTED_BY_RISK' : 'APPROVED',
    };
}
/**
 * Evaluate strategies and generate signals for a symbol.
 */
async function doEvaluateSignals(jobId, symbol, runDate, forceRegime, universeId = 'nifty500') {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const db = getDb();
    const dateId = toDateId(runDate);
    const sentinelRef = db.collection('signals').doc(dateId).collection('status').doc(`${jobId}_${symbol}`);
    try {
        await sentinelRef.create({ status: 'RUNNING', jobId, startedAt: admin.firestore.Timestamp.now() });
    }
    catch (e) {
        await logger_1.logger.warn(`[Strategy] Sentinel blocked for ${symbol} in job ${jobId}: ${e.code || e.message}`, 'Strategy', { jobId, symbol, dateId });
        return;
    }
    let status = 'DONE';
    let reason = '';
    try {
        const [featSnap, regimeSnap, accountSnap, openPositionsSnap] = await Promise.all([
            db.collection('features').doc(symbol).collection('days').doc(dateId).get(),
            forceRegime ? Promise.resolve({ exists: true, data: () => ({ marketState: forceRegime, tradeAllowed: true, riskMultiplier: 1.0, minSignalScore: 60, maxNewPositions: 5 }) }) : db.collection('regime').doc(dateId).get(),
            db.collection('config').doc('account').get(),
            db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get()
        ]);
        if (!featSnap.exists || !regimeSnap.exists || !accountSnap.exists) {
            status = 'SKIPPED';
            reason = 'Data missing (Features/Regime/Account)';
            await logger_1.logger.warn(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        const features = featSnap.data();
        const regime = regimeSnap.data();
        const account = accountSnap.data();
        const openPositions = openPositionsSnap.docs.map(d => d.data());
        // V2.4: Feature validation — fail-closed if critical indicators missing
        if (!Number.isFinite(Number(features.ema20)) || !Number.isFinite(Number(features.atr14)) || Number(features.atr14) <= 0) {
            status = 'SKIPPED';
            reason = `Critical features invalid (ema20=${features.ema20}, atr14=${features.atr14})`;
            await logger_1.logger.warn(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        // V2.4: Validate regime has required fields
        if (typeof regime.riskMultiplier !== 'number' || typeof regime.minSignalScore !== 'number') {
            status = 'SKIPPED';
            reason = 'Regime missing riskMultiplier or minSignalScore';
            await logger_1.logger.warn(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        // V2.4: Per-symbol mutex — check if this symbol already has an APPROVED signal today
        const existingSignalsSnap = await db.collection('signals').doc(dateId).collection('items')
            .where('symbol', '==', symbol).where('status', '==', 'APPROVED').limit(1).get();
        if (!existingSignalsSnap.empty) {
            status = 'SKIPPED';
            reason = 'Symbol already has APPROVED signal today (mutex)';
            await logger_1.logger.info(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        // 1. Regime Hard Gate (Gap B11)
        if (!regime.tradeAllowed) {
            status = 'SKIPPED';
            reason = 'Trading barred by regime.tradeAllowed';
            await logger_1.logger.info(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        if (regime.marketState === 'TRANSITION') { // Gap B7 Fixed
            status = 'SKIPPED';
            reason = 'TRANSITION blocks all entries';
            await logger_1.logger.info(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
            return;
        }
        const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
        if (bars.length === 0) {
            status = 'SKIPPED';
            reason = 'Bars missing';
            return;
        }
        const lastBar = bars[bars.length - 1];
        (0, safety_1.checkSafety)(lastBar, runDate);
        const ema20 = Number(features.ema20);
        const ema50 = Number(features.ema50);
        const atr = Number(features.atr14);
        const currentClose = Number(lastBar.close);
        const volSma20 = Number(features.volSma20 || 0);
        // V3.0: RSI fail-closed — reject if unavailable (not default to 50)
        const rsiRaw = features.rsi14;
        if (rsiRaw === undefined || rsiRaw === null || !Number.isFinite(Number(rsiRaw))) {
            status = 'SKIPPED';
            reason = 'RSI unavailable (fail-closed)';
            return;
        }
        const rsi = Number(rsiRaw);
        // V3.0: Kill switch check
        if (runtime_1.RUNTIME_CONFIG.KILL_SWITCH) {
            status = 'SKIPPED';
            reason = 'Kill switch active';
            return;
        }
        // V2.3: Full event calendar check (replaces old earningsBlocked)
        const eventCheck = await isEntryBlockedByEvents(symbol, dateId);
        // V3.0: VDU (Volume Dry-Up) is a hard gate for PullbackEOD
        const vduActive = features.vduActive || false;
        // V3.0: Regime-aware RSI thresholds
        const rsiThresholds = runtime_1.REGIME_RSI_THRESHOLDS[regime.marketState] || runtime_1.REGIME_RSI_THRESHOLDS['RANGE'];
        // V3.0: Rejection reason collector — tracks ALL gate failures (not just first)
        const pullbackReasons = [];
        if (eventCheck.blocked)
            pullbackReasons.push(`event_blocked:${eventCheck.reasons.join(',')}`);
        if (!vduActive)
            pullbackReasons.push('vdu_inactive');
        if (regime.marketState !== 'TREND' && regime.marketState !== 'RANGE')
            pullbackReasons.push(`regime:${regime.marketState}`);
        if (!(ema20 > ema50))
            pullbackReasons.push('ema20_below_ema50');
        if (!isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr))
            pullbackReasons.push('no_ema_touch');
        if (rsi < rsiThresholds.pullbackMin || rsi > rsiThresholds.pullbackMax)
            pullbackReasons.push(`rsi_${rsi.toFixed(1)}_outside_${rsiThresholds.pullbackMin}-${rsiThresholds.pullbackMax}`);
        // 2. Per-Strategy Regime Gating + V2.3 event + safety gates
        const isLongPullback = pullbackReasons.length === 0;
        // V3.0: Breakout requires consolidation (5+ bars of low ATR before breakout)
        let isBreakout = false;
        if (!eventCheck.blocked &&
            regime.marketState === 'TREND' &&
            ema20 > ema50 &&
            bars.length >= 21) {
            const prev20High = Math.max(...bars.slice(-21, -1).map(b => Number(b.high)));
            const isBreakoutPrice = currentClose > prev20High && breakoutVolumeOk(symbol, Number(lastBar.volume), volSma20);
            // V3.0: Consolidation check — require at least 5 of last 10 bars with ATR below 80% of average
            let consolidationBars = 0;
            if (isBreakoutPrice && bars.length >= 11) {
                const recentBars = bars.slice(-11, -1);
                const avgRange = recentBars.reduce((s, b) => s + (Number(b.high) - Number(b.low)), 0) / recentBars.length;
                for (const b of recentBars) {
                    if ((Number(b.high) - Number(b.low)) < avgRange * 0.8)
                        consolidationBars++;
                }
            }
            isBreakout = isBreakoutPrice && consolidationBars >= 5;
        }
        // V2.3: Mean Reversion Safety — restrict to bucket A/B + extended earnings check
        // V3.1: Now also works in BEAR regime with tighter criteria
        const meanRevEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'MeanReversionEOD');
        const liquidityBucket = ((_a = features.liquidity) === null || _a === void 0 ? void 0 : _a.bucket) || 'C';
        const isRangeMR = regime.marketState === 'RANGE' &&
            (liquidityBucket === 'A' || liquidityBucket === 'B') &&
            currentClose < Number(features.bbLower) &&
            rsi < 30 &&
            isTrendNeutral(currentClose, ema20, ema50);
        const isBearMR = regime.marketState === 'BEAR' &&
            liquidityBucket === 'A' && // Stricter liquidity in BEAR
            currentClose < Number(features.bbLower) &&
            rsi < runtime_1.BEAR_STRATEGY_CONFIG.BEAR_MR_RSI_MAX; // Deeper oversold (25 vs 30)
        const isMeanReversion = !meanRevEventCheck.blocked && (isRangeMR || isBearMR);
        // V2.3: Short Strategy Gating — config-controlled + F&O ban check
        let isShortBounce = false;
        if (runtime_1.SHORT_CONFIG.ENABLED) {
            const shortEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'ShortBounceEOD');
            const openShortCount = openPositions.filter(p => p.direction === 'SELL').length;
            isShortBounce = !shortEventCheck.blocked &&
                openShortCount < runtime_1.SHORT_CONFIG.MAX_SHORT_POSITIONS &&
                (liquidityBucket === 'A') && // V2.3: Shorts only on most liquid stocks
                (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') &&
                ema20 < ema50 &&
                isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) &&
                rsi >= 45 && rsi <= 65;
        }
        // V3.1: Bear Bounce — buy deeply oversold stocks in BEAR for a quick bounce
        const bearBounceEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'BearBounceEOD');
        const volSpikeOk = Number(lastBar.volume) > runtime_1.BEAR_STRATEGY_CONFIG.BEAR_BOUNCE_VOL_MULT * volSma20;
        const isBearBounce = !bearBounceEventCheck.blocked &&
            (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') &&
            (liquidityBucket === 'A' || liquidityBucket === 'B') &&
            rsi < runtime_1.BEAR_STRATEGY_CONFIG.BEAR_BOUNCE_RSI_MAX &&
            currentClose < Number(features.bbLower) &&
            volSpikeOk; // Capitulation volume confirms selling climax
        // V3.1: RS Leader — buy stocks showing exceptional relative strength in any regime
        const rsLeaderEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'RSLeaderEOD');
        const rsScore = (_b = features.rsScore) !== null && _b !== void 0 ? _b : 0;
        const isRSLeader = !rsLeaderEventCheck.blocked &&
            ema20 > ema50 && // Must be in uptrend despite market
            rsScore >= runtime_1.BEAR_STRATEGY_CONFIG.RS_LEADER_MIN_RS &&
            rsi >= runtime_1.BEAR_STRATEGY_CONFIG.RS_LEADER_RSI_MIN &&
            rsi <= runtime_1.BEAR_STRATEGY_CONFIG.RS_LEADER_RSI_MAX &&
            isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) &&
            (liquidityBucket === 'A' || (liquidityBucket === 'B' && regime.marketState !== 'BEAR'));
        const allStrats = [
            { condition: isLongPullback, name: 'PullbackEOD', dir: 'BUY', baseScore: 70, rejections: pullbackReasons },
            { condition: isBreakout, name: 'BreakoutCloseEOD', dir: 'BUY', baseScore: 75, rejections: [] },
            { condition: isMeanReversion, name: 'MeanReversionEOD', dir: 'BUY', baseScore: 65, rejections: [] },
            { condition: isShortBounce, name: 'ShortBounceEOD', dir: 'SELL', baseScore: 60, rejections: [] },
            { condition: isBearBounce, name: 'BearBounceEOD', dir: 'BUY', baseScore: 60, rejections: [] },
            { condition: isRSLeader, name: 'RSLeaderEOD', dir: 'BUY', baseScore: 70, rejections: [] },
        ];
        // V3.0: Log all rejection reasons for debugging/analysis
        for (const s of allStrats) {
            if (!s.condition && s.rejections.length > 0) {
                await logger_1.logger.info(`[Strategy] ${symbol} (${s.name}) rejected: ${s.rejections.join(', ')}`, 'Strategy', { jobId, symbol, dateId, rejections: s.rejections });
            }
        }
        const activeStrats = allStrats.filter(s => s.condition);
        console.log(`[Strategy] ${symbol}: ${activeStrats.length} active strategies (of ${allStrats.length}). Regime=${regime.marketState}, ema20=${ema20.toFixed(1)}, ema50=${ema50.toFixed(1)}, vdu=${vduActive}, rsi=${rsi.toFixed(1)}`);
        let sessionApprovals = 0;
        let symbolApproved = false; // V2.4: One approved signal per symbol per day
        for (const strat of activeStrats) {
            // V2.4: Symbol mutex — once one strategy approved, skip the rest
            if (symbolApproved) {
                await logger_1.logger.info(`[Strategy] ${symbol} (${strat.name}) skipped: symbol already approved today`, 'Strategy', { jobId, symbol, dateId });
                continue;
            }
            // V2.3: Per-strategy exit profile for stop/target multipliers
            const exitProfile = runtime_1.EXIT_PROFILES[strat.name] || runtime_1.EXIT_PROFILES['PullbackEOD'];
            const stopMult = exitProfile.stopAtrMult;
            const targetMult = (strat.name === 'ShortBounceEOD' && regime.marketState === 'HIGH_VOL') ? runtime_1.STRATEGY_V11.HIGH_VOL_SHORT_TARGET_ATR : exitProfile.targetAtrMult;
            // V2.2: Dynamic score based on RS rank, VDU, regime, liquidity
            const dynamicScore = computeDynamicScore(strat.baseScore, features, regime, strat.name);
            // V3.0: Per-strategy minimum signal score (stricter than global)
            const stratMinScore = runtime_1.STRATEGY_MIN_SCORES[strat.name] || (regime.minSignalScore || 60);
            const effectiveMinScore = Math.max(stratMinScore, regime.minSignalScore || 60);
            if (dynamicScore < effectiveMinScore) {
                await logger_1.logger.info(`[Strategy] ${symbol} (${strat.name}) score ${dynamicScore} below minScore ${effectiveMinScore}`, 'Strategy', { jobId, symbol, dateId });
                continue;
            }
            const signal = {
                symbol, direction: strat.dir, strategy: strat.name, score: dynamicScore,
                features, entryPlan: { type: 'NEXT_OPEN' },
                indicativeStopPrice: strat.dir === 'BUY' ? currentClose - (atr * stopMult) : currentClose + (atr * stopMult),
                indicativeTargets: [strat.dir === 'BUY' ? currentClose + (atr * targetMult) : currentClose - (atr * targetMult)],
                indicativeRr: targetMult / stopMult,
                checklist: {
                    regime: true,
                    rsFilter: ((_c = features.rsScore) !== null && _c !== void 0 ? _c : 50) >= (strat.name === 'BreakoutCloseEOD' ? runtime_1.RS_CONFIG.BREAKOUT_MIN_RS_SCORE : runtime_1.RS_CONFIG.MIN_RS_SCORE),
                    vduActive: (_d = features.vduActive) !== null && _d !== void 0 ? _d : false,
                    gapRiskOk: ((_e = features.gapRiskScore) !== null && _e !== void 0 ? _e : 0) < runtime_1.GAP_RISK_CONFIG.REJECT_THRESHOLD,
                },
                reasons: {
                    marketState: regime.marketState,
                    rsScore: features.rsScore,
                    vduActive: features.vduActive,
                    gapRiskScore: features.gapRiskScore,
                    liquidityBucket: (_f = features.liquidity) === null || _f === void 0 ? void 0 : _f.bucket,
                    drawdownPct: (account.peakEquity && account.peakEquity > account.equity)
                        ? ((account.peakEquity - account.equity) / account.peakEquity * 100).toFixed(1) + '%'
                        : '0%',
                },
                status: 'NEW',
                atrRef: atr, stopAtrMult: stopMult, targetAtrMult: targetMult
            };
            // 3. Consolidated Risk Approval with Regime Scaling
            const riskResult = await doRiskApproval(signal, account, regime, openPositions, sessionApprovals, dateId, universeId);
            signal.riskApproval = riskResult.riskApproval;
            signal.status = riskResult.status;
            if (signal.status === 'APPROVED') {
                sessionApprovals++;
                symbolApproved = true; // V2.4: Prevent additional approvals for same symbol
                await logger_1.logger.info(`[Strategy] Signal APPROVED for ${symbol} (${strat.name})`, 'Strategy', { jobId, symbol, strategy: strat.name, status: signal.status, dateId });
            }
            else {
                await logger_1.logger.info(`[Strategy] Signal REJECTED for ${symbol} (${strat.name}): ${(_g = signal.riskApproval) === null || _g === void 0 ? void 0 : _g.reason}`, 'Strategy', { jobId, symbol, strategy: strat.name, status: signal.status, reason: (_h = signal.riskApproval) === null || _h === void 0 ? void 0 : _h.reason, dateId });
            }
            const signalId = `${symbol}_${dateId}_${strat.name}`;
            await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
        }
    }
    catch (err) {
        status = 'ERROR';
        reason = err.message;
        await logger_1.logger.error(`[Strategy] ${symbol} ERROR: ${err.message}`, 'Strategy', { jobId, symbol, dateId, stack: (_j = err.stack) === null || _j === void 0 ? void 0 : _j.substring(0, 300) });
    }
    finally {
        await sentinelRef.set({ status, reason, completedAt: admin.firestore.Timestamp.now(), jobId }, { merge: true });
    }
}
exports.evaluateSignalsTask = functionsV1.https.onRequest(async (req, res) => {
    const { jobId, symbol, runDate } = req.body || {};
    try {
        await doEvaluateSignals(String(jobId), String(symbol), String(runDate));
        res.status(200).send('OK');
    }
    catch (e) {
        res.status(500).send(e.message);
    }
});
//# sourceMappingURL=strategy.js.map