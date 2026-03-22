const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

async function checkBars() {
    const db = admin.firestore();
    const symbol = 'NIFTY 50';
    const snap = await db.collection('barsD').doc(symbol).collection('days').get();
    console.log(`Total bars for ${symbol}: ${snap.size}`);
    
    const docs = snap.docs.sort((a, b) => b.id.localeCompare(a.id));
    console.log('Latest 5 bars:');
    docs.slice(0, 5).forEach(doc => console.log(`${doc.id}: ${JSON.stringify(doc.data())}`));
}

checkBars().catch(console.error);
