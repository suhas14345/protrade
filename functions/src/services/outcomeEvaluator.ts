import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, Bar } from '../models';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Outcome Evaluator: Tracks forward performance of signals over a 5-day window.
 */
export async function doEvaluateOutcomes(dateId: string) {
  const db = getDb();
  console.log(`[OutcomeEvaluator] Evaluating returns for signals on ${dateId}`);

  // Find signals that were FILLED or more and are missing monitor data
  const signalsSnap = await db.collection('signals')
    .doc(dateId)
    .collection('items')
    .where('status', 'in', ['IN_TRADE', 'DONE'])
    .get();

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    const signalId = doc.id;

    if (!signal.execution?.entryPrice || !signal.execution?.entryDateId) continue;

    const entryPrice = signal.execution.entryPrice;
    const entryDateId = signal.execution.entryDateId;
    
    // Gap 4: Use definitive stopPrice, fallback to indicative if needed (should not happen if FILLED)
    const stopPrice = signal.stopPrice ?? signal.indicativeStopPrice;
    const targets = signal.targets ?? signal.indicativeTargets;
    
    const riskPerShare = Math.abs(entryPrice - stopPrice);
    if (riskPerShare === 0) continue;

    // Load next 10 bars from entry date to find R1, R3, R5
    const barsSnap = await db.collection('barsD')
      .doc(signal.symbol)
      .collection('days')
      .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .limit(10)
      .get();

    const forwardBars = barsSnap.docs.map(d => d.data() as Bar);
    if (forwardBars.length < 2) continue; // Need at least one bar after entry

    const monitor: any = signal.monitor || {};

    // R-multiples (normalized returns)
    const getR = (price: number) => (price - entryPrice) / riskPerShare * (signal.direction === 'BUY' ? 1 : -1);

    if (forwardBars[1]) monitor.r1 = getR(forwardBars[1].close);
    if (forwardBars[3]) monitor.r3 = getR(forwardBars[3].close);
    if (forwardBars[5]) monitor.r5 = getR(forwardBars[5].close);

    // MFE/MAE over the first 5 days
    const window = forwardBars.slice(0, 6);
    const highs = window.map(b => b.high);
    const lows = window.map(b => b.low);

    if (signal.direction === 'BUY') {
        monitor.mfeR = (Math.max(...highs) - entryPrice) / riskPerShare;
        monitor.maeR = (entryPrice - Math.min(...lows)) / riskPerShare;
        monitor.hitStop = Math.min(...lows) <= stopPrice;
        monitor.hitTarget = Math.max(...highs) >= (targets[0] || 0);
    } else {
        monitor.mfeR = (entryPrice - Math.min(...lows)) / riskPerShare;
        monitor.maeR = (Math.max(...highs) - entryPrice) / riskPerShare;
        monitor.hitStop = Math.max(...highs) >= stopPrice;
        monitor.hitTarget = Math.min(...lows) <= (targets[0] || 0);
    }

    await db.collection('signals').doc(dateId).collection('items').doc(signalId).update({ monitor });
    console.log(`[OutcomeEvaluator] Updated monitor for ${signal.symbol}: R5=${monitor.r5?.toFixed(2)}`);
  }
}

export const evaluateOutcomesTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId } = req.body;
  try {
    await doEvaluateOutcomes(dateId);
    res.status(200).send('Outcomes evaluated');
  } catch (error) {
    console.error('Outcome evaluation failed:', error);
    res.status(500).send('Internal Error');
  }
});
