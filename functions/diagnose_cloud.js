process.env.GCLOUD_PROJECT = 'suhas-ag';
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'suhas-ag' });
const db = admin.firestore();

async function run() {
  const jobs = await db.collection('jobs').orderBy('startedAt', 'desc').limit(5).get();
  jobs.forEach(j => {
    const data = j.data();
    console.log(`Job: ${j.id} | Status: ${data.status} | Stage: ${data.stage} | Date: ${data.runDate} | Universe: ${data.universeId}`);
    console.log(`  Counts: Total=${data.counts?.total}, Done=${data.counts?.done}, Failed=${data.counts?.failed}`);
    if (data.errorMessage) console.log(`  Error: ${data.errorMessage}`);
    console.log('---');
  });

  const latestJobId = jobs.empty ? null : jobs.docs[0].id;
  if (latestJobId) {
     const logs = await db.collection('logs').doc(latestJobId.split('_')[1].replace(/-/g, '') || '').collection('entries').where('metadata.jobId', '==', latestJobId).orderBy('timestamp', 'desc').limit(20).get();
     console.log('Recent Logs for ' + latestJobId + ':');
     logs.forEach(l => {
         const log = l.data();
         console.log(`[${log.level}] ${log.message}`);
     });
  }
}
run().then(() => process.exit(0)).catch(console.error);
