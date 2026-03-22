import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal } from '../models';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Aggregate Stats: Computes strategy x regime performance metrics.
 */
export async function doAggregateStats(dateId: string) {
  const db = getDb();
  console.log(`[AggregateStats] Aggregating performance for ${dateId}`);

  // Load all signals for the date that have monitor data
  const signalsSnap = await db.collection('signals')
    .doc(dateId)
    .collection('items')
    .get();

  const groups: Record<string, Signal[]> = {};

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    const key = `${signal.strategy}_${signal.reasons.marketState || 'UNKNOWN'}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(signal);
  }

  for (const [key, signals] of Object.entries(groups)) {
    const [strategy, marketState] = key.split('_');

    const monitored = signals.filter(s => s.monitor && s.monitor.r5 !== undefined);
    if (monitored.length === 0) continue;

    const r5List = monitored.map(s => s.monitor!.r5!);
    const mfeList = monitored.map(s => s.monitor!.mfeR || 0);
    const maeList = monitored.map(s => s.monitor!.maeR || 0);
    
    const countSignals = signals.length;
    const avgR5 = r5List.reduce((a, b) => a + b, 0) / r5List.length;
    const medianR5 = r5List.sort((a, b) => a - b)[Math.floor(r5List.length / 2)];
    const avgMFE = mfeList.reduce((a, b) => a + b, 0) / mfeList.length;
    const avgMAE = maeList.reduce((a, b) => a + b, 0) / maeList.length;

    // Conservative Win Rate: R5 > 0
    const wins = r5List.filter(r => r > 0).length;
    const conservativeWinRate = (wins / r5List.length) * 100;

    // Expectancy: (WinRate * AvgWin) - (LossRate * AvgLoss)
    const avgWin = r5List.filter(r => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
    const avgLoss = Math.abs(r5List.filter(r => r <= 0).reduce((a, b) => a + b, 0) / (monitored.length - wins || 1));
    const expectancy = (conservativeWinRate / 100 * avgWin) - ((1 - conservativeWinRate / 100) * avgLoss);

    const stats = {
      countSignals,
      countMonitored: monitored.length,
      avgR5,
      medianR5,
      avgMFE,
      avgMAE,
      conservativeWinRate,
      expectancy,
      updatedAt: admin.firestore.Timestamp.now()
    };

    const path = `stats/strategies/${strategy}/regimes/${marketState}/days/${dateId}`;
    // Create nested structure if needed (Firestore does this automatically)
    await db.doc(path).set(stats);
    
    console.log(`[AggregateStats] Updated stats for ${strategy} in ${marketState}: Expectancy=${expectancy.toFixed(2)}`);
  }
}

export const aggregateStatsTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId } = req.body;
  try {
    await doAggregateStats(dateId);
    res.status(200).send('Stats aggregated');
  } catch (error) {
    console.error('Stats aggregation failed:', error);
    res.status(500).send('Internal Error');
  }
});
