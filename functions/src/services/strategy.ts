import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, Features, Regime, Bar, AccountConfig } from '../models';
import { STRATEGY_V11, RISK_LIMITS, RS_CONFIG, VDU_CONFIG, GAP_RISK_CONFIG, DRAWDOWN_CONFIG, CORR_CONFIG, ADV_LIMITS, SHORT_CONFIG, VOL_TARGET_CONFIG, GAP_STRESS_CONFIG, EXIT_PROFILES, RUNTIME_CONFIG, STRATEGY_MIN_SCORES, REGIME_RSI_THRESHOLDS, RS_STRATEGY_THRESHOLDS, BEAR_STRATEGY_CONFIG, SEPA_CONFIG, METALS_CONFIG, ATH_CONFIG } from '../config/runtime';
import { checkSafety } from './safety';
import { CalendarService } from './calendar';
import { EventCalendarService } from './eventCalendar';
import { logger } from './logger';
import { getWindowOnOrBefore } from './barCache';
import { settledCash } from './portfolioEquity';

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
 * Optimized Historical Bar Fetch — served from the shared bar reader (in-memory
 * cache during REPLAY, identical bounded scan in live).
 */
async function getRecentBarsOnOrBefore(db: FirebaseFirestore.Firestore, symbol: string, dateId: string, limit: number): Promise<BarDoc[]> {
  const bars = await getWindowOnOrBefore(db, symbol, dateId, limit);
  return bars.map((b) => ({ id: b.dateId as string, ...b }));
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
    else if (strategyName === 'PullbackEOD') score -= 3;     // V3.2: Mild penalty — structural gates provide safety
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
 * SEPA (Minervini) faithful entry evaluator. Runs ONLY when SEPA_CONFIG.SEPA_ONLY
 * is true and fully replaces the multi-strategy logic. Pillars: index-regime gate,
 * trend template (close>50>150>200 SMA, 200 rising), within HI_PROX of the 52-week
 * high, RS leadership (top RS_TOP by 126-day momentum), 7% hard stop, risk-based
 * sizing, and a tight equity-curve throttle. Writes an APPROVED SepaBreakoutEOD
 * signal; the percent lock/trail exit and regime-off liquidation live in tradeManager.
 */
async function evaluateSepaSignal(
  db: FirebaseFirestore.Firestore,
  jobId: string,
  symbol: string,
  dateId: string,
  features: Features,
  regime: Regime,
  account: AccountConfig,
  openPositions: any[],
): Promise<void> {
  // 1. Index-regime gate — only buy leaders while the index is in a confirmed uptrend.
  const m = regime.metrics;
  const indexUp = !!m && Number(m.close) > Number(m.ema200) && Number(m.ema200Slope ?? 0) > 0 && regime.marketState !== 'BEAR';
  if (!indexUp) return;

  // 2. Equity-curve throttle — no new buys once drawdown-from-peak exceeds the halt.
  const peak = account.peakEquity || account.equity;
  const drawdownPct = peak > 0 ? (peak - account.equity) / peak : 0;
  if (drawdownPct >= SEPA_CONFIG.THROTTLE_HALT_PCT) return;

  // 3. Portfolio cap (final selection of the strongest leaders is enforced in doPlaceOrders).
  if (openPositions.length >= SEPA_CONFIG.MAX_POS) return;

  // 4. Feature availability.
  const sma50 = Number(features.sma50);
  const sma150 = Number(features.sma150);
  const sma200 = Number(features.sma200);
  const high252 = Number(features.high252);
  const rsRank126 = Number(features.rsRank126);
  if (![sma50, sma150, sma200, high252, rsRank126].every(Number.isFinite)) return;

  const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 1);
  if (bars.length === 0) return;
  const close = Number(bars[bars.length - 1].close);
  if (!Number.isFinite(close) || close <= 0) return;

  // 5. Trend template + near-52w-high + RS leadership.
  const trendTemplate = close > sma50 && sma50 > sma150 && sma150 > sma200 && features.sma200Rising === true;
  const nearHigh = close >= high252 * (1 - SEPA_CONFIG.HI_PROX);
  const rsLeader = rsRank126 <= SEPA_CONFIG.RS_TOP;
  if (!(trendTemplate && nearHigh && rsLeader)) return;

  // 6. Sizing — risk RISK_PCT of equity against the 7% hard stop, throttled by the
  //    drawdown-multiplier ladder.
  const { multiplier: ddMult, shouldHalt } = computeDrawdownMultiplier(account);
  if (shouldHalt) return;
  const stopDistance = close * SEPA_CONFIG.HARD_STOP_PCT;
  const riskAmount = account.equity * SEPA_CONFIG.RISK_PCT * ddMult;
  const sizedQty = Math.floor(riskAmount / stopDistance);
  if (sizedQty <= 0) return;

  // 7. Build the APPROVED signal. The 7% hard stop is expressed as atrRef*stopAtrMult
  //    so the existing fill path sets position.stopPrice = fill - stopDistance; a huge
  //    targetAtrMult means no fixed target (the position rides the trailing lock).
  const signal: Signal = {
    symbol,
    direction: 'BUY',
    strategy: 'SepaBreakoutEOD',
    score: 100,
    features,
    entryPlan: { type: 'NEXT_OPEN' },
    indicativeStopPrice: close - stopDistance,
    indicativeTargets: [],
    indicativeRr: 0,
    checklist: { regime: true, trendTemplate: true, nearHigh: true, rsLeader: true },
    reasons: {
      marketState: regime.marketState,
      rsRank126,
      pctFrom52wHigh: (((close - high252) / high252) * 100).toFixed(1) + '%',
      drawdownPct: (drawdownPct * 100).toFixed(1) + '%',
    },
    status: 'APPROVED',
    atrRef: stopDistance,
    stopAtrMult: 1,
    targetAtrMult: 1000,
    riskApproval: { status: 'APPROVED', sizedQty, riskAmount },
  };

  const signalId = `${symbol}_${dateId}_SepaBreakoutEOD`;
  await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
  await logger.info(`[Strategy] SEPA APPROVED ${symbol} rank126=${rsRank126} qty=${sizedQty}`, 'Strategy', { jobId, symbol, dateId });
}

