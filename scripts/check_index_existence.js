const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();

async function checkIndexData() {
    const symbols = ['NIFTY 50', '^NSEI'];
    const dateId = '20260320'; // Today
    
    for (const symbol of symbols) {
        console.log(`--- Checking Symbol: ${symbol} ---`);
        
        // Check Bars
        const barDoc = await db.collection('barsD').doc(symbol).get();
        if (barDoc.exists) {
            const daysSnap = await db.collection('barsD').doc(symbol).collection('days').limit(1).get();
            console.log(`[Bars] Exists. Sub-collection days has ${daysSnap.size ? 'at least 1 doc' : '0 docs'}.`);
            if (daysSnap.size > 0) {
                console.log(`[Bars] Latest day ID: ${daysSnap.docs[0].id}`);
            }
        } else {
            console.log(`[Bars] Parent doc DOES NOT exist.`);
        }
        
        // Check Features
        const featDoc = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
        console.log(`[Features] Doc for ${dateId}: ${featDoc.exists ? 'EXISTS' : 'MISSING'}`);
        
        const latestFeatSnap = await db.collection('features').doc(symbol).collection('days').limit(1).get();
        if (latestFeatSnap.size > 0) {
            console.log(`[Features] Latest day ID found: ${latestFeatSnap.docs[0].id}`);
        }
    }
    
    // Check Regime
    const regimeDoc = await db.collection('regime').doc(dateId).get();
    if (regimeDoc.exists) {
        console.log(`--- Regime for ${dateId} ---`);
        console.log(JSON.stringify(regimeDoc.data(), null, 2));
    } else {
        console.log(`--- Regime for ${dateId} NOT FOUND ---`);
    }
}

checkIndexData().catch(console.error);
