
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = "demo-protrade";

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'demo-protrade' });
}

async function seedActive() {
  const db = admin.firestore();
  
  // Seed an OPEN position for TCS
  const mockPosition = {
    symbol: 'TCS',
    avgEntryPrice: 2500,
    qty: 50,
    stopPrice: 2400,
    targets: [2700],
    status: 'OPEN',
    unrealizedPnl: 1250, // (2525 - 2500) * 50
    realizedPnl: 0,
    openedAt: admin.firestore.Timestamp.now(),
    lastUpdatedAt: admin.firestore.Timestamp.now(),
    entryFillId: 'mock_tcs_entry'
  };
  await db.collection('positions').doc('TCS').set(mockPosition);
  console.log("Active position seeded for TCS");
  process.exit(0);
}

seedActive().catch(console.error);
