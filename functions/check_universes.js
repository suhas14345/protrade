const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: 'suhas-ag'
  });
}

const db = admin.firestore();

async function checkUniverses() {
  try {
    const universes = await db.collection('universes').get();
    console.log('UNIVERSES_DOCS:', universes.docs.map(d => d.id));
    
    for (const u of universes.docs) {
      const members = await db.collection('universes').doc(u.id).collection('members').limit(5).get();
      console.log(`Universe ${u.id} has ${members.size} members (sampled: ${members.docs.map(d => d.id).join(', ')})`);
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  }
}

checkUniverses();
