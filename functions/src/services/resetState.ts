import * as admin from 'firebase-admin';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

// Trade/run state cleared on reset. Price history (barsD/barsW), settings,
// universes, calendar, and event data are intentionally preserved.
const RESET_COLLECTIONS = [
  'jobs', 'logs', 'signals', 'paperOrders', 'paperFills',
  'regime', 'rsRanking', 'corrTopN', 'features',
  'aggregateStats', 'stats', 'accountLedger', 'alerts',
  'idempotency', 'journals',
];

export interface ResetOptions {
  equity: number;
}

export async function runResetTradingState(opts: ResetOptions): Promise<{ cleared: string[]; equity: number }> {
  if (!Number.isFinite(opts.equity) || opts.equity <= 0) {
    throw new Error('equity must be a positive number');
  }
  const db = getDb();
  const cleared: string[] = [];

  for (const name of RESET_COLLECTIONS) {
    await db.recursiveDelete(db.collection(name));
    cleared.push(name);
  }

  // Positions live under portfolio/default/positions.
  await db.recursiveDelete(db.collection('portfolio'));
  cleared.push('portfolio');

  // Reset the account: fresh equity, drawdown-tracking fields cleared.
  await db.collection('config').doc('account').set({
    equity: opts.equity,
    peakEquity: opts.equity,
    baseRiskPct: 0.005,
    maxOpenRiskR: 6,
    maxPositions: 10,
    strategyRiskWeights: {
      PullbackEOD: 1.0,
      BreakoutCloseEOD: 1.2,
      MeanReversionEOD: 0.8,
      ShortBounceEOD: 0.8,
      BearBounceEOD: 0.8,
      RSLeaderEOD: 1.0,
    },
    realizedPnl: 0,
    equityEMA25: admin.firestore.FieldValue.delete(),
    portfolioRealizedVol: admin.firestore.FieldValue.delete(),
    lastRealizedPnl: admin.firestore.FieldValue.delete(),
    lastRealizedSymbol: admin.firestore.FieldValue.delete(),
    lastRealizedAt: admin.firestore.FieldValue.delete(),
    resetAt: admin.firestore.Timestamp.now(),
  }, { merge: true });

  return { cleared, equity: opts.equity };
}
