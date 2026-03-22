import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { Features, Bar } from '../models';
import { logger } from './logger';

// Lazy load technicalindicators inside functions to avoid deployment timeouts

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

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

  // 1. Fetch historical bars up to the run date
  const barsSnap = await db.collection('barsD')
    .doc(symbol)
    .collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .get();

  if (barsSnap.empty || barsSnap.size < 25) {
    const errorMsg = `[Features Fail] Insufficient data for ${symbol}. Found ${barsSnap.size} bars. Needs 25.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Sort and limit locally to avoid emulator 'descending key scan' error
  const allBars = barsSnap.docs.map(d => d.data() as Bar);
  allBars.sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  
  // Take last 200 for indicator stability
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
    volSma20: bars.slice(-20).reduce((a, b) => a + (b.volume || 0), 0) / Math.min(20, bars.length),
    trendState,
    computedAt: Timestamp.now(),
    swing: { 
      lastSwingHigh, 
      lastSwingLow 
    },
    srZones,
    returns: {
      ret1d: (closes[closes.length - 1] / closes[closes.length - 2]) - 1,
      ret5d: (closes[closes.length - 1] / (closes[closes.length - 6] || closes[0])) - 1,
      ret20d: (closes[closes.length - 1] / (closes[closes.length - 21] || closes[0])) - 1,
    },
    barsCount: barsSnap.size, // Added for dashboard inventory grouping
    patterns: [] // Patterns logic can be expanded if needed
  };

  await db.collection('features').doc(symbol).collection('days').doc(dateId).set(featureDoc);
  
  await logger.info(`Features computed for ${symbol}: Trend=${trendState}, RSI=${rsi14.toFixed(2)}`, 'Features', { jobId, symbol });
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
