const admin = require('firebase-admin');
if (admin.apps.length === 0) admin.initializeApp();
const db = admin.firestore();

const symbol = 'TRENT.NS';
const dateId = '20260324';

(async () => {
    const doc = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
    console.log(`Doc for ${dateId} exists: ${doc.exists}`);
    
    const countSnap = await db.collection('barsD').doc(symbol).collection('days')
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .limit(30)
      .get();
      
    console.log(`History count on or before ${dateId}: ${countSnap.size}`);
    process.exit(0);
})();
