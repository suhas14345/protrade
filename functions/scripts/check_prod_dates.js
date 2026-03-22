const admin = require('firebase-admin');
const fs = require('fs');

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();

async function checkDates() {
  const symbol = 'RELIANCE.NS';
  console.log(`Checking latest dates for ${symbol} in production...`);
  
  const snap = await db.collection('features').doc(symbol).collection('days')
    .orderBy('__name__', 'desc')
    .limit(10)
    .get();
  
  const dates = snap.docs.map(doc => doc.id);
  fs.writeFileSync('prod_dates.json', JSON.stringify(dates, null, 2));
  console.log('Latest dates saved to prod_dates.json');
}

checkDates().catch(console.error);
