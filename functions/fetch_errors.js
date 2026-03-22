const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function fetchErrors(limit = 10) {
  console.log(`Fetching last ${limit} system errors...`);
  const snap = await db.collection('system_errors')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  if (snap.empty) {
    console.log('No system errors found.');
    return;
  }

  snap.docs.forEach(doc => {
    const data = doc.data();
    console.log('---');
    console.log(`Timestamp: ${data.timestamp.toDate().toISOString()}`);
    console.log(`Level: ${data.level}`);
    console.log(`Context: ${data.context || 'N/A'}`);
    console.log(`Message: ${data.message}`);
    if (data.metadata) {
      console.log('Metadata:', JSON.stringify(data.metadata, null, 2));
    }
  });
}

const limit = process.argv[2] ? parseInt(process.argv[2]) : 10;
fetchErrors(limit).catch(err => {
  console.error('Failed to fetch errors:', err);
  process.exit(1);
});
