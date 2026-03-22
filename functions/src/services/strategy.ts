import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, Features, Regime, Bar } from '../models';
import { STRATEGY_V11 } from '../config/runtime';
import { checkSafety } from './safety';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

const toDateId = (date: string) => date.replace(/-/g, '');

type BarDoc = Bar & { id: string };

// Helper: V1.1 Mandatory ATR Proximity
function isAtrNormalizedEmaTouch(close: number, low: number, high: number, ema20: number, ema50: number, atr14: number) {
  // A) within ATR proximity to EMA20
  if (Math.abs(close - ema20) <= STRATEGY_V11.EMA_TOUCH_ATR_MULT * atr14) return true;
  // B) inside EMA band
  const lo = Math.min(ema20, ema50);
  const hi = Math.max(ema20, ema50);
  if (close >= lo && close <= hi) return true;
  // C) Range touch (low/high intersect band)
  if (low <= hi && high >= lo) return true;
  return false;
}

// Helper: V1.1 Volume Breakout Confirm
function breakoutVolumeOk(volume: number, volSma20: number) {
  return volume >= STRATEGY_V11.BREAKOUT_VOL_MULT * (volSma20 || 0);
}

// Helper: V1.1 Trend Neutrality
function isTrendNeutral(close: number, ema20: number, ema50: number) {
  return (Math.abs(ema20 - ema50) / close) < STRATEGY_V11.RANGE_TREND_NEUTRAL_MAX;
}

// Helper: V1.1 Earnings Block (Placeholder)
async function isEntryBlockedByEarnings(symbol: string, runDate: string) {
  // TODO: Integrate with earnings data source. 
  // For now, always return false to avoid blocking legitimate trades.
  return false;
}

