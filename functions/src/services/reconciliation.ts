import * as admin from 'firebase-admin';
import { ReconciliationRecord } from '../models';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * V2.3: Reconciliation Pipeline
 * Compares paper fills vs expected market fills for slippage tracking.
 * Produces discrepancy records for monitoring.
 */
export class ReconciliationService {
  /**
   * Reconcile all fills for a given date against expected market data.
   * Returns reconciliation records grouped by symbol.
   */
  static async reconcileDate(dateId: string): Promise<ReconciliationRecord[]> {
    const db = getDb();
    const records: ReconciliationRecord[] = [];

    // Get all paper fills for the date
    const fillsSnap = await db.collection('paperFills').doc(dateId).collection('items').get();
    if (fillsSnap.empty) return records;

    for (const fillDoc of fillsSnap.docs) {
      const fill = fillDoc.data();
      const symbol = fill.symbol;

      // Get the actual market bar for the fill date
      const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
      if (!barSnap.exists) continue;

      const bar = barSnap.data() as any;
      const actualOpen = Number(bar.open);
      const fillPrice = Number(fill.executedPrice || fill.intendedPrice);

      if (fillPrice <= 0 || actualOpen <= 0) continue;

      const expectedSlippageBps = Number(fill.slippageBps || 0);
      const actualSlippageBps = Math.abs((fillPrice - actualOpen) / actualOpen) * 10000;
      const discrepancyBps = Math.abs(actualSlippageBps - expectedSlippageBps);

      const record: ReconciliationRecord = {
        dateId,
        symbol,
        expectedSlippageBps,
        actualSlippageBps,
        expectedFillPrice: fillPrice,
        actualFillPrice: actualOpen,
        discrepancyBps,
        status: discrepancyBps > 20 ? 'DISCREPANT' : 'MATCHED',
      };

      records.push(record);
    }

    // Store reconciliation records
    if (records.length > 0) {
      const batch = db.batch();
      for (const rec of records) {
        const docId = `${rec.dateId}_${rec.symbol}`;
        batch.set(db.collection('reconciliation').doc(dateId).collection('items').doc(docId), rec);
      }
      await batch.commit();
      console.log(`[Reconciliation] ${dateId}: ${records.length} fills reconciled, ${records.filter(r => r.status === 'DISCREPANT').length} discrepant`);
    }

    return records;
  }

  /**
   * Get aggregate reconciliation stats for a date range.
   */
  static async getStats(startDateId: string, endDateId: string): Promise<{
    totalFills: number;
    matchedFills: number;
    discrepantFills: number;
    avgDiscrepancyBps: number;
    maxDiscrepancyBps: number;
  }> {
    const db = getDb();
    const snap = await db.collectionGroup('items')
      .where('dateId', '>=', startDateId)
      .where('dateId', '<=', endDateId)
      .get();

    const records = snap.docs.map(d => d.data() as ReconciliationRecord);
    const totalFills = records.length;
    const matchedFills = records.filter(r => r.status === 'MATCHED').length;
    const discrepantFills = records.filter(r => r.status === 'DISCREPANT').length;
    const avgDiscrepancyBps = totalFills > 0
      ? records.reduce((sum, r) => sum + r.discrepancyBps, 0) / totalFills
      : 0;
    const maxDiscrepancyBps = totalFills > 0
      ? Math.max(...records.map(r => r.discrepancyBps))
      : 0;

    return { totalFills, matchedFills, discrepantFills, avgDiscrepancyBps, maxDiscrepancyBps };
  }
}