/**
 * Pure ATH-Pullback entry gate: a market LEADER (long-term uptrend + RS) that has pulled
 * back 3–15% off its 52-week high INTO the 50-SMA buy-zone on a healthy (not oversold /
 * overbought) dip. Extracted so the entry rules are unit-testable in isolation.
 */
export function athPullbackSetup(f: {
  sma50?: number; sma150?: number; sma200?: number; high252?: number; athHigh?: number;
  rsRank126?: number; rsi14?: number; sma200Rising?: boolean;
}, close: number): boolean {
  const sma50 = Number(f.sma50), sma150 = Number(f.sma150), sma200 = Number(f.sma200);
  const high252 = Number(f.high252), rsRank126 = Number(f.rsRank126), rsi14 = Number(f.rsi14);
  // Prefer the true all-time high; fall back to the 52-week high when ATH isn't tracked yet.
  const athHigh = Number(f.athHigh);
  const highRef = Number.isFinite(athHigh) && athHigh > 0 ? athHigh : high252;
  if (![sma50, sma150, sma200, highRef, rsRank126, rsi14, close].every(Number.isFinite)) return false;
  if (!(close > 0)) return false;
  const trendTemplate = close > sma50 && sma50 > sma150 && sma150 > sma200 && f.sma200Rising === true;
  const rsLeader = rsRank126 <= ATH_CONFIG.RS_TOP;
  const belowHigh = close <= highRef * (1 - ATH_CONFIG.HI_PROX_MIN) && close >= highRef * (1 - ATH_CONFIG.HI_PROX_MAX);
  const dist50 = (close - sma50) / sma50;
  const inZone = dist50 >= ATH_CONFIG.SUPPORT_BAND_LO && dist50 <= ATH_CONFIG.SUPPORT_BAND_HI;
  const healthyRsi = rsi14 >= ATH_CONFIG.RSI_LO && rsi14 <= ATH_CONFIG.RSI_HI;
  return trendTemplate && rsLeader && belowHigh && inZone && healthyRsi;
}

