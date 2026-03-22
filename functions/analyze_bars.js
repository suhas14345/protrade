const admin = require('firebase-admin');
if (admin.apps.length === 0) admin.initializeApp({ projectId: 'suhas-ag' });
const db = admin.firestore();

async function runAnalysis() {
    console.log('Fetching signals for 20260324...');
    const dateId = '20260324';
    const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
    
    console.log(`Found ${signalsSnap.size} signals. Analyzing bar history...`);
    
    const stats = {}; // { barCount: signalCount }
    
    for (const doc of signalsSnap.docs) {
        const sig = doc.data();
        const symbol = sig.symbol;
        
        // Count bars on or before dateId
        const barsSnap = await db.collection('barsD').doc(symbol).collection('days')
            .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
            .get();
        
        const count = barsSnap.size;
        stats[count] = (stats[count] || 0) + 1;
    }
    
    console.log('\n--- Signals Grouped by Available Bars ---');
    Object.keys(stats).sort((a, b) => Number(a) - Number(b)).forEach(count => {
        console.log(`${count} bars available - ${stats[count]} signals`);
    });
    
    process.exit(0);
}

runAnalysis().catch(err => {
    console.error(err);
    process.exit(1);
});
