const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();
const symbol = 'NIFTY 50';

async function pullData() {
    try {
        console.log(`[PULL] Starting data pull for ${symbol}...`);
        
        // Pull bars
        console.log(`[PULL] Fetching bars...`);
        const barsSnap = await db.collection('barsD')
            .doc(symbol)
            .collection('days')
            .limit(100)
            .get();
            
        const bars = barsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const barsPath = path.join('d:', 'protrade', 'nifty_bars.json');
        fs.writeFileSync(barsPath, JSON.stringify(bars, null, 2));
        console.log(`[PULL] Saved ${bars.length} bars to ${barsPath}`);
        
        // Pull features
        console.log(`[PULL] Fetching features...`);
        const featuresSnap = await db.collection('features')
            .doc(symbol)
            .collection('days')
            .limit(100)
            .get();
            
        const features = featuresSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const featPath = path.join('d:', 'protrade', 'nifty_features.json');
        fs.writeFileSync(featPath, JSON.stringify(features, null, 2));
        console.log(`[PULL] Saved ${features.length} features to ${featPath}`);

        // Pull regime
        console.log(`[PULL] Fetching regimes...`);
        const regimeSnap = await db.collection('regime')
            .limit(30)
            .get();
        const regimes = regimeSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const regimePath = path.join('d:', 'protrade', 'recent_regimes.json');
        fs.writeFileSync(regimePath, JSON.stringify(regimes, null, 2));
        console.log(`[PULL] Saved ${regimes.length} regimes to ${regimePath}`);

        console.log(`[PULL] SUCCESS: All data pulled.`);
    } catch (err) {
        console.error(`[PULL] CRITICAL ERROR:`, err);
        process.exit(1);
    }
}

pullData().catch(err => {
    console.error(err);
    process.exit(1);
});
