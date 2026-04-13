const admin = require('firebase-admin');
if (admin.apps.length === 0) { admin.initializeApp(); }
const db = admin.firestore();

async function check() {
  const jobId = 'morning_2026-04-06_nifty500_1775492756543';
  const jobSnap = await db.collection('jobs').doc(jobId).get();
  if (!jobSnap.exists) {
    console.log(`Job ${jobId} not found`);
  } else {
    console.log(`Job ${jobId}:`);
    console.dir(jobSnap.data(), { depth: null });
  }

  const errLogs = await db.collection('logs').doc('20260406').collection('entries').where('level', '==', 'ERROR').get();
  console.log(`Errors on 20260406: ${errLogs.size}`);
  errLogs.forEach(d => console.dir(d.data(), { depth: null }));
  process.exit(0);
}
check();
