import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Utility to delete old jobs, logs, and signals to clean up the workspace.
 */
export const cleanupData = onRequest({ timeoutSeconds: 540, memory: '512MiB' }, async (req, res) => {
  const db = getDb();
  const results: any = {};

  try {
    // 1. Delete all jobs
    const jobsSnap = await db.collection('jobs').get();
    const jobBatch = db.batch();
    jobsSnap.docs.forEach(doc => jobBatch.delete(doc.ref));
    await jobBatch.commit();
    results.jobsDeleted = jobsSnap.size;

    // 2. Delete all logs (daily collections)
    const logsSnap = await db.collection('logs').get();
    for (const logDoc of logsSnap.docs) {
      // Logs have entries subcollection
      const entriesSnap = await logDoc.ref.collection('entries').get();
      const entriesBatch = db.batch();
      entriesSnap.docs.forEach(doc => entriesBatch.delete(doc.ref));
      await entriesBatch.commit();
      await logDoc.ref.delete();
    }
    results.logsDeleted = logsSnap.size;

    // 3. Delete all signals (daily collections)
    const signalsSnap = await db.collection('signals').get();
    for (const sigDoc of signalsSnap.docs) {
      const itemsSnap = await sigDoc.ref.collection('items').get();
      const itemsBatch = db.batch();
      itemsSnap.docs.forEach(doc => itemsBatch.delete(doc.ref));
      await itemsBatch.commit();
      await sigDoc.ref.delete();
    }
    results.signalsDeleted = signalsSnap.size;
    
    // 4. Delete all features (symbol documents with 'days' subcollection)
    // Note: This might be a lot of documents, but for a cleanup it's usually needed.
    const featuresSnap = await db.collection('features').get();
    for (const featDoc of featuresSnap.docs) {
      const daysSnap = await featDoc.ref.collection('days').get();
      const daysBatch = db.batch();
      daysSnap.docs.forEach(doc => daysBatch.delete(doc.ref));
      await daysBatch.commit();
      await featDoc.ref.delete();
    }
    results.featuresDeleted = featuresSnap.size;

    res.status(200).send({
      message: 'Workspace cleaned successfully',
      stats: results
    });
  } catch (error) {
    console.error('Failed to cleanup data:', error);
    res.status(500).send({
      error: 'Failed to cleanup data',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * Audit all jobs and mark those stuck in 'RUNNING' for > 15 mins as FAILED.
 */
export const auditJobs = onRequest({ cors: true }, async (req, res) => {
  const db = getDb();
  const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
  
  try {
    const stuckJobsSnap = await db.collection('jobs')
      .where('status', '==', 'RUNNING')
      .get();
    
    const stuckJobs = stuckJobsSnap.docs.filter(doc => {
      const data = doc.data();
      return data.updatedAt && data.updatedAt.toMillis() < fifteenMinsAgo.getTime();
    });
    
    if (stuckJobs.length === 0) {
      res.status(200).send({ message: 'No stuck jobs found' });
      return;
    }

    const batch = db.batch();
    stuckJobs.forEach(doc => {
      batch.update(doc.ref, {
        status: 'FAILED',
        errorMessage: 'Stuck process: No updates for 15+ minutes',
        updatedAt: admin.firestore.Timestamp.now()
      });
    });

    await batch.commit();
    res.status(200).send({ 
      message: `Audited ${stuckJobsSnap.size} stuck jobs`,
      jobIds: stuckJobsSnap.docs.map(d => d.id)
    });
  } catch (err) {
    console.error('Audit failed:', err);
    res.status(500).send({ error: 'Audit failed', details: String(err) });
  }
});

/**
 * Specifically purge only the 'jobs' collection.
 */
export const purgeJobs = onRequest({ cors: true }, async (req, res) => {
  const db = getDb();
  try {
    const snap = await db.collection('jobs').limit(500).get();
    if (snap.empty) {
      res.status(200).send({ message: "No jobs to purge." });
      return;
    }
    const batch = db.batch();
    snap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    res.status(200).send({ message: `Purged ${snap.size} jobs successfully.` });
  } catch (err) {
    console.error('Purge failed:', err);
    res.status(500).send({ error: 'Purge failed', details: String(err) });
  }
});
/**
 * Seed the missing config/account document that strategy.ts requires
 */
export const seedConfig = onRequest({ cors: true }, async (req, res) => {
  const db = getDb();
  const accountConfig = {
    equity: 1000000,           // ₹10 Lakh starting capital
    baseRiskPct: 0.005,        // 0.5% risk per trade
    maxOpenRiskR: 6,           // Max 6R open portfolio heat
    maxPositions: 10,          // Max 10 concurrent open trades
    strategyRiskWeights: {
      PullbackEOD: 1.0,
      BreakoutCloseEOD: 1.2,
      MeanReversionEOD: 0.8,
      ShortBounceEOD: 0.8
    }
  };

  try {
    await db.collection('config').doc('account').set(accountConfig, { merge: true });
    res.status(200).send({
      message: 'config/account seeded successfully',
      config: accountConfig
    });
  } catch (error) {
    console.error('Failed to seed config:', error);
    res.status(500).send({ error: 'Failed to seed config', details: String(error) });
  }
});
