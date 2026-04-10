import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, Features, Regime, Bar, AccountConfig } from '../models';
import { STRATEGY_V11, RISK_LIMITS, RS_CONFIG, VDU_CONFIG, GAP_RISK_CONFIG, DRAWDOWN_CONFIG, CORR_CONFIG, ADV_LIMITS, SHORT_CONFIG, VOL_TARGET_CONFIG, GAP_STRESS_CONFIG, EXIT_PROFILES, RUNTIME_CONFIG, STRATEGY_MIN_SCORES, REGIME_RSI_THRESHOLDS, RS_STRATEGY_THRESHOLDS, BEAR_STRATEGY_CONFIG } from '../config/runtime';
import { checkSafety } from './safety';
import { CalendarService } from './calendar';
import { EventCalendarService } from './eventCalendar';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

const toDateId = (date: string) => date.replace(/-/g, '');

type BarDoc = Bar & { id: string };

/**
 * Helper: V1.1 Mandatory ATR Proximity (Strict)
 */
function isAtrNormalizedEmaTouch(close: number, ema20: number, ema50: number, atr14: number) {
  if (atr14 <= 0) return false;
  if (Math.abs(close - ema20) <= STRATEGY_V11.EMA_TOUCH_ATR_MULT * atr14) return true;
  const lo = Math.min(ema20, ema50);
  const hi = Math.max(ema20, ema50);
  if (close >= lo && close <= hi) return true;
  return false;
}

/**
 * Helper: V1.1 Volume Breakout Confirm (Strict)
 */
function breakoutVolumeOk(symbol: string, volume: number, volSma20: number) {
  const v = Number(volume);
  const vsma = Number(volSma20);
  if (!vsma || vsma <= 0) return false;
  return v >= STRATEGY_V11.BREAKOUT_VOL_MULT * vsma;
}

/**
 * Helper: V1.1 Trend Neutrality
 */
function isTrendNeutral(close: number, ema20: number, ema50: number) {
  return (Math.abs(ema20 - ema50) / close) < STRATEGY_V11.RANGE_TREND_NEUTRAL_MAX;
}

/**
 * Helper: V1.1 Earnings Block — V2.3 now delegates to EventCalendarService
 * Kept for backward compat but extended with strategy-aware windows.
 */
async function isEntryBlockedByEvents(symbol: string, runDateId: string, strategy?: string): Promise<{ blocked: boolean; reasons: string[] }> {
  return EventCalendarService.checkEntryBlock(symbol, runDateId, strategy);
}

/**
 * V2.3: ADV (Average Daily Volume) check — cap position as % of daily volume.
 */
function computeAdvCheck(features: Features, sizedQty: number, price: number): { medVol20: number; maxQtyByAdv: number; capped: boolean; cappedQty: number } {
  const medVol20 = features.liquidity?.medVol20 || 0;
  const maxQtyByAdv = medVol20 > 0 ? Math.floor(medVol20 * ADV_LIMITS.MAX_ADV_PCT) : sizedQty;
  const minOrderValue = ADV_LIMITS.MIN_ORDER_VALUE_INR;
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
function computeGapStress(atrAtEntry: number, qty: number, price: number, riskAmount: number): { worstCaseLossInr: number; worstCaseLossR: number } {
  const stressGap = GAP_STRESS_CONFIG.STRESS_GAP_ATR_MULT * atrAtEntry;
  const worstCaseLossInr = stressGap * qty;
  const worstCaseLossR = riskAmount > 0 ? worstCaseLossInr / riskAmount : 0;
  return { worstCaseLossInr, worstCaseLossR };
}

/**
 * Optimized Historical Bar Fetch
 */
async function getRecentBarsOnOrBefore(db: FirebaseFirestore.Firestore, symbol: string, dateId: string, limit: number): Promise<BarDoc[]> {
  const snap = await db.collection('barsD').doc(symbol).collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(limit).get();
  if (snap.empty) return [];
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as Bar) })).reverse();
}

/**
 * V2.2: Compute drawdown multiplier from peak equity.
 * Returns { multiplier, shouldHalt, drawdownPct }.
 */
