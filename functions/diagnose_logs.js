const admin = require('firebase-admin');
if (admin.apps.length === 0) {
  admin.initializeApp();
}
const db = admin.firestore();

db.collection('logs').doc('20260321').collection('entries')
  .where('metadata.jobId', '==', 'eod_2026-03-24_nifty50_1774069312006')
  .where('level', '==', 'ERROR')
  .limit(5)
  .get()
  .then(s => {
      console.log('--- FOUND ERRORS ---');
      console.log(JSON.stringify(s.docs.map(d => d.data()), null, 2));
  })
  .catch(console.error)
  .finally(() => setTimeout(() => process.exit(0), 1000));
