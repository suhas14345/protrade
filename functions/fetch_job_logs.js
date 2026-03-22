const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}
const db = admin.firestore();

async function getLogs() {
  const jobId = 'eod_2026-03-21_nifty500_1774104096142';
  console.log(`Fetching logs for jobId: ${jobId}`);
  
  const snapshot = await db.collection('logs').doc('system').collection('entries')
    .where('metadata.jobId', '==', jobId)
    .limit(100)
    .get();
    
  console.log(`Found ${snapshot.size} logs`);
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    console.log(`[${data.level}] ${data.message}`);
  });
}

getLogs().catch(console.error);