function computeDrawdownMultiplier(account: AccountConfig): { multiplier: number; shouldHalt: boolean; drawdownPct: number } {
  const equity = account.equity;
  const peakEquity = account.peakEquity || equity;
  const equityEMA25 = account.equityEMA25;

  const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

  let multiplier: number;
  if (drawdownPct >= DRAWDOWN_CONFIG.HALT_AT_PCT) {
    return { multiplier: 0, shouldHalt: true, drawdownPct };
  } else if (drawdownPct >= DRAWDOWN_CONFIG.DD_15_PCT) {
    multiplier = DRAWDOWN_CONFIG.MULT_15_TO_20;
  } else if (drawdownPct >= DRAWDOWN_CONFIG.DD_10_PCT) {
    multiplier = DRAWDOWN_CONFIG.MULT_10_TO_15;
  } else if (drawdownPct >= DRAWDOWN_CONFIG.DD_5_PCT) {
    multiplier = DRAWDOWN_CONFIG.MULT_5_TO_10;
  } else {
    multiplier = DRAWDOWN_CONFIG.MULT_0_TO_5;
  }

  // Equity curve filter: halve size if equity is below its 25-day EMA
  if (equityEMA25 && equity < equityEMA25) {
    multiplier *= DRAWDOWN_CONFIG.EQUITY_EMA_MULT;
  }

  return { multiplier, shouldHalt: false, drawdownPct };
}

/**
 * V2.2: Compute dynamic signal score based on RS, VDU, regime, and liquidity.
 */
