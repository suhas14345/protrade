
const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();

async function diagnose() {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  console.log('--- DIAGNOSTIC REPORT ---');
  console.log('Date ID:', today);

  try {
    // 1. Check Universes
    console.log('Checking Universes...');
    const n50Snap = await db.collection('universes').doc('nifty50').collection('members').get();
    const n500Snap = await db.collection('universes').doc('nifty500').collection('members').get();

    console.log('Universe Counts:');
    console.log('  nifty50:', n50Snap.size);
    console.log('  nifty500:', n500Snap.size);

    // 2. Check Signals for today
    const signalsSnap = await db.collection('signals').doc(today).collection('items').get();
    console.log('Signals for', today, ':', signalsSnap.size);

    // 3. Check Jobs
    const jobsSnap = await db.collection('jobs').orderBy('startedAt', 'desc').limit(5).get();
    console.log('Recent Jobs:');
    jobsSnap.docs.forEach(d => {
      const data = d.data();
      console.log(`  - ${d.id}: ${data.type} | ${data.status} | Stage: ${data.stage} | Counts: ${data.counts?.done}/${data.counts?.total}`);
    });

    // 4. Check Kite Settings
    const kiteSnap = await db.collection('settings').doc('kite').get();
    console.log('Kite Settings Status:', kiteSnap.data()?.status || 'MISSING');

  } catch (err) {
    console.error('Error during diagnosis:', err);
  }
  process.exit(0);
}

diagnose();
