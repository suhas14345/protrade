const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

const collectionsToCheck = [
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

async function verify() {
  console.log('--- VERIFYING DATABASE RESET ---');
  let allEmpty = true;

  for (const coll of collectionsToCheck) {
    const snap = await db.collection(coll).limit(1).get();
    if (snap.empty) {
      console.log(`[OK] ${coll} is empty.`);
    } else {
      console.log(`[STILL HAS DATA] ${coll} HAS DOCUMENTS!`);
      allEmpty = false;
    }
  }

  if (allEmpty) {
      console.log('--- ALL TARGET COLLECTIONS ARE CLEAR ---');
  } else {
      console.log('--- SOME COLLECTIONS STILL HAVE DATA ---');
  }
  process.exit(0);
}

verify().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
