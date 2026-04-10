import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { CORR_CONFIG } from '../config/runtime';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CorrPeer {
  symbol: string;
  corr: number; // Pearson correlation coefficient [-1, 1]
}

export interface CorrTopNDoc {
  symbol: string;
  topCorrelated: CorrPeer[]; // sorted desc by |corr|, only corr >= THRESHOLD
  computedAt: FirebaseFirestore.Timestamp;
  lookbackDays: number;
  pairsEvaluated: number;
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

/**
 * Compute Pearson correlation coefficient between two equal-length arrays.
 * Returns NaN if insufficient data or zero variance.
 */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 5 || n !== y.length) return NaN;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += x[i];
    sumY  += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));
  return den === 0 ? NaN : num / den;
}

/**
 * Compute daily log-returns from an array of closing prices.
 * Returns array of length (prices.length - 1).
 */
function dailyReturns(closes: number[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    rets.push(prev > 0 ? Math.log(closes[i] / prev) : 0);
  }
  return rets;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

/**
 * Fetch closing prices for a symbol over the last `limit` trading days on or before dateId.
 * Returns sorted-ascending closes array.
 */
async function fetchCloses(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string,
  limit: number,
): Promise<number[]> {
  const snap = await db
    .collection('barsD')
    .doc(symbol)
    .collection('days')
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .limitToLast(limit)
    .get();

  if (snap.empty) return [];
  return snap.docs.map(d => Number((d.data() as any).close)).filter(c => c > 0);
}

// ─── Main computation ─────────────────────────────────────────────────────────

/**
 * V2.2: Compute corrTopN for the entire universe on a given date.
 *
 * Algorithm:
 *  1. Load last (LOOKBACK_DAYS + 1) closing prices for each symbol.
 *  2. Compute LOOKBACK_DAYS daily log-returns per symbol.
 *  3. Align return arrays to a common length (inner join on available bars).
 *  4. Compute all N*(N-1)/2 Pearson correlation pairs.
 *  5. For each symbol, store the top CORR_TOP_N peers with |corr| >= THRESHOLD.
 *  6. Write corrTopN/{dateId}/symbols/{symbol} docs in Firestore batches.
 *
 * Runtime estimate for 500 symbols:
 *   Reads  : 500 × 62 bars  ≈ 31,000 Firestore reads
 *   Compute: 500×499/2      ≈ 124,750 correlation pairs   (< 1s in Node.js)
 *   Writes : 500 docs (batched at 400)
 */
export async function doComputeCorrTopN(dateId: string, jobId?: string, universeId: string = 'nifty500'): Promise<void> {
  const db = getDb();
  await logger.info(`[CorrTopN] Computing correlation matrix for ${dateId}`, 'CorrTopN', { dateId, jobId });

  // 1. Load universe
  const universeSnap = await db
    .collection('universes')
    .doc(universeId)
    .collection('members')
    .get();

  if (universeSnap.empty) {
    await logger.warn('[CorrTopN] Universe empty — skipping', 'CorrTopN', { dateId });
    return;
  }

  const symbols = universeSnap.docs.map(d => d.id);
  const barsNeeded = CORR_CONFIG.LOOKBACK_DAYS + 1; // +1 to compute LOOKBACK_DAYS returns

  // 2. Load closes for all symbols (chunked to manage parallel Firestore load)
  const CHUNK_SIZE = 30;
  const symbolReturns = new Map<string, number[]>(); // symbol → daily returns array

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk = symbols.slice(i, i + CHUNK_SIZE);
    const closesArr = await Promise.all(
      chunk.map(sym => fetchCloses(db, sym, dateId, barsNeeded))
    );
    for (let j = 0; j < chunk.length; j++) {
      const closes = closesArr[j];
      if (closes.length >= 5) { // Need at least 5 return points
        symbolReturns.set(chunk[j], dailyReturns(closes));
      }
    }
  }

  const activeSymbols = Array.from(symbolReturns.keys());
  const n = activeSymbols.length;
  await logger.info(`[CorrTopN] Loaded returns for ${n} symbols`, 'CorrTopN', { dateId });

  if (n < 2) {
    await logger.warn('[CorrTopN] Insufficient symbols with data — skipping', 'CorrTopN', { dateId });
    return;
  }

  // 3. Compute all unique pairs and collect top-N per symbol
  // topPeers[i] = array of {symbol, corr} for symbol i, sorted by |corr| desc
  const topPeers: Map<string, CorrPeer[]> = new Map();
  for (const sym of activeSymbols) topPeers.set(sym, []);

  let pairsEvaluated = 0;
  let significantPairs = 0;

  for (let i = 0; i < n; i++) {
    const symA = activeSymbols[i];
    const retA = symbolReturns.get(symA)!;

    for (let j = i + 1; j < n; j++) {
      const symB = activeSymbols[j];
      const retB = symbolReturns.get(symB)!;

      // Align to common length (inner join)
      const minLen = Math.min(retA.length, retB.length);
      const a = retA.slice(-minLen);
      const b = retB.slice(-minLen);

      const corr = pearson(a, b);
      pairsEvaluated++;

      if (isNaN(corr) || Math.abs(corr) < CORR_CONFIG.THRESHOLD) continue;
      significantPairs++;

      topPeers.get(symA)!.push({ symbol: symB, corr });
      topPeers.get(symB)!.push({ symbol: symA, corr });
    }
  }

  await logger.info(
    `[CorrTopN] Evaluated ${pairsEvaluated} pairs, found ${significantPairs} significant (corr >= ${CORR_CONFIG.THRESHOLD})`,
    'CorrTopN', { dateId }
  );

  // 4. Write to Firestore in batches
  const BATCH_SIZE = 400;
  const now = admin.firestore.Timestamp.now();
  const symbolList = Array.from(topPeers.entries());

  for (let i = 0; i < symbolList.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = symbolList.slice(i, i + BATCH_SIZE);

    for (const [symbol, peers] of chunk) {
      // Sort by |corr| desc, keep top N
      const sortedPeers = peers
        .sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr))
        .slice(0, CORR_CONFIG.TOP_N)
        .map(p => ({ symbol: p.symbol, corr: Math.round(p.corr * 10000) / 10000 }));

      const doc: CorrTopNDoc = {
        symbol,
        topCorrelated: sortedPeers,
        computedAt: now,
        lookbackDays: CORR_CONFIG.LOOKBACK_DAYS,
        pairsEvaluated,
      };

      const ref = db.collection('corrTopN').doc(dateId).collection('symbols').doc(symbol);
      batch.set(ref, doc);
    }

    await batch.commit();
  }

  await logger.info(
    `[CorrTopN] Done. Wrote ${symbolList.length} corrTopN docs for ${dateId}`,
    'CorrTopN', { dateId, jobId }
  );

  if (jobId) {
    await db.collection('jobs').doc(jobId).update({
      stage: 'CORR',
      updatedAt: admin.firestore.Timestamp.now(),
    });
  }
}