/**
 * ATH-Pullback evaluator — the inverse trigger to SEPA. Buys a market LEADER that is
 * near its all-time / 52-week high but has pulled back into a support buy-zone (near the
 * 50-SMA), on an orderly dip (healthy RSI), with a wide ~10% swing stop. Models the
 * advisory "buy-the-dip on a leader" calls. Writes an APPROVED ATHPullbackEOD signal;
 * the final leader selection + shared-equity-book funds gate run in doPlaceOrders.
 */
async function evaluateAthSignal(
  db: FirebaseFirestore.Firestore,
  jobId: string,
  symbol: string,
  dateId: string,
  features: Features,
  regime: Regime,
  account: AccountConfig,
  openPositions: any[],
): Promise<void> {
  // 1. Index-regime gate — only buy leaders while the index is in a confirmed uptrend.
  const m = regime.metrics;
  const indexUp = !!m && Number(m.close) > Number(m.ema200) && Number(m.ema200Slope ?? 0) > 0 && regime.marketState !== 'BEAR';
  if (!indexUp) return;

  // 2. Equity-curve throttle (shared with SEPA) — no new buys past the drawdown halt.
  const peak = account.peakEquity || account.equity;
  const drawdownPct = peak > 0 ? (peak - account.equity) / peak : 0;
  if (drawdownPct >= SEPA_CONFIG.THROTTLE_HALT_PCT) return;

  // 3. Sleeve cap (final selection enforced in doPlaceOrders).
  if (openPositions.filter((p) => p.strategy === 'ATHPullbackEOD').length >= ATH_CONFIG.MAX_POS) return;

  const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 1);
  if (bars.length === 0) return;
  const close = Number(bars[bars.length - 1].close);

  // 4. Entry gate (leadership + pullback into the 50-SMA buy-zone).
  if (!athPullbackSetup(features, close)) return;

  // 5. Sizing — risk RISK_PCT of equity against the 10% swing stop.
  const { multiplier: ddMult, shouldHalt } = computeDrawdownMultiplier(account);
  if (shouldHalt) return;
  const stopDistance = close * ATH_CONFIG.HARD_STOP_PCT;
  const riskAmount = account.equity * ATH_CONFIG.RISK_PCT * ddMult;
  const sizedQty = Math.floor(riskAmount / stopDistance);
  if (sizedQty <= 0) return;

  const high252 = Number(features.high252);
  const athHigh = Number(features.athHigh);
  const highRef = Number.isFinite(athHigh) && athHigh > 0 ? athHigh : high252;
  const dist50 = (close - Number(features.sma50)) / Number(features.sma50);
  const stopPrice = close - stopDistance;
  const signal: Signal = {
    symbol,
    direction: 'BUY',
    strategy: 'ATHPullbackEOD',
    score: 100,
    features,
    // LIMIT entry: only buy on a dip into the zone next session (≤ today's close),
    // and cancel if it gaps below the stop. Don't chase a gap-up away from support.
    entryPlan: { type: 'LIMIT', limitHi: close, limitLo: stopPrice },
    indicativeStopPrice: stopPrice,
    indicativeTargets: [],
    indicativeRr: 0,
    checklist: { regime: true, trendTemplate: true, pullback: true, inZone: true, rsLeader: true },
    reasons: {
      marketState: regime.marketState,
      rsRank126: Number(features.rsRank126),
      pctFromAth: (((close - highRef) / highRef) * 100).toFixed(1) + '%',
      distFrom50Sma: (dist50 * 100).toFixed(1) + '%',
      rsi14: Number(features.rsi14).toFixed(1),
    },
    status: 'APPROVED',
    atrRef: stopDistance,
    stopAtrMult: 1,
    targetAtrMult: 1000,
    riskApproval: { status: 'APPROVED', sizedQty, riskAmount },
  };

  const signalId = `${symbol}_${dateId}_ATHPullbackEOD`;
  await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
  await logger.info(`[Strategy] ATH APPROVED ${symbol} rank126=${Number(features.rsRank126)} dist50=${(dist50 * 100).toFixed(1)}% qty=${sizedQty}`, 'Strategy', { jobId, symbol, dateId });
}

