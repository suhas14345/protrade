import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

export const systemAnalysis = onRequest({ cors: true }, async (req, res) => {
  const db = getDb();
  const date = (req.query.date as string) || '2026-03-17';
  const dateId = date.replace(/-/g, '');
  
  try {
    const regimeSnap = await db.collection('regime').doc(dateId).get();
    const regime = regimeSnap.data();
    
    const features = [];
    const featDocs = await db.collection('features').limit(40).get();
    
    for (const doc of featDocs.docs) {
      const symbol = doc.id;
      const daySnap = await doc.ref.collection('days').doc(dateId).get();
      if (daySnap.exists) {
        const featData = daySnap.data();
        const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
        features.push({
          symbol,
          features: featData,
          bar: barSnap.exists ? barSnap.data() : null
        });
      }
    }
    
    res.json({
      date,
      regime,
      analysisCount: features.length,
      samples: features
    });
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
  }
});
