import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Regime } from '../models';
import { logger } from './logger';
import { getLatestOnOrBefore } from './barCache';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

const toDateId = (date: string) => date.replace(/-/g, '');

// docIdField moved inside functions to ensure admin is initialized

type AnyRecord = Record<string, any>;

async function getLatestBarOnOrBefore(db: FirebaseFirestore.Firestore, symbol: string, dateId: string) {
  const bar = await getLatestOnOrBefore(db, symbol, dateId);
  if (!bar) return null;
  return { id: bar.dateId as string, ...(bar as AnyRecord) };
}

async function getEma200SlopeNeg(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string,
  lookbackBars = 20
): Promise<boolean | null> {
  // Try to infer slope of EMA200 using historical feature snapshots
  // slopeNeg = ema200(t) - ema200(t-lookback) < 0
  const snap = await db
    .collection('features')
    .doc(symbol)
    .collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .get();

  if (snap.empty || snap.size < lookbackBars + 1) return null;

  const docs = snap.docs.slice(-(lookbackBars + 1)); // oldest -> newest
  const first = docs[0].data() as AnyRecord;
  const last = docs[docs.length - 1].data() as AnyRecord;

  const ema200First = Number(first.ema200);
  const ema200Last = Number(last.ema200);

  if (!Number.isFinite(ema200First) || !Number.isFinite(ema200Last)) return null;

  return (ema200Last - ema200First) < 0;
}

/**
 * V2.3: Compute real breadth metrics from universe member features.
 * Scans all universe members' features for the given date to compute:
 * - % above EMA50, % above EMA200
 * - New 20-day highs, new 20-day lows
 * Falls back to neutral defaults if data is insufficient.
 */
async function computeUniverseBreadth(db: FirebaseFirestore.Firestore, dateId: string, universeId: string = 'nifty500'): Promise<{
  pctAboveEMA50: number;
  pctAboveEMA200: number;
  newHighs20: number;
  newLows20: number;
}> {
  const defaults = { pctAboveEMA50: 50, pctAboveEMA200: 50, newHighs20: 25, newLows20: 25 };

  try {
    const universeSnap = await db.collection('universes').doc(universeId).collection('members').get();
    if (universeSnap.empty) return defaults;

    const symbols = universeSnap.docs.map(d => d.id);
    let total = 0;
    let aboveEma50 = 0;
    let aboveEma200 = 0;
    let newHighs = 0;
    let newLows = 0;

    // Process in batches of 50 to avoid overwhelming Firestore
    const batchSize = 50;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const featurePromises = batch.map(sym =>
        db.collection('features').doc(sym).collection('days').doc(dateId).get()
      );
      const featureSnaps = await Promise.all(featurePromises);

      for (const snap of featureSnaps) {
        if (!snap.exists) continue;
        const feat = snap.data() as any;
        const close = Number(feat.close || feat.ema20); // Use EMA20 as close proxy if close unavailable
        const ema50 = Number(feat.ema50);
        const ema200 = Number(feat.ema200);

        if (!Number.isFinite(close) || close <= 0) continue;
        total++;

        if (Number.isFinite(ema50) && ema50 > 0 && close > ema50) aboveEma50++;
        if (Number.isFinite(ema200) && ema200 > 0 && close > ema200) aboveEma200++;

        // Check if close is a 20-day high or low using trendState hints
        const high20 = Number(feat.high20 || 0);
        const low20 = Number(feat.low20 || Infinity);
        
        if (high20 > 0 && close >= high20) newHighs++;
        if (low20 < Infinity && close <= low20) newLows++;
      }
    }

    if (total < 10) return defaults; // Not enough data

    return {
      pctAboveEMA50: Math.round((aboveEma50 / total) * 100),
      pctAboveEMA200: Math.round((aboveEma200 / total) * 100),
      newHighs20: Math.round((newHighs / total) * 100),
      newLows20: Math.round((newLows / total) * 100),
    };
  } catch (err: any) {
    console.warn(`[Regime] Breadth computation failed, using defaults: ${err.message}`);
    return defaults;
  }
}

/**
 * HTTP Trigger to compute the Market Regime for the universe.
 */