async function getRecentBarsOnOrBefore(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string,
  limit: number
): Promise<BarDoc[]> {
  const snap = await db
    .collection('barsD')
    .doc(symbol)
    .collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .get();

  if (snap.empty) return [];

  return snap.docs
    .map(d => ({ id: d.id, ...(d.data() as Bar) }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(-limit);
}

function isFinitePos(n: unknown) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0;
}

/**
 * Evaluate strategies and generate signals for a symbol.
 */
export async function doEvaluateSignals(jobId: string, symbol: string, runDate: string) {
  const db = getDb();
  const dateId = toDateId(runDate);

  const checkId = `${symbol}_${dateId}_PullbackEOD`;
  const existingSig = await db.collection('signals').doc(dateId).collection('items').doc(checkId).get();
  
  if (existingSig.exists) {
    console.log(`[Strategy] Job ${jobId} symbol ${symbol}: Signals for ${runDate} already exist. Skipping.`);
    return;
  }

  // 1. Load Features
  const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
  if (!featSnap.exists) {
    await logger.warn(`Features not found for ${symbol} on ${runDate}`, 'Strategy', { jobId, symbol });
    return;
  }
  const features = featSnap.data() as Features;

  // 2. Load Regime
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  if (!regimeSnap.exists) {
    await logger.warn(`Regime not found for ${runDate}`, 'Strategy', { jobId });
    return;
  }
  const regime = regimeSnap.data() as Regime;

  if (!regime.tradeAllowed) return;

  // 3. Load bars
  const bars = await getRecentBarsOnOrBefore(db, symbol, dateId, 30);
  if (bars.length === 0) return;

  const lastBar = bars[bars.length - 1];
  checkSafety(lastBar);

  // 4. Extract key indicators
  const ema20 = Number(features.ema20);
  const ema50 = Number(features.ema50);
  const rsi = Number(features.rsi14 ?? 50);
  const atr = Number(features.atr14);
  const bbLower = Number(features.bbLower);
  const volSma20 = Number(features.volSma20 || 0);
  const currentClose = Number(lastBar.close);

  if (!isFinitePos(currentClose) || !isFinitePos(ema20) || !isFinitePos(ema50) || !Number.isFinite(rsi) || !isFinitePos(atr)) {
    return;
  }

  // Earnings Block Check
  const earningsBlocked = await isEntryBlockedByEarnings(symbol, runDate);

  // 5. Strategy conditions (V1.1 DELTAS)

  // A) PullbackEOD
  const isLongPullback =
    !earningsBlocked &&
    (regime.marketState === 'TREND' || regime.marketState === 'RANGE') &&
    ema20 > ema50 &&
    isAtrNormalizedEmaTouch(currentClose, Number(lastBar.low), Number(lastBar.high), ema20, ema50, atr) &&
    rsi >= 40 && rsi <= 55;

  // B) BreakoutCloseEOD
  let isBreakout = false;
  if (!earningsBlocked && regime.marketState === 'TREND' && ema20 > ema50 && bars.length >= 21) {
    const prev20 = bars.slice(-21, -1);
    const prev20High = Math.max(...prev20.map(b => Number(b.high)));
    isBreakout = currentClose > prev20High && breakoutVolumeOk(Number(lastBar.volume), volSma20);
  }

  // C) MeanReversionEOD
  const isMeanReversion =
    !earningsBlocked &&
    regime.marketState === 'RANGE' &&
    currentClose < bbLower &&
    rsi < 30 &&
    isTrendNeutral(currentClose, ema20, ema50);

  // D) ShortBounceEOD
  const isShortBounce =
    !earningsBlocked &&
    (regime.marketState === 'BEAR' || regime.marketState === 'HIGH_VOL') &&
    ema20 < ema50 &&
    isAtrNormalizedEmaTouch(currentClose, Number(lastBar.low), Number(lastBar.high), ema20, ema50, atr) &&
    rsi >= 45 && rsi <= 65;

  // 6. Create signals
  const activeStrategies = [
    { condition: isLongPullback, name: 'PullbackEOD', direction: 'BUY' as const },
    { condition: isShortBounce, name: 'ShortBounceEOD', direction: 'SELL' as const },
    { condition: isBreakout, name: 'BreakoutCloseEOD', direction: 'BUY' as const },
    { condition: isMeanReversion, name: 'MeanReversionEOD', direction: 'BUY' as const },
  ].filter(s => s.condition);

  if (activeStrategies.length === 0) return;

  for (const strat of activeStrategies) {
    const stopPrice =
      strat.direction === 'BUY'
        ? currentClose - (atr * 2)
        : currentClose + (atr * 2);

    let targetPrice =
      strat.direction === 'BUY'
        ? currentClose + (atr * 3)
        : currentClose - (atr * 3);

    // V1.1 ShortBounce Target Override in HIGH_VOL
    if (strat.name === 'ShortBounceEOD' && regime.marketState === 'HIGH_VOL') {
      targetPrice = currentClose - (atr * STRATEGY_V11.HIGH_VOL_SHORT_TARGET_ATR);
    }

    const signal: Signal & { features?: any, atrAtEntry?: number } = {
      symbol,
      direction: strat.direction,
      strategy: strat.name as any,
      score: 80,
      features: features as any,
      entryPlan: { type: 'NEXT_OPEN' },
      stopPrice,
      targets: [targetPrice],
      rr: Math.abs(targetPrice - currentClose) / Math.abs(currentClose - stopPrice),
      checklist: { regimeAligned: true, indicatorMatch: true },
      reasons: {
        rsi,
        close: currentClose,
        ema20,
        ema50,
        marketState: regime.marketState,
        v11: true
      },
      status: 'NEW',
    };

    const signalId = `${symbol}_${dateId}_${strat.name}`;
    await db.collection('signals').doc(dateId).collection('items').doc(signalId).set(signal);
    await logger.info(`Generated ${strat.name} signal for ${symbol} at ${currentClose}`, 'Strategy', { jobId, symbol });
  }
}

export const evaluateSignalsTask = functionsV1.https.onRequest(async (req, res) => {
  const { jobId, symbol, runDate } = req.body || {};

  if (!jobId || !symbol || !runDate) {
    res.status(400).send('Missing required fields: jobId, symbol, runDate');
    return;
  }

  try {
    await doEvaluateSignals(String(jobId), String(symbol), String(runDate));
    res.status(200).send('Signals evaluated');
  } catch (error) {
    console.error(`Failed to evaluate signals for ${symbol}:`, error);
    res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
  }
});
