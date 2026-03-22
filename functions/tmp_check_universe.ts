
import * as admin from 'firebase-admin';

if (admin.apps.length === 0) admin.initializeApp({ projectId: 'suhas-ag' });
const db = admin.firestore();

async function check() {
  const universeId = 'nifty500';
  const snap = await db.collection('universes').doc(universeId).collection('members').get();
  console.log(`[Diagnostic] Universe ${universeId} has ${snap.size} members.`);
}

check().catch(console.error);
