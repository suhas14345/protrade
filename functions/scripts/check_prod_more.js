process.env.OTEL_SDK_DISABLED = 'true';
const admin = require('firebase-admin');
const fs = require('fs');

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();

async function check() {
  const results = {};
  
  console.log('Checking universes...');
  const uniSnap = await db.collection('universes').get();
  results.universes = uniSnap.docs.map(d => d.id);

  console.log('Checking Nifty 500 membership...');
  const members = await db.collection('universes').doc('nifty500').collection('members').limit(50).get();
  results.nifty500_members_count = members.size;
  results.nifty500_members_sample = members.docs.map(d => d.id);

  console.log('Checking Nifty 500 jobs...');
  const jobs = await db.collection('jobs').where('universeId', '==', 'nifty500').orderBy('startedAt', 'desc').limit(10).get();
  results.nifty500_jobs = jobs.docs.map(d => {
    const data = d.data();
    return { id: d.id, status: data.status, runDate: data.runDate, startedAt: data.startedAt.toDate().toISOString() };
  });

  fs.writeFileSync('prod_more_results.json', JSON.stringify(results, null, 2));
  console.log('Results saved to prod_more_results.json');
}

check().catch(console.error);