// ─── Cluster helpers (used by risk approval) ──────────────────────────────────

/**
 * Load the corrTopN doc for a symbol from the most recent available date.
 * Falls back to null if no data exists.
 */
export async function loadCorrPeers(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string,
): Promise<CorrPeer[]> {
  const snap = await db
    .collection('corrTopN')
    .doc(dateId)
    .collection('symbols')
    .doc(symbol)
    .get();

  if (!snap.exists) return [];
  return (snap.data() as CorrTopNDoc).topCorrelated ?? [];
}

/**
 * Given a candidate symbol and the set of open positions, returns cluster info:
 *  - clusterSymbols: which open positions are in the same cluster
 *  - clusterPositionCount: how many open positions are already in this cluster
 *  - clusterHeatR: total risk (in R units) already in this cluster
 *
 * Uses corrTopN data from prevDateId (yesterday) to avoid race conditions.
 */
export async function getClusterInfo(
  db: FirebaseFirestore.Firestore,
  candidateSymbol: string,
  openPositions: Array<{ symbol: string; riskAmount?: number }>,
  prevDateId: string,
  baseRiskUnit: number, // account.equity * baseRiskPct — used to convert riskAmount → R
): Promise<{
  clusterSymbols: string[];
  clusterPositionCount: number;
  clusterHeatR: number;
}> {
  if (openPositions.length === 0) {
    return { clusterSymbols: [], clusterPositionCount: 0, clusterHeatR: 0 };
  }

  // Load the candidate's correlated peers
  const peers = await loadCorrPeers(db, candidateSymbol, prevDateId);
  if (peers.length === 0) {
    return { clusterSymbols: [], clusterPositionCount: 0, clusterHeatR: 0 };
  }

  // Build a set of high-correlation peers (above threshold)
  const highCorrPeers = new Set(
    peers.filter(p => Math.abs(p.corr) >= CORR_CONFIG.THRESHOLD).map(p => p.symbol)
  );

  // Find which open positions fall in the same cluster
  const clusterPositions = openPositions.filter(p => highCorrPeers.has(p.symbol));
  const clusterSymbols = clusterPositions.map(p => p.symbol);
  const clusterPositionCount = clusterPositions.length;
  const clusterHeatR = clusterPositions.reduce(
    (sum, p) => sum + (baseRiskUnit > 0 ? (p.riskAmount ?? 0) / baseRiskUnit : 0),
    0
  );

  return { clusterSymbols, clusterPositionCount, clusterHeatR };
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

export const computeCorrTopNTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId, jobId } = req.body || {};
  if (!dateId) {
    res.status(400).send('Missing dateId');
    return;
  }
  try {
    await doComputeCorrTopN(String(dateId), jobId ? String(jobId) : undefined);
    res.status(200).send('CorrTopN computed');
  } catch (error: any) {
    console.error('[CorrTopN] Failed:', error);
    res.status(500).send(error.message || 'Internal Error');
  }
});
