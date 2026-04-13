process.env.GCLOUD_PROJECT = 'suhas-ag';
const admin = require('firebase-admin');
try { admin.initializeApp({ projectId: 'suhas-ag' }); } catch(e) {}
const db = admin.firestore();

async function check() {
  // Check a handful of specific symbols to see real bar counts + date ranges
  const symbols = ['RELIANCE', 'INFY', 'TCS', 'HDFCBANK', 'NIFTY 50', 'ICICIBANK'];

  for (const sym of symbols) {
    const snap = await db.collection('barsD').doc(sym).collection('days')
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .get();

    if (snap.empty) {
      console.log(`${sym}: NO DATA`);
    } else {
      const ids = snap.docs.map(d => d.id);
      console.log(`${sym}: ${ids.length} bars | First: ${ids[0]} | Last: ${ids[ids.length - 1]}`);
    }
  }
}

check().then(() => process.exit(0)).catch(console.error);
