process.env.GCLOUD_PROJECT = 'suhas-ag';
const admin = require('firebase-admin');
try {
  admin.initializeApp({ projectId: 'suhas-ag' });
} catch(e) {}
const db = admin.firestore();

async function deepAudit() {
    console.log("Starting deep audit of NIFTY 500 historical data...");
    
    // 1. Get entire universe
    const universeSnap = await db.collection('universes').doc('nifty500').collection('members').get();
    const symbols = universeSnap.docs.map(d => d.id);
    console.log(`Found ${symbols.length} symbols in NIFTY 500.`);

    const results = {
        complete: 0,
        missingData: [], // 0 bars
        insufficient: [], // < 60 bars
        gapped: [] // gaps in dates (simplified check)
    };

    const BATCH_SIZE = 50;
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        console.log(`Auditing batch ${i / BATCH_SIZE + 1}...`);
        
        await Promise.all(batch.map(async (symbol) => {
            const snap = await db.collection('barsD').doc(symbol).collection('days').count().get();
            const count = snap.data().count;

            if (count === 0) {
                results.missingData.push(symbol);
            } else if (count < 60) {
                results.insufficient.push({ symbol, count });
            } else {
                results.complete++;
            }
        }));
    }

    console.log("\n--- AUDIT SUMMARY ---");
    console.log(`Total Symbols:    ${symbols.length}`);
    console.log(`Healthy (>=60):   ${results.complete}`);
    console.log(`Insufficient (<60): ${results.insufficient.length}`);
    console.log(`Dead (0 bars):    ${results.missingData.length}`);

    if (results.insufficient.length > 0) {
        console.log("\nTop 20 Insufficient Symbols:");
        results.insufficient.slice(0, 20).forEach(s => console.log(` - ${s.symbol}: ${s.count} bars`));
    }

    if (results.missingData.length > 0) {
        console.log("\nTop 20 Dead Symbols (0 bars):");
        results.missingData.slice(0, 20).forEach(s => console.log(` - ${s}`));
    }
}

deepAudit().then(() => process.exit(0)).catch(err => {
    console.error("Audit failed:", err);
    process.exit(1);
});
