import * as functionsV1 from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const getDb = () => {
  if (admin.apps.length === 0) {
    admin.initializeApp();
    const db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    return db;
  }
  return admin.firestore();
};

export const downloadReport = async (req: any, res: any) => {
  const { jobId } = req.query as any;
  if (!jobId) {
    res.status(400).send({ error: 'Missing jobId query parameter' });
    return;
  }
  const db = getDb();
  const snap = await db.collection('jobs').doc(jobId).collection('reports').doc('final').get();
  if (!snap.exists) {
    res.status(404).send({ error: 'Report not found for this job' });
    return;
  }
  const data = snap.data()!;
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="report_${jobId}.md"`);
  res.send(data.content);
};

export const diagnostics = functionsV1.https.onRequest(async (req, res) => {
  const db = getDb();
  const { type = 'jobs' } = req.query as any;

  try {
    switch (type) {
      case 'jobs': {
        const { limit = 20 } = req.query as any;
        const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
        const snap = await db.collection('jobs').orderBy('startedAt', 'desc').limit(finalLimit).get();
        const jobs = await Promise.all(snap.docs.map(async doc => {
          const data = doc.data();
          const reportSnap = await doc.ref.collection('reports').doc('final').get();
          return { id: doc.id, ...data, hasReport: reportSnap.exists };
        }));
        res.json({ value: jobs, Count: jobs.length });
        break;
      }
      case 'errors': {
        const { limit = 50 } = req.query as any;
        const finalLimit = Math.min(Math.max(Number(limit), 1), 100);
        const snap = await db.collection('system_errors').orderBy('timestamp', 'desc').limit(finalLimit).get();
        const errors = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ value: errors, Count: errors.length });
        break;
      }
      case 'logs': {
        const { jobId, date, level } = req.query as any;
        const dateId = date ? date.replace(/-/g, '') : new Date().toISOString().split('T')[0].replace(/-/g, '');
        let query: any = db.collection('logs').doc(dateId).collection('entries');
        if (jobId) query = query.where('metadata.jobId', '==', jobId);
        if (level) query = query.where('level', '==', level);
        const snapshot = await query.limit(100).get();
        const logs = snapshot.docs.map((doc: any) => doc.data());
        res.json({ count: logs.length, jobId: jobId || 'all', date: dateId, level: level || 'all', logs });
        break;
      }
      case 'features': {
        const { symbol = 'NIFTY 50', colType = 'days', includeBar = 'false' } = req.query as any;
        const col = colType === 'weeks' ? 'weeks' : 'days';
        const snap = await db.collection('features').doc(symbol).collection(col).get();
        const lastDoc = snap.empty ? null : snap.docs[snap.docs.length - 1].data();
        let barData = null;
        if (includeBar === 'true' && !snap.empty) {
          const lastDateId = snap.docs[snap.docs.length - 1].id;
          const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(lastDateId).get();
          if (barSnap.exists) barData = barSnap.data();
        }
        res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map(d => d.id), lastData: lastDoc, barData });
        break;
      }
      case 'bars': {
        const { symbol = 'NIFTY 50', colType = 'days' } = req.query as any;
        const col = colType === 'weeks' ? 'weeks' : 'days';
        const snap = await db.collection('barsD').doc(symbol).collection(col).get();
        res.json({ symbol, type: col, count: snap.size, last5: snap.docs.slice(-5).map(d => d.id) });
        break;
      }
      case 'universe': {
        const { universe = 'nifty500', limit = 1000 } = req.query as any;
        const snap = await db.collection('universes').doc(universe).collection('members').limit(Number(limit)).get();
        const members = snap.docs.map(d => d.id);
        res.json({ universe, totalInFirestore: members.length, members: members.slice(0, 50) });
        break;
      }
      case 'signals': {
        const { date, limit = 100, status = 'ORDERED' } = req.query as any;
        const dateId = date ? date.replace(/-/g, '') : new Date().toISOString().split('T')[0].replace(/-/g, '');
        let query: any = db.collection('signals').doc(dateId).collection('items');
        if (status !== 'all') {
            query = query.where('status', '==', status);
        }
        const snap = await query.limit(Number(limit)).get();
        const signals = snap.docs.map((doc: any) => ({ id: doc.id, ...doc.data() }));
        res.json({ dateId, count: signals.length, signals });
        break;
      }
      default:
        res.status(400).send({ error: `Unknown diagnostic type: ${type}` });
    }
  } catch (err: any) {
    console.error(`Diagnostics failed for ${type}:`, err);
    res.status(500).send({ error: 'Diagnostics failed', details: err.message });
  }
});

/**
 * Probes the market data repository to build a summary of historical data 
 * available across all symbols. This populates the "System Data Inventory" 
 * table in the dashboard.
 */
export const probeInventory = onRequest({ cors: true, invoker: 'public', memory: '1GiB', timeoutSeconds: 300 }, async (req, res) => {
  const db = getDb();
  try {
    const symbolRefs = await db.collection('barsD').listDocuments();
    const inventoryMap: Record<number, number> = {};

    // For better performance at scale, we process a large sample
    const BATCH_SIZE = 20;
    const sampleLimit = 200; // Only scan up to 200 symbols to stay within timeout
    const targetRefs = symbolRefs.slice(0, sampleLimit);

    for (let i = 0; i < targetRefs.length; i += BATCH_SIZE) {
      const chunk = targetRefs.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async (ref) => {
        const daysSnap = await ref.collection('days').get();
        const count = daysSnap.size || 0;
        if (count > 0) {
          inventoryMap[count] = (inventoryMap[count] || 0) + 1;
        }
      }));
    }

    const groupings = Object.entries(inventoryMap)
      .map(([bars, symbols]) => ({ bars: Number(bars), symbols }))
      .sort((a, b) => b.bars - a.bars);

    res.status(200).json({ 
      groupings,
      totalSymbolsTracked: symbolRefs.length,
      sampleSize: targetRefs.length,
      timestamp: admin.firestore.Timestamp.now().toDate().toISOString()
    });
  } catch (err: any) {
    console.error('Probe Inventory failed:', err);
    res.status(500).send({ error: 'Failed to build inventory', details: err.message });
  }
});
