process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8081';
process.env.GCLOUD_PROJECT = 'demo-protrade';

const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-protrade' });
const db = admin.firestore();

async function check() {
  const jobs = await db.collection('jobs').orderBy('startedAt', 'desc').limit(5).get();
  jobs.forEach(j => {
    const data = j.data();
    console.log(j.id, data.status, data.stage, data.counts, data.errorMessage || '');
  });

  // also check logs of the most recent job
  if (!jobs.empty) {
      const jobId = jobs.docs[0].id;
      const logs = await db.collectionGroup('entries').where('metadata.jobId', '==', jobId).orderBy('timestamp', 'desc').limit(10).get();
      logs.forEach(l => console.log('LOG:', l.data().message));
  }
}
check().then(()=>process.exit(0)).catch(console.error);
