const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault() // Use environment credentials
  });
}

const db = admin.firestore();

async function cleanup() {
  console.log('Starting cleanup...');
  const collections = ['jobs', 'logs', 'signals', 'features'];
  
  for (const col of collections) {
    console.log(`Cleaning collection: ${col}`);
    const snap = await db.collection(col).get();
    console.log(`Found ${snap.size} documents in ${col}`);
    
    // Batch delete
    const chunks = [];
    for (let i = 0; i < snap.docs.length; i += 500) {
      chunks.push(snap.docs.slice(i, i + 500));
    }
    
    for (const chunk of chunks) {
      const batch = db.batch();
      for (const doc of chunk) {
        // For logs and signals, they have subcollections
        if (col === 'logs' || col === 'signals') {
          const subCol = col === 'logs' ? 'entries' : 'items';
          const subSnap = await doc.ref.collection(subCol).get();
          subSnap.docs.forEach(sDoc => batch.delete(sDoc.ref));
        }
        if (col === 'features') {
          const subSnap = await doc.ref.collection('days').get();
          subSnap.docs.forEach(sDoc => batch.delete(sDoc.ref));
        }
        batch.delete(doc.ref);
      }
      await batch.commit();
      console.log(`Deleted chunk of ${chunk.length} from ${col}`);
    }
  }
  console.log('Cleanup complete!');
}

cleanup().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
