const admin = require('firebase-admin');
const fs = require('fs');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function analyze() {
  const date = '2026-03-17';
  const dateId = date.replace(/-/g, '');
  
  console.log(`Analyzing for ${date}`);
  
  // 1. Get Regime
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  const regime = regimeSnap.data();
  console.log('Regime:', JSON.stringify(regime, null, 2));
  
  if (!regime) {
    console.log('No regime found for', date);
    return;
  }

  // 2. Sample 15 symbols from Nifty 50 features
  const features = [];
  const featDocs = await db.collection('features').limit(30).get();
  
  for (const doc of featDocs.docs) {
    const symbol = doc.id;
    const daySnap = await doc.ref.collection('days').doc(dateId).get();
    if (daySnap.exists) {
      features.push({
        symbol,
        data: daySnap.data()
      });
    }
  }
  
  console.log(`Found features for ${features.length} symbols`);
  
  // 3. For each found symbol, get the matching bar to check currentClose
  for (let f of features) {
    const barSnap = await db.collection('barsD').doc(f.symbol).collection('days').doc(dateId).get();
    if (barSnap.exists) {
      f.bar = barSnap.data();
    }
  }

  const output = {
    regime,
    features
  };
  
  fs.writeFileSync('analysis_results.json', JSON.stringify(output, null, 2));
  console.log('Analysis saved to analysis_results.json');
}

analyze().catch(console.error);
