const admin = require('firebase-admin');
if (admin.apps.length === 0) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}
const db = admin.firestore();

async function check() {
  console.log('Querying latest 5 jobs...');
  const snap = await db.collection('jobs').orderBy('startedAt', 'desc').limit(5).get();
  if (snap.empty) {
    console.log('No jobs found.');
    return;
  }
  snap.forEach(doc => {
    const d = doc.data();
    console.log(`Job: ${doc.id} | Status: ${d.status} | Stage: ${d.stage} | Progress: ${d.counts.done}/${d.counts.total} | Error: ${d.errorMessage || 'None'}`);
  });
}

check().catch(console.error);
