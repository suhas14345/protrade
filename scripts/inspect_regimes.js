const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();

async function inspectRegimes() {
    console.log('Fetching last 5 regime documents...');
    const snap = await db.collection('regime').orderBy(admin.firestore.FieldPath.documentId(), 'desc').limit(5).get();
    
    if (snap.empty) {
        console.log('No regime documents found.');
        return;
    }
    
    snap.forEach(doc => {
        console.log(`--- DateID: ${doc.id} ---`);
        console.log(JSON.stringify(doc.data(), null, 2));
    });
}

inspectRegimes().catch(console.error);
