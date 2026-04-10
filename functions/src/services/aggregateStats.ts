import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal } from '../models';
import { DRAWDOWN_CONFIG } from '../config/runtime';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * V2.2: Compute Sharpe Ratio (annualized).
 * sharpe = mean(returns) / stdDev(returns) * sqrt(252)
 */
function computeSharpe(rList: number[], riskFreeRate = 0.065 / 252): number {
  if (rList.length < 2) return 0;
  const mean = rList.reduce((a, b) => a + b, 0) / rList.length;
  const variance = rList.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (rList.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return ((mean - riskFreeRate) / stdDev) * Math.sqrt(252);
}

/**
 * V2.2: Compute Sortino Ratio (annualized) — only penalizes downside deviation.
 */
function computeSortino(rList: number[], riskFreeRate = 0.065 / 252): number {
  if (rList.length < 2) return 0;
  const mean = rList.reduce((a, b) => a + b, 0) / rList.length;
  const negativeReturns = rList.filter(r => r < riskFreeRate);
  if (negativeReturns.length === 0) return 10; // no downside = excellent
  const downsideVar = negativeReturns.reduce((a, b) => a + Math.pow(b - riskFreeRate, 2), 0) / rList.length;
  const downsideDev = Math.sqrt(downsideVar);
  if (downsideDev === 0) return 0;
  return ((mean - riskFreeRate) / downsideDev) * Math.sqrt(252);
}

/**
 * V2.2: Compute max drawdown from equity curve.
 * Returns maxDrawdownPct (0-1) and peakEquity.
 */
function computeMaxDrawdown(equityCurve: number[]): { maxDrawdownPct: number; peakEquity: number } {
  if (equityCurve.length < 2) return { maxDrawdownPct: 0, peakEquity: equityCurve[0] ?? 0 };
  let peak = equityCurve[0];
  let maxDD = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return { maxDrawdownPct: maxDD, peakEquity: peak };
}

/**
 * V2.2: Update peak equity and equity curve EMA in account config.
 * Called after each trading day's PnL is realized.
 */
async function updateEquityCurve(db: FirebaseFirestore.Firestore, dateId: string): Promise<void> {
  const accountSnap = await db.collection('config').doc('account').get();
  if (!accountSnap.exists) return;
  const account = accountSnap.data() as any;
  const equity: number = account.equity ?? 0;
  const peakEquity: number = Math.max(account.peakEquity ?? equity, equity);

  // Store equity snapshot for equity curve tracking
  await db.collection('stats').doc('equityCurve').collection('days').doc(dateId).set({
    equity, dateId, recordedAt: admin.firestore.Timestamp.now(),
  });

  // Fetch last EQUITY_EMA_PERIOD equity snapshots to compute EMA
  const period = DRAWDOWN_CONFIG.EQUITY_EMA_PERIOD;
  const snapshots = await db.collection('stats').doc('equityCurve').collection('days')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(period)
    .get();

  const equities = snapshots.docs.map(d => (d.data() as any).equity as number).reverse();
  let equityEMA25 = equities[0] ?? equity;
  const k = 2 / (period + 1);
  for (let i = 1; i < equities.length; i++) {
    equityEMA25 = equities[i] * k + equityEMA25 * (1 - k);
  }

  await db.collection('config').doc('account').update({ peakEquity, equityEMA25 });
}

/**
 * Aggregate Stats V2.2: Computes strategy x regime performance + Sharpe, Sortino, MaxDD.
 */
export async function doAggregateStats(dateId: string) {
  const db = getDb();
  if (!dateId) {
    console.warn('[AggregateStats] Aborting: Missing dateId');
    return;
  }
  console.log(`[AggregateStats] Aggregating performance for ${dateId}`);

  // Update equity curve tracking first
  await updateEquityCurve(db, dateId);

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
    const sortedR5 = [...r5List].sort((a, b) => a - b);
    const medianR5 = sortedR5[Math.floor(sortedR5.length / 2)];
    const avgMFE = mfeList.reduce((a, b) => a + b, 0) / mfeList.length;
    const avgMAE = maeList.reduce((a, b) => a + b, 0) / maeList.length;

    const wins = r5List.filter(r => r > 0).length;
    const conservativeWinRate = (wins / r5List.length) * 100;
    const avgWin = r5List.filter(r => r > 0).reduce((a, b) => a + b, 0) / (wins || 1);
    const avgLoss = Math.abs(r5List.filter(r => r <= 0).reduce((a, b) => a + b, 0) / (r5List.length - wins || 1));
    const expectancy = (conservativeWinRate / 100 * avgWin) - ((1 - conservativeWinRate / 100) * avgLoss);

    // V2.2: Risk-adjusted metrics
    const sharpe = computeSharpe(r5List);
    const sortino = computeSortino(r5List);
    const { maxDrawdownPct } = computeMaxDrawdown(r5List.reduce((curve: number[], r) => {
      curve.push((curve[curve.length - 1] ?? 100) * (1 + r * 0.005));
      return curve;
    }, []));
    const calmar = maxDrawdownPct > 0 ? (avgR5 * 252) / maxDrawdownPct : 0;

    // V2.2: RS score distribution of approved signals
    const approvedSignals = signals.filter(s => s.status === 'APPROVED' || s.status === 'IN_TRADE' || s.status === 'DONE');
    const rsScores = approvedSignals.map(s => s.features?.rsScore ?? s.reasons?.rsScore ?? 0).filter(r => r > 0);
    const avgRsScore = rsScores.length > 0 ? rsScores.reduce((a, b) => a + b, 0) / rsScores.length : 0;

    const stats = {
      countSignals,
      countMonitored: monitored.length,
      avgR5,
      medianR5,
      avgMFE,
      avgMAE,
      conservativeWinRate,
      expectancy,
      // V2.2 additions
      sharpe: Math.round(sharpe * 100) / 100,
      sortino: Math.round(sortino * 100) / 100,
      calmar: Math.round(calmar * 100) / 100,
      maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 100, // as %
      avgRsScore: Math.round(avgRsScore),
      updatedAt: admin.firestore.Timestamp.now()
    };

    const path = `stats/strategies/${strategy}/regimes/${marketState}/days/${dateId}`;
    if (!strategy || !marketState || !dateId) {
      console.warn(`[AggregateStats] Skipping set: Invalid path components: ${path}`);
      continue;
    }
    await db.doc(path).set(stats);
    
    console.log(
      `[AggregateStats] ${strategy}/${marketState}: ` +
      `Expectancy=${expectancy.toFixed(2)}R Sharpe=${sharpe.toFixed(2)} ` +
      `Sortino=${sortino.toFixed(2)} MaxDD=${(maxDrawdownPct * 100).toFixed(1)}%`
    );
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
