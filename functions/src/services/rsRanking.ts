import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { RS_CONFIG, SEPA_CONFIG } from '../config/runtime';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * V2.2: RS Ranking Engine
 *
 * Runs as a post-features pass across the entire universe.
 * Computes a 0-99 RS (Relative Strength) score for each symbol based on:
 *   composite = ret20d * RET20D_WEIGHT + ret60d * RET60D_WEIGHT
 *
 * Then ranks all symbols from lowest to highest and maps to 0-99.
 * Writes rsScore back into each features/{symbol}/days/{dateId} doc.
 * Also writes universeMedianRet20d + universeMedianRet60d into regime/{dateId}.
 *
 * This enables the strategy engine to filter: only trade rsScore >= MIN_RS_SCORE.
 */
export async function doComputeRsRanking(dateId: string, jobId?: string, universeId: string = 'midsmall400'): Promise<void> {
  const db = getDb();
  await logger.info(`[RSRank] Computing RS scores for ${dateId}`, 'RSRank', { dateId, jobId });

  // 1. Load all feature docs for this dateId
  const universeSnap = await db
    .collection('universes')
    .doc(universeId)
    .collection('members')
    .get();

  if (universeSnap.empty) {
    await logger.warn('[RSRank] Universe is empty — skipping RS ranking', 'RSRank', { dateId });
    return;
  }

  const symbols = universeSnap.docs.map(d => d.id);

  // Fetch all features in parallel (chunked to avoid firestore query limits)
  const CHUNK_SIZE = 50;
  const symbolData: Array<{ symbol: string; ret20d: number; ret60d: number; ret126: number }> = [];

  for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
    const chunk = symbols.slice(i, i + CHUNK_SIZE);
    const snaps = await Promise.all(
      chunk.map(sym => db.collection('features').doc(sym).collection('days').doc(dateId).get())
    );

    for (let j = 0; j < snaps.length; j++) {
      const snap = snaps[j];
      if (!snap.exists) continue;
      const data = snap.data() as any;
      const ret20d = Number(data?.returns?.ret20d ?? 0);
      const ret60d = Number(data?.returns?.ret60d ?? 0);
      const ret126 = Number(data?.ret126 ?? 0);
      if (Number.isFinite(ret20d) && Number.isFinite(ret60d)) {
        symbolData.push({ symbol: chunk[j], ret20d, ret60d, ret126 });
      }
    }
  }

  if (symbolData.length === 0) {
    await logger.warn('[RSRank] No feature data found — skipping RS ranking', 'RSRank', { dateId });
    return;
  }

  // 2. Compute composite RS score and rank
  const composites = symbolData.map(s => ({
    symbol: s.symbol,
    composite: s.ret20d * RS_CONFIG.RET20D_WEIGHT + s.ret60d * RS_CONFIG.RET60D_WEIGHT,
    ret20d: s.ret20d,
    ret60d: s.ret60d,
  }));

  composites.sort((a, b) => a.composite - b.composite);
  const n = composites.length;

  // 3. Write rsScore (0-99) back to each features doc in batches
  const batchSize = 400; // Firestore batch limit is 500
  for (let i = 0; i < composites.length; i += batchSize) {
    const batch = db.batch();
    const chunk = composites.slice(i, i + batchSize);

    for (let j = 0; j < chunk.length; j++) {
      const globalIndex = i + j;
      const rsScore = Math.round((globalIndex / (n - 1)) * 99); // 0-99
      const ref = db.collection('features').doc(chunk[j].symbol).collection('days').doc(dateId);
      batch.update(ref, { rsScore });
    }

    await batch.commit();
  }

  // SEPA leadership: rank by 126-day momentum (1 = strongest) so the SEPA gate can
  // select the top-N leaders. Only computed when SEPA_ONLY is on.
  if (SEPA_CONFIG.SEPA_ONLY) {
    const byMom = [...symbolData].sort((a, b) => b.ret126 - a.ret126);
    for (let i = 0; i < byMom.length; i += batchSize) {
      const batch = db.batch();
      const chunk = byMom.slice(i, i + batchSize);
      for (let j = 0; j < chunk.length; j++) {
        const rsRank126 = i + j + 1; // 1-based; 1 = strongest momentum
        const ref = db.collection('features').doc(chunk[j].symbol).collection('days').doc(dateId);
        batch.update(ref, { rsRank126 });
      }
      await batch.commit();
    }
  }
  const ret20dValues = composites.map(c => c.ret20d).sort((a, b) => a - b);
  const ret60dValues = composites.map(c => c.ret60d).sort((a, b) => a - b);
  const midIdx = Math.floor(ret20dValues.length / 2);
  const universeMedianRet20d = ret20dValues[midIdx] ?? 0;
  const universeMedianRet60d = ret60dValues[midIdx] ?? 0;

  await db.collection('regime').doc(dateId).update({
    'breadth.universeMedianRet20d': universeMedianRet20d,
    'breadth.universeMedianRet60d': universeMedianRet60d,
    updatedAt: admin.firestore.Timestamp.now(),
  });

  await logger.info(
    `[RSRank] Done. Ranked ${composites.length} symbols. ` +
    `MedianRet20d=${(universeMedianRet20d * 100).toFixed(2)}% ` +
    `MedianRet60d=${(universeMedianRet60d * 100).toFixed(2)}%`,
    'RSRank', { dateId, count: composites.length }
  );

  if (jobId) {
    await db.collection('jobs').doc(jobId).update({
      stage: 'RS_RANK',
      updatedAt: admin.firestore.Timestamp.now(),
    });
  }
}

export const computeRsRankingTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId, jobId } = req.body || {};
  if (!dateId) {
    res.status(400).send('Missing dateId');
    return;
  }
  try {
    await doComputeRsRanking(String(dateId), jobId ? String(jobId) : undefined);
    res.status(200).send('RS ranking computed');
  } catch (error: any) {
    console.error('[RSRank] Failed:', error);
    res.status(500).send(error.message || 'Internal Error');
  }
});
