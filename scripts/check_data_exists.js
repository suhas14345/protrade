const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function checkData() {
  const date = '2026-03-17';
  const dateId = date.replace(/-/g, '');
  
  console.log(`Checking data for ${date}`);
  
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  if (regimeSnap.exists) {
    console.log('Regime found:', JSON.stringify(regimeSnap.data(), null, 2));
  } else {
    console.log('Regime NOT found for', date);
  }

  const featDocs = await db.collection('features').limit(5).get();
  console.log(`Found ${featDocs.size} symbols in features collection.`);
  for (const doc of featDocs.docs) {
    const daySnap = await doc.ref.collection('days').doc(dateId).get();
    console.log(`Symbol ${doc.id}: features for ${date} exists? ${daySnap.exists}`);
  }
}

checkData().catch(console.error);
