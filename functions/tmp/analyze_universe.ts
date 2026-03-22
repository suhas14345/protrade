import * as admin from 'firebase-admin';

async function run() {
  if (admin.apps.length === 0) admin.initializeApp();
  const db = admin.firestore();
  
  const universe = 'nifty500';
  console.log(`Analyzing universe: ${universe}`);
  
  const snap = await db.collection('universes').doc(universe).collection('members').limit(20).get();
  console.log(`Found ${snap.size} sample members:`);
  snap.docs.forEach(doc => {
    console.log(`- ${doc.id}`);
  });
  
  // Also check if they have .NS suffix
  const withSuffix = snap.docs.filter(d => d.id.endsWith('.NS')).length;
  console.log(`Samples with .NS suffix: ${withSuffix}/${snap.size}`);
}

run().catch(console.error);