/**
 * Metals rotation sleeve evaluator. Runs (alongside SEPA) only for the whitelisted
 * metal ETFs when METALS_CONFIG.ENABLED. It is a self-contained trend-following
 * rule: hold the ETF only while it is above its 200-SMA AND its risk-adjusted
 * momentum (skip-1m return / daily-return volatility) is positive. The ETFs are
 * intentionally exempt from the equity liquidity/RS/sector gates. Sizing uses a
 * fixed sleeve budget (ALLOC_PCT of equity, split across MAX_POS slots). The exit
 * (trend-gate break + wide hard stop) lives in tradeManager, mirroring SEPA.
 */
async function evaluateMetalsSignal(
  db: FirebaseFirestore.Firestore,
  jobId: string,
  symbol: string,
  dateId: string,
  account: AccountConfig,
  openPositions: any[],
): Promise<void> {
  // 1. Already holding this ETF → nothing to do; the exit is managed in tradeManager.
  if (openPositions.some((p) => p.symbol === symbol)) return;

  // 2. Sleeve capacity — cap the number of concurrent metal positions.
  const metalsHeld = openPositions.filter((p) => p.strategy === 'MetalsRotation').length;
  if (metalsHeld >= METALS_CONFIG.MAX_POS) return;

  // 3. Load a long trailing window and compute the trend gate + risk-adjusted momentum.
  const need = METALS_CONFIG.SMA_TREND + METALS_CONFIG.MOM_LOOKBACK + METALS_CONFIG.MOM_SKIP + 5;
  const bars = await getWindowOnOrBefore(db, symbol, dateId, METALS_CONFIG.FEATURE_WINDOW);
  if (bars.length < need) return;
  const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < need) return;

  const close = closes[closes.length - 1];

  // Trend gate: close must be above the 200-SMA.
  const smaWindow = closes.slice(-METALS_CONFIG.SMA_TREND);
  const sma200 = smaWindow.reduce((a, b) => a + b, 0) / smaWindow.length;
  if (!(close > sma200)) return;

  // Risk-adjusted momentum: skip-1m lookback return divided by daily-return volatility.
  const skip = METALS_CONFIG.MOM_SKIP;
  const look = METALS_CONFIG.MOM_LOOKBACK;
  const recent = closes[closes.length - 1 - skip];
  const past = closes[closes.length - 1 - skip - look];
  if (!(Number.isFinite(recent) && Number.isFinite(past) && past > 0)) return;
  const ret = recent / past - 1;
  // Daily log-ish simple returns over the lookback window (ending at the skip point).
  const momSlice = closes.slice(closes.length - 1 - skip - look, closes.length - skip);
  const rets: number[] = [];
  for (let i = 1; i < momSlice.length; i++) {
    if (momSlice[i - 1] > 0) rets.push(momSlice[i] / momSlice[i - 1] - 1);
  }
  if (rets.length < 20) return;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length;
  const vol = Math.sqrt(variance);
  if (!(vol > 0)) return;
  const raMom = ret / vol;
  if (!(raMom > METALS_CONFIG.MIN_RA_MOM)) return;

  // 4. Sizing — equal slice of the sleeve budget off SETTLED CASH (initial + realised),
  //    not equity, so the sleeve deploys only funds actually available (no leverage on
  //    unrealised gains). A wide hard stop is a protective floor; the trend gate exits.
  const slotBudget = (settledCash(account) * METALS_CONFIG.ALLOC_PCT) / METALS_CONFIG.MAX_POS;
  const sizedQty = Math.floor(slotBudget / close);
  if (sizedQty <= 0) return;
  const stopDistance = close * METALS_CONFIG.HARD_STOP_PCT;

  const signal: Signal = {
    symbol,
    direction: 'BUY',
    strategy: 'MetalsRotation',
    score: 100,
    entryPlan: { type: 'NEXT_OPEN' },
    indicativeStopPrice: close - stopDistance,
    indicativeTargets: [],
    indicativeRr: 0,
    checklist: { trendGate: true, riskAdjMomentum: true },
    reasons: {
      raMom: raMom.toFixed(2),
      ret: (ret * 100).toFixed(1) + '%',
      pctAboveSma200: (((close - sma200) / sma200) * 100).toFixed(1) + '%',
    },
    status: 'APPROVED',
    atrRef: stopDistance,
    stopAtrMult: 1,
    targetAtrMult: 1000,
    riskApproval: { status: 'APPROVED', sizedQty, riskAmount: slotBudget },
  };

  const signalId = `${symbol}_${dateId}_MetalsRotation`;
  await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
  await logger.info(`[Strategy] METALS APPROVED ${symbol} raMom=${raMom.toFixed(2)} qty=${sizedQty}`, 'Strategy', { jobId, symbol, dateId });
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

    // Metals rotation sleeve: whitelisted metal ETFs are handled by their own
    // evaluator and run ALONGSIDE SEPA. They are never routed through the SEPA
    // breakout or the multi-strategy equity path (different gates entirely).
    const isMetalsSymbol = METALS_CONFIG.SYMBOLS.includes(symbol);
    if (METALS_CONFIG.ENABLED && isMetalsSymbol) {
      await evaluateMetalsSignal(db, jobId, symbol, dateId, account, openPositions);
      return;
    }

    // SEPA faithful port: when enabled, run ONLY the SEPA evaluator and skip the
    // entire multi-strategy path below (it does its own regime/RS/stop gating).
    if (SEPA_CONFIG.SEPA_ONLY) {
      if (isMetalsSymbol) return; // never trade the metal ETFs on the equity path
      await evaluateSepaSignal(db, jobId, symbol, dateId, features, regime, account, openPositions);
      // ATH-Pullback runs ALONGSIDE SEPA on equities (inverse trigger, shared equity book).
      if (ATH_CONFIG.ENABLED) {
        await evaluateAthSignal(db, jobId, symbol, dateId, features, regime, account, openPositions);
      }
      return;
    }

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
    const liquidityBucket = features.liquidity?.bucket || 'C';

    // V3.0: Regime-aware RSI thresholds
    const rsiThresholds = REGIME_RSI_THRESHOLDS[regime.marketState] || REGIME_RSI_THRESHOLDS['RANGE'];

    // V3.0: Rejection reason collector — tracks ALL gate failures (not just first)
    // V3.2: Allow PullbackEOD in BEAR regime with tighter gates
    const isBearPullback = regime.marketState === 'BEAR';
    const pullbackReasons: string[] = [];
    if (eventCheck.blocked) pullbackReasons.push(`event_blocked:${eventCheck.reasons.join(',')}`);
    if (!vduActive) pullbackReasons.push('vdu_inactive');
    if (regime.marketState !== 'TREND' && regime.marketState !== 'RANGE' && regime.marketState !== 'BEAR') pullbackReasons.push(`regime:${regime.marketState}`);
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
    // V3.2: BEAR pullback requires bucket A liquidity (tighter than TREND/RANGE)
    if (isBearPullback && liquidityBucket !== 'A') pullbackReasons.push(`bear_liquidity:${liquidityBucket}`);

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
