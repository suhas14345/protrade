const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 1. Production Firestore (Source)
const prodApp = admin.initializeApp({
  projectId: 'suhas-ag'
}, 'production');
const prodDb = prodApp.firestore();

// 2. Local Emulator Firestore (Destination)
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
const localApp = admin.initializeApp({
  projectId: 'suhas-ag'
}, 'local');
const localDb = localApp.firestore();

const docIdField = admin.firestore.FieldPath.documentId();

async function syncData() {
  const date = '2026-03-13';
  const dateId = date.replace(/-/g, '');
  
  const nifty500 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/data/nifty500.json'), 'utf8'));
  const symbols = ['^NSEI', ...nifty500.map(s => s.symbol)];

  console.log(`Syncing data for ${symbols.length} symbols for ${date} from Production to Local Emulator...`);

  // Sync Regime
  const regimeSnap = await prodDb.collection('regime').doc(dateId).get();
  if (regimeSnap.exists) {
    await localDb.collection('regime').doc(dateId).set(regimeSnap.data());
    console.log('Synced Regime.');
  }

  // Sync in batches to avoid overwhelming connections
  const batchSize = 20;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const chunk = symbols.slice(i, i + batchSize);
    console.log(`Syncing batch ${i / batchSize + 1} / ${Math.ceil(symbols.length / batchSize)}...`);
    
    await Promise.all(chunk.map(async (symbol) => {
      // Sync Features
      const featSnap = await prodDb.collection('features').doc(symbol).collection('days').doc(dateId).get();
      if (featSnap.exists) {
        await localDb.collection('features').doc(symbol).collection('days').doc(dateId).set(featSnap.data());
      }

      // Sync Bars (fetch last 30 bars)
      const barsSnap = await prodDb.collection('barsD').doc(symbol).collection('days')
        .orderBy(docIdField, 'desc')
        .where(docIdField, '<=', dateId)
        .limit(30)
        .get();
      
      if (!barsSnap.empty) {
        const batch = localDb.batch();
        barsSnap.forEach(doc => {
          batch.set(localDb.collection('barsD').doc(symbol).collection('days').doc(doc.id), doc.data());
        });
        await batch.commit();
      }
    }));
  }

  console.log('Sync completed.');
}

syncData().catch(console.error);
