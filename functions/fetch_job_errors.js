const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}
const db = admin.firestore();

async function getErrorLogs() {
  const jobId = 'eod_2026-03-21_nifty500_1774104096142';
  const dateId = '20260321';
  console.log(`Fetching ERROR logs for jobId: ${jobId} in dateId: ${dateId}`);
  
  const snapshot = await db.collection('logs').doc(dateId).collection('entries')
    .where('metadata.jobId', '==', jobId)
    .where('level', '==', 'ERROR')
    .limit(100)
    .get();
    
  console.log(`Found ${snapshot.size} error logs`);
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    console.log(`[${data.level}] ${data.message} | Metadata: ${JSON.stringify(data.metadata)}`);
  });
}

getErrorLogs().catch(console.error);
