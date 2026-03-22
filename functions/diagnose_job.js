const admin = require('firebase-admin');
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'suhas-ag' });
const db = admin.firestore();

db.collection('jobs')
  .orderBy('createdAt', 'desc')
  .limit(1)
  .get()
  .then(s => {
      console.log('--- RECENT JOB TRACE ---');
      if (s.empty) console.log('No jobs found!');
      else console.log(JSON.stringify(s.docs[0].data(), null, 2));
  })
  .catch(console.error)
  .finally(() => setTimeout(() => process.exit(0), 5000));
