import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Bar, Features } from '../models';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Weekly Feature Engine: Computes weekly bars and indicators from daily data.
 */
export async function doComputeWeeklyFeatures(symbol: string, dateId: string) {
  const db = getDb();
  console.log(`[WeeklyEngine] Computing weekly for ${symbol} @ ${dateId}`);

  // 1. Determine the week ID (YYYYWW)
  // Simple ISO week calculation
  const date = new Date(dateId.slice(0, 4) + '-' + dateId.slice(4, 6) + '-' + dateId.slice(6, 8));
  const weekId = getISOWeekId(date);

  // 2. Load the last 30 daily bars to aggregate the current week
  // We need all bars for the week containing dateId
  const barsSnap = await db.collection('barsD')
    .doc(symbol)
    .collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(30)
    .get();

  const dailyBars = barsSnap.docs.map(d => ({ id: d.id, ...d.data() as Bar })).reverse();
  
  // Group by week and find the current one
  const currentWeekBars = dailyBars.filter(b => {
    const d = new Date(b.id.slice(0, 4) + '-' + b.id.slice(4, 6) + '-' + b.id.slice(6, 8));
    return getISOWeekId(d) === weekId;
  });

  if (currentWeekBars.length === 0) return;

  const weeklyBar: Bar = {
    open: currentWeekBars[0].open,
    high: Math.max(...currentWeekBars.map(b => b.high)),
    low: Math.min(...currentWeekBars.map(b => b.low)),
    close: currentWeekBars[currentWeekBars.length - 1].close,
    volume: currentWeekBars.reduce((sum, b) => sum + b.volume, 0),
    timestamp: admin.firestore.Timestamp.now()
  };

  await db.collection('barsW').doc(symbol).collection('weeks').doc(weekId).set(weeklyBar);

  // 3. Compute Weekly EMA (requires historical weekly bars)
  const historySnap = await db.collection('barsW')
    .doc(symbol)
    .collection('weeks')
    .where(admin.firestore.FieldPath.documentId(), '<=', weekId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(100)
    .get();

  const history = historySnap.docs.map(d => d.data() as Bar).reverse();
  const ema20 = computeEMA(history.map(b => b.close), 20);
  const ema50 = computeEMA(history.map(b => b.close), 50);

  const weeklyFeatures: Partial<Features> = {
    ema20,
    ema50,
    computedAt: admin.firestore.Timestamp.now()
  };

  await db.collection('features').doc(symbol).collection('weeks').doc(weekId).set(weeklyFeatures);
  console.log(`[WeeklyEngine] ${symbol} Week ${weekId}: EMA20=${ema20?.toFixed(2)}, EMA50=${ema50?.toFixed(2)}`);
}

function getISOWeekId(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}${weekNo.toString().padStart(2, '0')}`;
}

// Simple EMA helper (re-using or adding here)
function computeEMA(data: number[], period: number): number | undefined {
    if (data.length < period) return undefined;
    let ema = data.slice(0, period).reduce((a, b) => a + b) / period;
    const K = 2 / (period + 1);
    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * K + ema;
    }
    return ema;
}

export const computeWeeklyTask = functionsV1.https.onRequest(async (req, res) => {
  const { symbol, dateId } = req.body;
  try {
    await doComputeWeeklyFeatures(symbol, dateId);
    res.status(200).send('Weekly processed');
  } catch (error) {
    console.error('Weekly processing failed:', error);
    res.status(500).send('Internal Error');
  }
});