function computeDynamicScore(
  baseScore: number,
  features: Features,
  regime: Regime,
  strategyName: string,
): number {
  let score = baseScore;

  // Regime adjustment
  if (regime.marketState === 'TREND') score += 5;
  else if (regime.marketState === 'HIGH_VOL') score -= 10;
  // V3.1: BEAR regime scoring — shorts and bear-specific strategies get a boost
  else if (regime.marketState === 'BEAR') {
    if (strategyName === 'ShortBounceEOD') score += 5;
    else if (strategyName === 'BearBounceEOD') score += 0;  // Neutral — base score is already calibrated
    else if (strategyName === 'RSLeaderEOD') score += 5;     // Leaders in BEAR deserve extra credit
    else score -= 5;  // Penalize generic longs in BEAR
  }

  // RS score boost
  const rsScore = features.rsScore ?? 50;
  if (rsScore >= RS_CONFIG.ELITE_THRESHOLD) score += 10;
  else if (rsScore >= RS_CONFIG.BOOST_THRESHOLD) score += 5;

  // V3.1: Inverse RS boost for shorts — weak stocks are better short candidates
  if (strategyName === 'ShortBounceEOD' && rsScore <= 20) score += 5;

  // VDU boost (only meaningful on pullback — signals institutional patience)
  if (features.vduActive && (strategyName === 'PullbackEOD' || strategyName === 'RSLeaderEOD')) {
    score += VDU_CONFIG.SCORE_BOOST;
  }

  // Liquidity penalty for bucket C
  if (features.liquidity?.bucket === 'C') score -= 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Consolidated Risk Approval Logic (V2.3 — with vol-targeting, ADV limits, gap stress)
 */
async function doRiskApproval(signal: Signal, account: AccountConfig, regime: Regime, openPositions: any[], sessionApprovals: number, dateId: string, universeId: string = 'nifty500'): Promise<{ riskApproval: Signal['riskApproval'], status: Signal['status'] }> {
  const db = getDb();
  
  // 1. Symbol Meta (Sector + Liquidity Bucket)
  const symbolMetaSnap = await db.collection('universes').doc(universeId).collection('members').doc(signal.symbol).get();
  const sector = symbolMetaSnap.exists ? (symbolMetaSnap.data() as any).sector : 'UNKNOWN';

  // 2. Sizing: ATR-based stop distance
  const atrRef = signal.atrRef || signal.features?.atr14 || 0;
  const stopMult = signal.stopAtrMult || 2.0;
  const stopDistance = atrRef * stopMult;
  
  if (stopDistance <= 0) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: 'Invalid stop distance' }, status: 'REJECTED_BY_RISK' };
  }

  // 3. V3.1: Strategy-aware RS Filter — different strategies have different RS needs
  const rsScore = signal.features?.rsScore ?? 50;
  const rsThresholds = RS_STRATEGY_THRESHOLDS[signal.strategy] || { min: RS_CONFIG.MIN_RS_SCORE, max: 100 };
  if (rsScore < rsThresholds.min) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `RS score ${rsScore} below strategy min ${rsThresholds.min} (${signal.strategy})` }, status: 'REJECTED_BY_RISK' };
  }
  if (rsScore > rsThresholds.max) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `RS score ${rsScore} above strategy max ${rsThresholds.max} — too strong to short (${signal.strategy})` }, status: 'REJECTED_BY_RISK' };
  }

  // 4. V2.2: Gap Risk Gate
  const gapRiskScore = signal.features?.gapRiskScore ?? 0;
  if (gapRiskScore >= GAP_RISK_CONFIG.REJECT_THRESHOLD) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Gap risk score ${gapRiskScore} exceeds reject threshold ${GAP_RISK_CONFIG.REJECT_THRESHOLD}` }, status: 'REJECTED_BY_RISK' };
  }

  // 5. V2.2: Drawdown Multiplier
  const { multiplier: drawdownMult, shouldHalt, drawdownPct } = computeDrawdownMultiplier(account);
  if (shouldHalt) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Drawdown circuit breaker: ${(drawdownPct * 100).toFixed(1)}% DD exceeds halt threshold` }, status: 'REJECTED_BY_RISK' };
  }

  // 6. V2.3: Vol-targeting position sizing (replaces 6-multiplier cascade)
  const baseRiskPct = account.baseRiskPct || 0.005;
  let riskAmount: number;
  
  if (account.portfolioRealizedVol && account.portfolioRealizedVol > 0) {
    // Professional vol-targeting: scale risk to target constant portfolio volatility
    const volRatio = VOL_TARGET_CONFIG.TARGET_ANNUAL_VOL / account.portfolioRealizedVol;
    const volAdjustedPct = Math.min(
      VOL_TARGET_CONFIG.MAX_POSITION_PCT,
      Math.max(VOL_TARGET_CONFIG.MIN_POSITION_PCT, baseRiskPct * volRatio)
    );
    riskAmount = account.equity * volAdjustedPct * drawdownMult;
  } else {
    // Fallback: simplified sizing (strategy weight + drawdown only — fewer multipliers)
    const strategyWeight = account.strategyRiskWeights[signal.strategy] || 1.0;
    riskAmount = account.equity * baseRiskPct * strategyWeight * regime.riskMultiplier * drawdownMult;
  }

  // 7. Gap risk position reduction (partial)
  const gapSizeMultiplier = gapRiskScore >= GAP_RISK_CONFIG.REDUCE_THRESHOLD ? 0.5 : 1.0;
  const adjustedRiskAmount = riskAmount * gapSizeMultiplier;
  let sizedQty = Math.floor(adjustedRiskAmount / stopDistance);

  if (sizedQty <= 0) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: 'Position size rounds to zero after multipliers' }, status: 'REJECTED_BY_RISK' };
  }

  // 8. V2.3: ADV liquidity cap
  const entryPrice = signal.entryPlan?.type === 'NEXT_OPEN' ? (signal.features?.ema20 || 0) : 0;
  if (signal.features && entryPrice > 0) {
    const advCheck = computeAdvCheck(signal.features, sizedQty, entryPrice);
    if (advCheck.capped) {
      sizedQty = advCheck.cappedQty;
      console.log(`[Strategy] ${signal.symbol} ADV-capped: ${advCheck.maxQtyByAdv} max (medVol20=${advCheck.medVol20})`);
    }
    signal.advCheck = advCheck;
    
    // Check minimum traded value threshold
    if (advCheck.medVol20 > 0 && advCheck.medVol20 * entryPrice < ADV_LIMITS.MIN_TRADED_VALUE_20D) {
      return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Insufficient liquidity: median traded value below ${ADV_LIMITS.MIN_TRADED_VALUE_20D / 10_000_000}Cr threshold` }, status: 'REJECTED_BY_RISK' };
    }

    // V2.4: Absolute position value cap (₹2Cr max regardless of sizing)
    const positionValue = sizedQty * entryPrice;
    if (positionValue > ADV_LIMITS.MAX_POSITION_VALUE_INR) {
      sizedQty = Math.floor(ADV_LIMITS.MAX_POSITION_VALUE_INR / entryPrice);
      console.log(`[Strategy] ${signal.symbol} abs-cap: ₹${(ADV_LIMITS.MAX_POSITION_VALUE_INR / 10_000_000).toFixed(1)}Cr max position value`);
    }
  }

  // 9. V2.3: Gap stress test — portfolio-level worst-case overnight loss
  const gapStress = computeGapStress(atrRef, sizedQty, entryPrice || 1, adjustedRiskAmount);
  signal.gapStress = gapStress;
  
  const existingGapLoss = openPositions.reduce((sum, p) => sum + (p.worstCaseGapLoss || 0), 0);
  const totalGapLoss = existingGapLoss + gapStress.worstCaseLossInr;
  const maxGapLoss = account.equity * GAP_STRESS_CONFIG.MAX_PORTFOLIO_GAP_LOSS_PCT;
  
  if (totalGapLoss > maxGapLoss) {
    return { riskApproval: { status: 'REJECTED', sizedQty: 0, riskAmount: 0, reason: `Portfolio gap stress exceeded: ₹${Math.round(totalGapLoss)} > ₹${Math.round(maxGapLoss)} (${(GAP_STRESS_CONFIG.MAX_PORTFOLIO_GAP_LOSS_PCT * 100).toFixed(0)}% cap)` }, status: 'REJECTED_BY_RISK' };
  }
  
  if (gapStress.worstCaseLossR > GAP_STRESS_CONFIG.PER_POSITION_MAX_GAP_LOSS_R) {
    console.warn(`[Strategy] ${signal.symbol} high gap stress: ${gapStress.worstCaseLossR.toFixed(1)}R worst-case loss`);
  }

  // 10. Portfolio constraints + cluster enforcement
  const activeSectorCount = openPositions.filter(p => p.sector === sector).length;
  const currentHeatR = openPositions.reduce((sum, p) => sum + (p.riskAmount || 0), 0) / (account.equity * baseRiskPct);
  const signalHeatR = adjustedRiskAmount / (account.equity * baseRiskPct);

  let rejected = false;
  let reason = '';

  if (openPositions.length + sessionApprovals >= account.maxPositions) {
    rejected = true; reason = 'Max portfolio positions reached';
  } else if (activeSectorCount >= RISK_LIMITS.maxPerSectorPositions) {
    rejected = true; reason = `Sector cap reached for ${sector}`;
  } else if (currentHeatR + signalHeatR > RISK_LIMITS.maxPortfolioHeatR) {
    rejected = true; reason = 'Portfolio Heat threshold exceeded';
  }

  // 11. V2.4: Correlation cluster enforcement (FAIL-CLOSED — reject if unavailable)
  if (!rejected) {
    try {
      const { getClusterInfo } = await import('./corrTopN');
      const prevDateId = await CalendarService.getPrevTradingDateId(dateId);
      if (prevDateId) {
        const baseRiskUnit = account.equity * baseRiskPct;
        const { clusterPositionCount, clusterHeatR, clusterSymbols } = await getClusterInfo(
          db, signal.symbol, openPositions, prevDateId, baseRiskUnit
        );

        if (clusterPositionCount >= CORR_CONFIG.MAX_POSITIONS_PER_CLUSTER) {
          rejected = true;
          reason = `Correlation cluster cap: ${clusterPositionCount} positions already in cluster (${clusterSymbols.join(', ')})`;
        } else if (clusterHeatR + signalHeatR > CORR_CONFIG.MAX_CLUSTER_RISK_R) {
          rejected = true;
          reason = `Cluster risk cap: adding ${signalHeatR.toFixed(2)}R would exceed ${CORR_CONFIG.MAX_CLUSTER_RISK_R}R cluster limit (current: ${clusterHeatR.toFixed(2)}R)`;
        }
      }
    } catch (corrErr: any) {
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
export async function doEvaluateSignals(jobId: string, symbol: string, runDate: string, forceRegime?: string, universeId: string = 'nifty500') {
  const db = getDb();
  const dateId = toDateId(runDate);

  const sentinelRef = db.collection('signals').doc(dateId).collection('status').doc(`${jobId}_${symbol}`);
  try {
    await sentinelRef.create({ status: 'RUNNING', jobId, startedAt: admin.firestore.Timestamp.now() });
  } catch (e: any) { 
    await logger.warn(`[Strategy] Sentinel blocked for ${symbol} in job ${jobId}: ${e.code || e.message}`, 'Strategy', { jobId, symbol, dateId });
    return; 
  }

  let status: 'DONE' | 'SKIPPED' | 'ERROR' = 'DONE';
  let reason = '';

  try {
    const [featSnap, regimeSnap, accountSnap, openPositionsSnap] = await Promise.all([
      db.collection('features').doc(symbol).collection('days').doc(dateId).get(),
      forceRegime ? Promise.resolve({ exists: true, data: () => ({ marketState: forceRegime, tradeAllowed: true, riskMultiplier: 1.0, minSignalScore: 60, maxNewPositions: 5 }) }) : db.collection('regime').doc(dateId).get(),
      db.collection('config').doc('account').get(),
      db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get()
    ]);

    if (!featSnap.exists || !regimeSnap.exists || !accountSnap.exists) {
        status = 'SKIPPED'; reason = 'Data missing (Features/Regime/Account)';
        await logger.warn(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
        return;
    }
    const features = featSnap.data() as Features;
    const regime = regimeSnap.data() as Regime;
    const account = accountSnap.data() as AccountConfig;
    const openPositions = openPositionsSnap.docs.map(d => d.data());

    // V2.4: Feature validation — fail-closed if critical indicators missing
    if (!Number.isFinite(Number(features.ema20)) || !Number.isFinite(Number(features.atr14)) || Number(features.atr14) <= 0) {
      status = 'SKIPPED'; reason = `Critical features invalid (ema20=${features.ema20}, atr14=${features.atr14})`;
      await logger.warn(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
      return;
    }

    // V2.4: Validate regime has required fields
    if (typeof regime.riskMultiplier !== 'number' || typeof regime.minSignalScore !== 'number') {
      status = 'SKIPPED'; reason = 'Regime missing riskMultiplier or minSignalScore';
      await logger.warn(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
      return;
    }

    // V2.4: Per-symbol mutex — check if this symbol already has an APPROVED signal today
    const existingSignalsSnap = await db.collection('signals').doc(dateId).collection('items')
      .where('symbol', '==', symbol).where('status', '==', 'APPROVED').limit(1).get();
    if (!existingSignalsSnap.empty) {
      status = 'SKIPPED'; reason = 'Symbol already has APPROVED signal today (mutex)';
      await logger.info(`[Strategy] ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
      return;
    }

    // 1. Regime Hard Gate (Gap B11)
    if (!regime.tradeAllowed) {
        status = 'SKIPPED'; reason = 'Trading barred by regime.tradeAllowed';
        await logger.info(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
        return;
    }
    if (regime.marketState === 'TRANSITION') { // Gap B7 Fixed
        status = 'SKIPPED'; reason = 'TRANSITION blocks all entries';
        await logger.info(`[Strategy] Skipping ${symbol}: ${reason}`, 'Strategy', { jobId, symbol, dateId });
        return;
    }

    const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
    if (bars.length === 0) { status = 'SKIPPED'; reason = 'Bars missing'; return; }
    const lastBar = bars[bars.length - 1];
    checkSafety(lastBar, runDate);

    const ema20 = Number(features.ema20);
    const ema50 = Number(features.ema50);
    const ema200 = Number(features.ema200 || 0);
    const atr = Number(features.atr14);
    const currentClose = Number(lastBar.close);
    const volSma20 = Number(features.volSma20 || 0);
    const low20 = Number(features.low20 || 0);

    // V3.0: RSI fail-closed — reject if unavailable (not default to 50)
    const rsiRaw = features.rsi14;
    if (rsiRaw === undefined || rsiRaw === null || !Number.isFinite(Number(rsiRaw))) {
      status = 'SKIPPED'; reason = 'RSI unavailable (fail-closed)'; return;
    }
    const rsi = Number(rsiRaw);

    // V3.0: Kill switch check
    if (RUNTIME_CONFIG.KILL_SWITCH) {
      status = 'SKIPPED'; reason = 'Kill switch active'; return;
    }

    // V2.3: Full event calendar check (replaces old earningsBlocked)
    const eventCheck = await isEntryBlockedByEvents(symbol, dateId);

    // V3.0: VDU (Volume Dry-Up) is a hard gate for PullbackEOD
    const vduActive = features.vduActive || false;

    // V3.0: Regime-aware RSI thresholds
    const rsiThresholds = REGIME_RSI_THRESHOLDS[regime.marketState] || REGIME_RSI_THRESHOLDS['RANGE'];

    // V3.0: Rejection reason collector — tracks ALL gate failures (not just first)
    const pullbackReasons: string[] = [];
    if (eventCheck.blocked) pullbackReasons.push(`event_blocked:${eventCheck.reasons.join(',')}`);
    if (!vduActive) pullbackReasons.push('vdu_inactive');
    if (regime.marketState !== 'TREND' && regime.marketState !== 'RANGE') pullbackReasons.push(`regime:${regime.marketState}`);
    if (!(ema20 > ema50)) pullbackReasons.push('ema20_below_ema50');
    // V3.2: Structural uptrend — ema50 must be above ema200
    if (ema200 > 0 && !(ema50 > ema200)) pullbackReasons.push('ema50_below_ema200');
    // V3.2: Pullback proximity — close must be within 0-5% above 20-day low
    if (low20 > 0) {
      const pctAboveLow20 = (currentClose - low20) / low20;
      if (pctAboveLow20 < 0 || pctAboveLow20 > 0.05) pullbackReasons.push(`low20_dist_${(pctAboveLow20 * 100).toFixed(1)}pct`);
    }
    if (!isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr)) pullbackReasons.push('no_ema_touch');
    if (rsi < rsiThresholds.pullbackMin || rsi > rsiThresholds.pullbackMax) pullbackReasons.push(`rsi_${rsi.toFixed(1)}_outside_${rsiThresholds.pullbackMin}-${rsiThresholds.pullbackMax}`);

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
            if ((Number(b.high) - Number(b.low)) < avgRange * 0.8) consolidationBars++;
          }
        }
        isBreakout = isBreakoutPrice && consolidationBars >= 5;
    }

    // V2.3: Mean Reversion Safety — restrict to bucket A/B + extended earnings check
    // V3.1: Now also works in BEAR regime with tighter criteria
    const meanRevEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'MeanReversionEOD');
    const liquidityBucket = features.liquidity?.bucket || 'C';
    const isRangeMR = regime.marketState === 'RANGE' && 
                      (liquidityBucket === 'A' || liquidityBucket === 'B') &&
                      currentClose < Number(features.bbLower) && 
                      rsi < 30 && 
                      isTrendNeutral(currentClose, ema20, ema50);
    const isBearMR = regime.marketState === 'BEAR' &&
                     liquidityBucket === 'A' &&  // Stricter liquidity in BEAR
                     currentClose < Number(features.bbLower) &&
                     rsi < BEAR_STRATEGY_CONFIG.BEAR_MR_RSI_MAX;  // Deeper oversold (25 vs 30)
    const isMeanReversion = !meanRevEventCheck.blocked && (isRangeMR || isBearMR);

    // V2.3: Short Strategy Gating — config-controlled + F&O ban check
    let isShortBounce = false;
    if (SHORT_CONFIG.ENABLED) {
      const shortEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'ShortBounceEOD');
      const openShortCount = openPositions.filter(p => p.direction === 'SELL').length;
      
      isShortBounce = !shortEventCheck.blocked &&
                      openShortCount < SHORT_CONFIG.MAX_SHORT_POSITIONS &&
                      (liquidityBucket === 'A') &&  // V2.3: Shorts only on most liquid stocks
                      (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') && 
                      ema20 < ema50 && 
                      isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) && 
                      rsi >= 45 && rsi <= 65;
    }

    // V3.1: Bear Bounce — buy deeply oversold stocks in BEAR for a quick bounce
    const bearBounceEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'BearBounceEOD');
    const volSpikeOk = Number(lastBar.volume) > BEAR_STRATEGY_CONFIG.BEAR_BOUNCE_VOL_MULT * volSma20;
    const isBearBounce = !bearBounceEventCheck.blocked &&
                         (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') &&
                         (liquidityBucket === 'A' || liquidityBucket === 'B') &&
                         rsi < BEAR_STRATEGY_CONFIG.BEAR_BOUNCE_RSI_MAX &&
                         currentClose < Number(features.bbLower) &&
                         volSpikeOk;  // Capitulation volume confirms selling climax

    // V3.1: RS Leader — buy stocks showing exceptional relative strength in any regime
    const rsLeaderEventCheck = await isEntryBlockedByEvents(symbol, dateId, 'RSLeaderEOD');
    const rsScore = features.rsScore ?? 0;
    const isRSLeader = !rsLeaderEventCheck.blocked &&
                       ema20 > ema50 &&  // Must be in uptrend despite market
                       rsScore >= BEAR_STRATEGY_CONFIG.RS_LEADER_MIN_RS &&
                       rsi >= BEAR_STRATEGY_CONFIG.RS_LEADER_RSI_MIN &&
                       rsi <= BEAR_STRATEGY_CONFIG.RS_LEADER_RSI_MAX &&
                       isAtrNormalizedEmaTouch(currentClose, ema20, ema50, atr) &&
                       (liquidityBucket === 'A' || (liquidityBucket === 'B' && regime.marketState !== 'BEAR'));

    const allStrats = [
        { condition: isLongPullback, name: 'PullbackEOD', dir: 'BUY' as const, baseScore: 70, rejections: pullbackReasons },
        { condition: isBreakout, name: 'BreakoutCloseEOD', dir: 'BUY' as const, baseScore: 75, rejections: [] as string[] },
        { condition: isMeanReversion, name: 'MeanReversionEOD', dir: 'BUY' as const, baseScore: 65, rejections: [] as string[] },
        { condition: isShortBounce, name: 'ShortBounceEOD', dir: 'SELL' as const, baseScore: 60, rejections: [] as string[] },
        { condition: isBearBounce, name: 'BearBounceEOD', dir: 'BUY' as const, baseScore: 60, rejections: [] as string[] },
        { condition: isRSLeader, name: 'RSLeaderEOD', dir: 'BUY' as const, baseScore: 70, rejections: [] as string[] },
    ];
    
    // V3.0: Log all rejection reasons for debugging/analysis
    for (const s of allStrats) {
      if (!s.condition && s.rejections.length > 0) {
        await logger.info(`[Strategy] ${symbol} (${s.name}) rejected: ${s.rejections.join(', ')}`, 'Strategy', { jobId, symbol, dateId, rejections: s.rejections });
      }
    }
    
    const activeStrats = allStrats.filter(s => s.condition);
    console.log(`[Strategy] ${symbol}: ${activeStrats.length} active strategies (of ${allStrats.length}). Regime=${regime.marketState}, ema20=${ema20.toFixed(1)}, ema50=${ema50.toFixed(1)}, vdu=${vduActive}, rsi=${rsi.toFixed(1)}`);

    let sessionApprovals = 0;
    let symbolApproved = false;  // V2.4: One approved signal per symbol per day
    for (const strat of activeStrats) {
        // V2.4: Symbol mutex — once one strategy approved, skip the rest
        if (symbolApproved) {
          await logger.info(`[Strategy] ${symbol} (${strat.name}) skipped: symbol already approved today`, 'Strategy', { jobId, symbol, dateId });
          continue;
        }

        // V2.3: Per-strategy exit profile for stop/target multipliers
        const exitProfile = EXIT_PROFILES[strat.name] || EXIT_PROFILES['PullbackEOD'];
        const stopMult = exitProfile.stopAtrMult;
        const targetMult = (strat.name === 'ShortBounceEOD' && regime.marketState === 'HIGH_VOL') ? STRATEGY_V11.HIGH_VOL_SHORT_TARGET_ATR : exitProfile.targetAtrMult;

        // V2.2: Dynamic score based on RS rank, VDU, regime, liquidity
        const dynamicScore = computeDynamicScore(strat.baseScore, features, regime, strat.name);

        // V3.0: Per-strategy minimum signal score (stricter than global)
        const stratMinScore = STRATEGY_MIN_SCORES[strat.name] || (regime.minSignalScore || 60);
        const effectiveMinScore = Math.max(stratMinScore, regime.minSignalScore || 60);
        if (dynamicScore < effectiveMinScore) {
          await logger.info(`[Strategy] ${symbol} (${strat.name}) score ${dynamicScore} below minScore ${effectiveMinScore}`, 'Strategy', { jobId, symbol, dateId });
          continue;
        }

        const signal: Signal = {
            symbol, direction: strat.dir, strategy: strat.name as any, score: dynamicScore,
            features, entryPlan: { type: 'NEXT_OPEN' },
            indicativeStopPrice: strat.dir === 'BUY' ? currentClose - (atr * stopMult) : currentClose + (atr * stopMult),
            indicativeTargets: [strat.dir === 'BUY' ? currentClose + (atr * targetMult) : currentClose - (atr * targetMult)],
            indicativeRr: targetMult / stopMult,
            checklist: {
              regime: true,
              rsFilter: (features.rsScore ?? 50) >= (strat.name === 'BreakoutCloseEOD' ? RS_CONFIG.BREAKOUT_MIN_RS_SCORE : RS_CONFIG.MIN_RS_SCORE),
              vduActive: features.vduActive ?? false,
              gapRiskOk: (features.gapRiskScore ?? 0) < GAP_RISK_CONFIG.REJECT_THRESHOLD,
            },
            reasons: {
              marketState: regime.marketState,
              rsScore: features.rsScore,
              vduActive: features.vduActive,
              gapRiskScore: features.gapRiskScore,
              liquidityBucket: features.liquidity?.bucket,
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
          symbolApproved = true;  // V2.4: Prevent additional approvals for same symbol
          await logger.info(`[Strategy] Signal APPROVED for ${symbol} (${strat.name})`, 'Strategy', { jobId, symbol, strategy: strat.name, status: signal.status, dateId });
        } else {
          await logger.info(`[Strategy] Signal REJECTED for ${symbol} (${strat.name}): ${signal.riskApproval?.reason}`, 'Strategy', { jobId, symbol, strategy: strat.name, status: signal.status, reason: signal.riskApproval?.reason, dateId });
        }

        const signalId = `${symbol}_${dateId}_${strat.name}`;
        await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
    }
  } catch (err: any) {
    status = 'ERROR'; reason = err.message;
    await logger.error(`[Strategy] ${symbol} ERROR: ${err.message}`, 'Strategy', { jobId, symbol, dateId, stack: err.stack?.substring(0, 300) });
  } finally {
    await sentinelRef.set({ status, reason, completedAt: admin.firestore.Timestamp.now(), jobId }, { merge: true });
  }
}

export const evaluateSignalsTask = functionsV1.https.onRequest(async (req, res) => {
  const { jobId, symbol, runDate } = req.body || {};
  try {
    await doEvaluateSignals(String(jobId), String(symbol), String(runDate));
    res.status(200).send('OK');
  } catch (e: any) { res.status(500).send(e.message); }
});