export async function doComputeRegime(date: string, jobId?: string, providedIndexSymbol?: string, universeId: string = 'nifty500') {
  const db = getDb();
  const dateId = toDateId(date);

  console.log(`Computing Market Regime for ${date}`);

  // 1. Fetch Index Features (Default to NIFTY 50 if providedIndexSymbol is missing but it's a Kite run)
  // We'll check settings to decide the best default
  let indexSymbol = providedIndexSymbol;
  if (!indexSymbol) {
    const settingsSnap = await db.collection('settings').doc('kite').get();
    const settings = settingsSnap.data();
    indexSymbol = settings?.accessToken ? 'NIFTY 50' : '^NSEI';
  }

  const dateObj = new Date(date + 'T00:00:00Z'); // Force UTC
  const dayOfWeek = dateObj.getUTCDay(); // 0 = Sunday, 6 = Saturday
  
  let checkDates = [dateId];
  if (dayOfWeek === 6) { // Saturday -> check Friday
    const fri = new Date(dateObj.getTime() - 86400000);
    checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
  } else if (dayOfWeek === 0) { // Sunday -> check Friday
    const fri = new Date(dateObj.getTime() - 2 * 86400000);
    checkDates.push(fri.toISOString().split('T')[0].replace(/-/g, ''));
  }

  let indexFeatSnap: any = null;
  let effectiveDateId = dateId;

  for (const dId of checkDates) {
    const snap = await db.collection('features').doc(indexSymbol).collection('days').doc(dId).get();
    if (snap.exists) {
      indexFeatSnap = snap;
      effectiveDateId = dId;
      await logger.info(`[Regime] Found effective features on ${dId}`, 'Regime', { jobId, indexSymbol, dId });
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
  let marketState: Regime['marketState'] = 'TRANSITION';
  let rawState: Regime['marketState'] = 'TRANSITION'; // raw computed regime, pre-hysteresis (drives confirmation counting)
  let riskMultiplier = 0.0;
  let notes = `Computing regime for ${indexSymbol} on ${date} (using ${effectiveDateId})`;
  let breadth: { pctAboveEMA50: number; pctAboveEMA200: number; newHighs20: number; newLows20: number; universeMedianRet20d?: number; universeMedianRet60d?: number } = { pctAboveEMA50: 0, pctAboveEMA200: 0, newHighs20: 0, newLows20: 0 };
  let persistenceDays = 0;

  if (indexFeatSnap && latestIndexBar) {
    const feat = indexFeatSnap.data() as AnyRecord;

    const ema20 = Number(feat.ema20);
    const ema50 = Number(feat.ema50);
    const ema200 = Number(feat.ema200);
    const atrp = Number(feat.atrp);
    const atrpMa100 = Number(feat.atrpMa100);
    const trendState = String(feat.trendState || '');

    const currentClose = Number((latestIndexBar as any).close);

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
    // V3.0: Compute breadth first for confirmation
    breadth = await computeUniverseBreadth(db, effectiveDateId, universeId);
    
    if (isEma200Bear && (ema200SlopeNeg ?? true)) {
      marketState = 'BEAR';
      riskMultiplier = 0.5;
      notes =
        ema200SlopeNeg === null
          ? 'Index below EMA200. (EMA200 slope unavailable; using position only.)'
          : 'Index below EMA200 with negative EMA200 slope. Long-term bearish bias active.';
    } else if (isEmaTrendBear) {
      marketState = 'BEAR';
      riskMultiplier = 0.75;
      notes = 'Index EMA20 < EMA50. Short-term bearish trend active.';
    } else if (hasVol && atrp > 1.5 * atrpMa100) {
      marketState = 'HIGH_VOL';
      riskMultiplier = 0.5;
      notes = 'Volatility spike detected on Index.';
    } else if (trendState === 'UP') {
      // V3.0: Breadth confirmation — TREND requires majority above EMA50
      const { REGIME_HARDENING } = await import('../config/runtime');
      if (breadth.pctAboveEMA50 >= REGIME_HARDENING.TREND_BREADTH_MIN * 100) {
        marketState = 'TREND';
        riskMultiplier = 1.0;
        notes = `Index uptrend confirmed by breadth (${breadth.pctAboveEMA50.toFixed(0)}% > EMA50).`;
      } else {
        marketState = 'RANGE';
        riskMultiplier = 0.85;
        notes = `Index UP but weak breadth (${breadth.pctAboveEMA50.toFixed(0)}% > EMA50 < ${REGIME_HARDENING.TREND_BREADTH_MIN*100}%). Downgraded to RANGE.`;
      }
    } else {
      marketState = 'RANGE';
      riskMultiplier = 1.0;
      notes = 'Default range regime.';
    }

    // V3.0: Breadth confirmation for BEAR — must have weak breadth
    if (marketState === 'BEAR') {
      const { REGIME_HARDENING } = await import('../config/runtime');
      if (breadth.pctAboveEMA50 > REGIME_HARDENING.BEAR_BREADTH_MAX * 100 * 1.5) {
        // Breadth doesn't confirm bear — could be index-specific weakness
        marketState = 'RANGE';
        riskMultiplier = 0.85;
        notes += ` [Breadth override: ${breadth.pctAboveEMA50.toFixed(0)}% above EMA50 doesn't confirm BEAR]`;
      }
    }

    // V3.0: Regime hysteresis — require N consecutive bars of a NEW regime before
    // adopting it. Confirmation MUST be counted from the raw computed regime
    // (`rawState`), not from the persisted `marketState`: while a change is pending
    // we overwrite `marketState` with TRANSITION, so counting from it can never
    // accumulate and the system dead-locks permanently in TRANSITION (no-trade).
    // Bounded ascending key-range scan then inspect the most-recent bars in memory
    // (the emulator rejects descending key scans / limitToLast).
    const { REGIME_HARDENING: RH } = await import('../config/runtime');
    const rawComputedState = marketState;
    rawState = rawComputedState;
    // Look back far enough to both (a) confirm HYSTERESIS_BARS and (b) reach the
    // last confirmed (non-TRANSITION) regime even after a run of pending bars.
    const lookbackBars = Math.max(RH.HYSTERESIS_BARS * 4, 12);
    const lbDate = new Date(Date.UTC(+effectiveDateId.slice(0, 4), +effectiveDateId.slice(4, 6) - 1, +effectiveDateId.slice(6, 8)));
    lbDate.setUTCDate(lbDate.getUTCDate() - Math.ceil(lookbackBars * 1.7) - 15);
    const regimeLowerBound = `${lbDate.getUTCFullYear()}${String(lbDate.getUTCMonth() + 1).padStart(2, '0')}${String(lbDate.getUTCDate()).padStart(2, '0')}`;
    const prevRegimeSnap = await db.collection('regime')
      .where(admin.firestore.FieldPath.documentId(), '>=', regimeLowerBound)
      .where(admin.firestore.FieldPath.documentId(), '<', effectiveDateId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .get();
    const priorDocs = prevRegimeSnap.docs.filter((d) => d.id < effectiveDateId);

    // Most-recent effective regime that was actually adopted (not TRANSITION).
    let lastConfirmedState = '';
    for (let i = priorDocs.length - 1; i >= 0; i--) {
      const s = priorDocs[i].data().marketState;
      if (s && s !== 'TRANSITION') { lastConfirmedState = s; break; }
    }
    // Consecutive trailing bars whose RAW computed regime equals today's raw regime.
    let rawRun = 0;
    for (let i = priorDocs.length - 1; i >= 0; i--) {
      const rs = priorDocs[i].data().rawState || priorDocs[i].data().marketState;
      if (rs === rawComputedState) rawRun++; else break;
    }

    // If the new regime differs from the last confirmed one and hasn't yet been
    // seen for HYSTERESIS_BARS consecutive bars (today included), stay in TRANSITION.
    if (lastConfirmedState && lastConfirmedState !== rawComputedState && rawRun < RH.HYSTERESIS_BARS - 1) {
      marketState = 'TRANSITION';
      riskMultiplier = 0.5;
      notes = `Regime change ${lastConfirmedState}→${rawComputedState} pending (${rawRun + 1}/${RH.HYSTERESIS_BARS} bars confirmed). Using TRANSITION.`;
    }

    // V3.0: Persistence score — how long the (now effective) regime has held.
    persistenceDays = lastConfirmedState === marketState ? rawRun + 1 : 1;
  } else {
    const errorParts = [];
    if (!indexFeatSnap) {
      errorParts.push(`Features missing for ${indexSymbol}`);
    }
    if (!latestIndexBar) {
      errorParts.push(`Latest bar missing for ${indexSymbol}`);
    }
    const errorMsg = `[Regime Fail] ${errorParts.join(' & ')} on ${date}. Cannot proceed safely.`;
    await logger.error(errorMsg, 'Regime', { jobId, indexSymbol, date, dateId });
    
    // Save a transition regime so the system knows we tried but failed due to missing data
    const failRegime: Regime = {
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

  const regimeDoc: Regime = {
    marketState,
    tradeAllowed: marketState !== 'TRANSITION',
    riskMultiplier,
    maxNewPositions:
      marketState === 'BEAR' || marketState === 'HIGH_VOL' ? 2 :
      marketState === 'TRANSITION' ? 0 : 5,
    minSignalScore: 60,
    notes,
    reason: notes,
    metrics: {
      close: Number((latestIndexBar as any).close),
      ema200: indexFeatSnap.data()?.ema200,
      ema200Slope: await getEma200SlopeNeg(db, indexSymbol, effectiveDateId, 20) === true ? -0.01 : 0.01,
      ema20: indexFeatSnap.data()?.ema20,
    },
    breadth,
    // V3.0: Persistence and hysteresis tracking
    rawState,
    persistenceDays,
    regimeConfirmed: marketState !== 'TRANSITION',
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

export const computeRegimeTask = functionsV1.https.onRequest(async (req, res) => {
  const { date, jobId } = req.query;

  if (!date || typeof date !== 'string') {
    res.status(400).send('Missing "date" parameter');
    return;
  }

  try {
    const regimeDoc = await doComputeRegime(date, typeof jobId === 'string' ? jobId : undefined);
    res.status(200).send({ message: 'Regime computed', regimeDoc });
  } catch (error) {
    console.error('Failed to compute regime:', error);
    res.status(500).send('Internal Error');
  }
});
