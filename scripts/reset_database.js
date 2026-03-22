const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

const collectionsToClear = [
  'barsD',
  'features',
  'signals',
  'regime',
  'jobs',
  'paperOrders',
  'paperFills',
  'positions',
  'journal',
  'aggregateStats'
];

async function reset() {
  console.log('--- DATABASE RESET STARTED ---');

  for (const coll of collectionsToClear) {
    console.log(`Clearing collection: ${coll}...`);
    try {
      const collRef = db.collection(coll);
      // recursiveDelete handles all documents and subcollections efficiently
      await db.recursiveDelete(collRef);
      console.log(`Successfully cleared ${coll}`);
    } catch (err) {
      console.warn(`Warning: Failed to clear ${coll} (it might be empty or restricted). Error: ${err.message}`);
    }
  }

  // 3. Reset Portfolio
  console.log('Resetting portfolio/default...');
  try {
    await db.collection('portfolio').doc('default').set({
      equity: 1000000,
      openRiskR: 0,
      updatedAt: admin.firestore.Timestamp.now()
    }, { merge: true });
    console.log('Successfully reset portfolio/default');
  } catch (err) {
    console.error('Failed to reset portfolio:', err.message);
  }

  console.log('--- DATABASE RESET COMPLETE ---');
  process.exit(0);
}

reset().catch(err => {
  console.error('CRITICAL: Reset failed:', err);
  process.exit(1);
});
