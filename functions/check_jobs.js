const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({ projectId: 'suhas-ag' });
const db = getFirestore(app);

async function main() {
  // Get latest 10 jobs
  const snap = await db.collection('jobs')
    .orderBy('startedAt', 'desc')
    .limit(10)
    .get();

  if (snap.empty) {
    console.log('No jobs found.');
    return;
  }

  for (const doc of snap.docs) {
    const d = doc.data();
    console.log('---');
    console.log('Job ID  :', doc.id);
    console.log('Date    :', d.runDate);
    console.log('Universe:', d.universeId);
    console.log('Status  :', d.status);
    console.log('Stage   :', d.stage);
    console.log('Counts  :', JSON.stringify(d.counts));
    if (d.errorMessage) console.log('ERROR   :', d.errorMessage);
    if (d.error) console.log('ERROR2  :', d.error);
  }
}

main().catch(console.error).finally(() => process.exit(0));
