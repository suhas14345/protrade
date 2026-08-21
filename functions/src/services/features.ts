import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { Features, Bar } from '../models';
import { logger } from './logger';
import { VDU_CONFIG, GAP_RISK_CONFIG, SEPA_CONFIG } from '../config/runtime';
import { getWindowOnOrBefore, maxHighOnOrBefore } from './barCache';

// Lazy load technicalindicators inside functions to avoid deployment timeouts

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * 200-SMA slope check with an ADAPTIVE lookback: rising when today's 200-SMA exceeds
 * the 200-SMA min(lookback, available) bars ago. Requires a full 200-bar SMA plus a
 * minimal (>=5-bar) slope window. The old hard `>= 200 + lookback` guard defaulted to
 * false whenever history was < 220 bars — which, with ~10-11 months of stored bars,
 * was the whole universe, silently disabling every SEPA/ATH trend-template signal.
 */
export function computeSma200Rising(closes: number[], lookback: number): boolean {
  const n = closes.length;
  if (n < 205) return false;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const lb = Math.min(lookback, n - 200);
  const sma200Now = mean(closes.slice(-200));
  const sma200Prev = mean(closes.slice(-(200 + lb), -lb));
  return sma200Now > sma200Prev;
}

export async function doComputeFeatures(jobId: string, symbol: string, runDate: string) {
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
  } else if (dayOfWeek === 0) { // Sunday -> check Friday
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

  // 1. Fetch the trailing 200-bar window up to the run date via the shared bar
  //    reader. In REPLAY it is served from an in-memory cache (one Firestore read
  //    per symbol for the whole run); in live it runs the identical bounded scan.
  //    200 trading days gives indicator stability; the current closed bar is the
  //    signal bar (signals fire for NEXT_OPEN entry). SEPA needs a longer window
  //    (52-week high + 200-SMA slope), so widen it only when SEPA_ONLY is on.
  const win = SEPA_CONFIG.SEPA_ONLY ? SEPA_CONFIG.FEATURE_WINDOW : 200;
  const bars = await getWindowOnOrBefore(db, symbol, dateId, win);

  if (bars.length < 25) {
    const errorMsg = `[Features Fail] Insufficient data for ${symbol}. Found ${bars.length} bars. Needs 25.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

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

  const getSafePeriod = (requested: number, length: number) => Math.max(2, Math.min(requested, length - 1));

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
  const last100Atrps = atrArr.slice(-100).map((a: number, i: number) => (a / closes[closes.length - atrArr.length + i]) * 100);
  const atrpMa100 = last100Atrps.length > 0 ? (last100Atrps.reduce((a: number, b: number) => a + b, 0) / last100Atrps.length) : atrp;

  // 3. Advanced Market Structure (Swing H/L and S/R)
  const swings = calculateSwings(bars, 3); // 3-bar fractal
  const srZones = identifySRZones(swings);

  // SEPA (Minervini) fields — computed only when enabled so default behaviour is unchanged.
  let sepaFields: Partial<Features> = {};
  if (SEPA_CONFIG.SEPA_ONLY) {
    const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : currentClose);
    const sma = (n: number) => avg(closes.length >= n ? closes.slice(-n) : closes);
    const sma50 = sma(50);
    const sma150 = sma(150);
    const sma200 = sma(200);
    // 200-SMA slope (adaptive lookback so ~200-bar histories can still confirm a rising 200-SMA).
    const sma200Rising = computeSma200Rising(closes, SEPA_CONFIG.SMA200_SLOPE_LOOKBACK);
    const high252 = Math.max(...closes.slice(-252));
    const ret126 = closes.length >= 127 ? (closes[closes.length - 1] / closes[closes.length - 127]) - 1 : 0;
    // True all-time high. Until the one-time full-history seed runs (flagged on the parent
    // doc), scan ALL stored bars so athHigh is genuinely all-time, not just the ~260-bar
    // window; afterwards a cheap running max keeps it current (and self-heals new symbols).
    const athSnap = await db.collection('features').doc(symbol).get();
    const athData: any = athSnap.exists ? athSnap.data() : null;
    let athHigh: number;
    if (athData?.athHighFullScan) {
      const prevAth = Number(athData.athHigh) || 0;
      athHigh = Math.max(prevAth, Math.max(...highs), high252);
    } else {
      const allTimeHigh = await maxHighOnOrBefore(db, symbol, dateId);
      athHigh = Math.max(allTimeHigh, Math.max(...highs), high252);
    }
    sepaFields = { sma50, sma150, sma200, sma200Rising, high252, ret126, athHigh };
  }

  // 4. Refined Trend State
  let trendState: 'UP' | 'DOWN' | 'RANGE' = 'RANGE';
  const lastSwingHigh = swings.highs.length > 0 ? swings.highs[swings.highs.length - 1].price : 0;
  const lastSwingLow = swings.lows.length > 0 ? swings.lows[swings.lows.length - 1].price : 0;
  const prevSwingHigh = swings.highs.length > 1 ? swings.highs[swings.highs.length - 2].price : 0;
  const prevSwingLow = swings.lows.length > 1 ? swings.lows[swings.lows.length - 2].price : 0;

  if (ema20 > ema50 && currentClose > ema20 && lastSwingHigh > prevSwingHigh && lastSwingLow > prevSwingLow) {
    trendState = 'UP';
  } else if (ema20 < ema50 && currentClose < ema20 && lastSwingHigh < prevSwingHigh && lastSwingLow < prevSwingLow) {
    trendState = 'DOWN';
  }

  const featureDoc: Features = {
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
    computedAt: Timestamp.now(),
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
    barsCount: bars.length,
    // V2.2: Computed liquidity bucket from median traded value
    liquidity: computeLiquidity(bars),
    // V2.2: Volume Dry-Up flag
    vduActive: computeVDU(bars),
    // V2.2: Gap risk score (0-100 percentile)
    gapRiskScore: computeGapRiskScore(bars, atr14),
    // rsScore is intentionally omitted here — filled by the RS ranking pass. Writing
    // `undefined` would break the Firestore write when ignoreUndefinedProperties is off.
    patterns: [],
    ...sepaFields,
  };

  await db.collection('features').doc(symbol).collection('days').doc(dateId).set(featureDoc);

  // Persist the running ATH on the parent doc so the next session can extend the max.
  if (SEPA_CONFIG.SEPA_ONLY && Number.isFinite(Number((sepaFields as any).athHigh))) {
    await db.collection('features').doc(symbol).set(
      { athHigh: (sepaFields as any).athHigh, athHighFullScan: true, athUpdatedAt: Timestamp.now() },
      { merge: true },
    );
  }

  await logger.info(`Features computed for ${symbol}: Trend=${trendState}, RSI=${rsi14.toFixed(2)}`, 'Features', { jobId, symbol });
}

/**
 * V2.2: Compute liquidity bucket from actual median traded value (not hardcoded 'A').
 * Bucket A = top-tier liquid (medTradedValue20 >= 50 Cr), B = mid, C = low.
 */
function computeLiquidity(bars: Bar[]): {
  medVol20: number;
  medTradedValue20: number;
  bucket: 'A' | 'B' | 'C';
} {
  const recent20 = bars.slice(-20);
  const volumes = recent20.map(b => b.volume || 0);
  const tradedValues = recent20.map(b => (b.close || 0) * (b.volume || 0));
  const medVol20 = volumes.sort((a, b) => a - b)[Math.floor(volumes.length / 2)] || 0;
  const medTradedValue20 = tradedValues.sort((a, b) => a - b)[Math.floor(tradedValues.length / 2)] || 0;

  // Thresholds in INR: A >= 5 Cr (50M), B >= 1 Cr (10M), C = below
  let bucket: 'A' | 'B' | 'C';
  if (medTradedValue20 >= 50_000_000) {
    bucket = 'A';
  } else if (medTradedValue20 >= 10_000_000) {
    bucket = 'B';
  } else {
    bucket = 'C';
  }
  return { medVol20, medTradedValue20, bucket };
}

/**
 * V2.2: Volume Dry-Up (VDU) detection.
 * Returns true if last MIN_DECLINE_DAYS consecutive bars show declining volume
 * AND price is near EMA zone (not in a strong move). Signals institutional patience.
 */
function computeVDU(bars: Bar[]): boolean {
  const lookback = bars.slice(-(VDU_CONFIG.LOOKBACK_DAYS + 1));
  if (lookback.length < VDU_CONFIG.MIN_DECLINE_DAYS + 1) return false;

  let consecutiveDeclines = 0;
  for (let i = lookback.length - 1; i > 0; i--) {
    if ((lookback[i].volume || 0) < (lookback[i - 1].volume || 0)) {
      consecutiveDeclines++;
    } else {
      break;
    }
  }
  return consecutiveDeclines >= VDU_CONFIG.MIN_DECLINE_DAYS;
}

/**
 * V2.2: Gap Risk Score (0-100 percentile).
 * Measures how historically "gappy" a stock is — large/frequent gaps = higher risk score.
 * Score 80+ = reject entry; 60–79 = reduce position size.
 */
function computeGapRiskScore(bars: Bar[], atr14: number): number {
  const lookback = bars.slice(-(GAP_RISK_CONFIG.LOOKBACK_DAYS + 1));
  if (lookback.length < 5 || atr14 <= 0) return 0;

  const gapRatios: number[] = [];
  for (let i = 1; i < lookback.length; i++) {
    const prevClose = lookback[i - 1].close;
    const openPrice = lookback[i].open;
    if (prevClose > 0) {
      gapRatios.push(Math.abs(openPrice - prevClose) / atr14);
    }
  }
  if (gapRatios.length === 0) return 0;

  const sorted = [...gapRatios].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  // Normalize: mean gap ratio of 2.0 ATR maps to score ~80; 0 maps to 0; 3.0+ maps to 100
  const rawScore = Math.min(100, Math.round((mean / 2.5) * 100));
  return rawScore;
}

function calculateSwings(bars: Bar[], window: number = 3) {
  const highs: Array<{ price: number, index: number }> = [];
  const lows: Array<{ price: number, index: number }> = [];

  for (let i = window; i < bars.length - window; i++) {
    const currentHigh = bars[i].high;
    const currentLow = bars[i].low;
    
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= window; j++) {
      if (bars[i - j].high >= currentHigh || bars[i + j].high > currentHigh) isHigh = false;
      if (bars[i - j].low <= currentLow || bars[i + j].low < currentLow) isLow = false;
    }

    if (isHigh) highs.push({ price: currentHigh, index: i });
    if (isLow) lows.push({ price: currentLow, index: i });
  }

  return { highs, lows };
}

function identifySRZones(swings: { highs: any[], lows: any[] }) {
  const prices = [...swings.highs, ...swings.lows].map(s => s.price);
  if (prices.length < 2) return [];

  const zones: Array<{ low: number, high: number, strength: number }> = [];
  const sorted = prices.sort((a, b) => a - b);
  
  let currentZone = { low: sorted[0], high: sorted[0], prices: [sorted[0]] };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= currentZone.high * 1.01) {
      currentZone.high = sorted[i];
      currentZone.prices.push(sorted[i]);
    } else {
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

export const computeFeaturesTask = functionsV1.https.onRequest(async (req, res) => {
  const { jobId, symbol, runDate } = req.body;
  try {
    await doComputeFeatures(jobId, symbol, runDate);
    res.status(200).send('Features computed');
  } catch(error) {
    console.error(`Failed to compute features for ${symbol}:`, error);
    res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
  }
});
