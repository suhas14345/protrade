import * as admin from 'firebase-admin';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

// Retention in days. Preserves barsD/barsW (price history), stats (equity curve),
// aggregateStats, settings, universes, calendar, config, portfolio, and event data.
export interface CleanupRetention {
  logsDays: number;
  jobsDays: number;
  signalsDays: number;
  regimeDays: number;
  corrDays: number;
  ordersDays: number;
  fillsDays: number;
  featuresDays: number;
  alertsDays: number;
}

const DEFAULT_RETENTION: CleanupRetention = {
  logsDays: 30,
  jobsDays: 30,
  signalsDays: 90,
  regimeDays: 90,
  corrDays: 90,
  ordersDays: 180,
  fillsDays: 180,
  featuresDays: 120,
  alertsDays: 90,
};

/** YYYYMMDD cutoff `days` before today (UTC). Docs with an earlier id are purged. */
function cutoffDateId(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

function cutoffTimestamp(days: number): admin.firestore.Timestamp {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return admin.firestore.Timestamp.fromDate(d);
}

/** Delete date-partitioned docs (id === YYYYMMDD) older than the cutoff, including subcollections. */
async function purgeDateKeyed(db: FirebaseFirestore.Firestore, collection: string, days: number): Promise<number> {
  const cutoff = cutoffDateId(days);
  const refs = await db.collection(collection).listDocuments();
  let deleted = 0;
  for (const ref of refs) {
    if (ref.id < cutoff) {
      await db.recursiveDelete(ref);
      deleted++;
    }
  }
  return deleted;
}

/** Delete top-level docs older than the cutoff by a timestamp field, including subcollections. */
async function purgeByTimestamp(db: FirebaseFirestore.Firestore, collection: string, field: string, days: number): Promise<number> {
  const cutoff = cutoffTimestamp(days);
  const snap = await db.collection(collection).where(field, '<', cutoff).get();
  let deleted = 0;
  for (const doc of snap.docs) {
    await db.recursiveDelete(doc.ref);
    deleted++;
  }
  return deleted;
}

/** Delete old feature day-docs per symbol, preserving the symbol parent and barsD. */
async function purgeFeatures(db: FirebaseFirestore.Firestore, days: number): Promise<number> {
  const cutoff = cutoffDateId(days);
  const symbols = await db.collection('features').listDocuments();
  let deleted = 0;
  for (const symbolRef of symbols) {
    const olddays = await symbolRef.collection('days')
      .where(admin.firestore.FieldPath.documentId(), '<', cutoff)
      .get();
    for (let i = 0; i < olddays.docs.length; i += 400) {
      const batch = db.batch();
      for (const doc of olddays.docs.slice(i, i + 400)) batch.delete(doc.ref);
      await batch.commit();
      deleted += Math.min(400, olddays.docs.length - i);
    }
  }
  return deleted;
}

export async function runStaleCleanup(overrides?: Partial<CleanupRetention>): Promise<Record<string, number>> {
  const db = getDb();
  const r = { ...DEFAULT_RETENTION, ...overrides };
  const result: Record<string, number> = {};

  result.logs = await purgeDateKeyed(db, 'logs', r.logsDays);
  result.signals = await purgeDateKeyed(db, 'signals', r.signalsDays);
  result.regime = await purgeDateKeyed(db, 'regime', r.regimeDays);
  result.corrTopN = await purgeDateKeyed(db, 'corrTopN', r.corrDays);
  result.paperOrders = await purgeDateKeyed(db, 'paperOrders', r.ordersDays);
  result.paperFills = await purgeDateKeyed(db, 'paperFills', r.fillsDays);
  result.features = await purgeFeatures(db, r.featuresDays);
  result.jobs = await purgeByTimestamp(db, 'jobs', 'startedAt', r.jobsDays);
  result.alerts = await purgeByTimestamp(db, 'alerts', 'createdAt', r.alertsDays);
  result.system_errors = await purgeByTimestamp(db, 'system_errors', 'createdAt', r.alertsDays);

  return result;
}
