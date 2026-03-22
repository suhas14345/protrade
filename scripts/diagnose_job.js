const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();
const jobId = 'eod_2026-03-19_nifty50_1773955108818';

async function checkJob() {
    console.log(`Checking status for Job: ${jobId}`);
    const doc = await db.collection('jobs').doc(jobId).get();
    
    if (!doc.exists) {
        console.error('Job document not found in Firestore!');
        process.exit(1);
    }
    
    const data = doc.data();
    console.log('--- Job Status ---');
    console.log(`ID: ${doc.id}`);
    console.log(`Status: ${data.status}`);
    console.log(`Stage: ${data.stage}`);
    console.log(`MarketState: ${data.marketState}`);
    console.log(`Counts: ${JSON.stringify(data.counts)}`);
    console.log(`StartedAt: ${data.startedAt?.toDate().toISOString()}`);
    console.log(`UpdatedAt: ${data.updatedAt?.toDate().toISOString()}`);
    
    if (data.errorMessage) {
        console.error(`ERROR: ${data.errorMessage}`);
    }
    
    // Check signals for today
    const dateId = '20260319';
    const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
    console.log(`--- Signals today (${dateId}) ---`);
    console.log(`Count: ${signalsSnap.size}`);
    
    // Check regime
    const regimeDoc = await db.collection('regime').doc(dateId).get();
    console.log(`--- Regime today (${dateId}) ---`);
    if (regimeDoc.exists) {
        console.log(`MarketState: ${regimeDoc.data().marketState}`);
        console.log(`Notes: ${regimeDoc.data().notes}`);
    } else {
        console.log('Regime document NOT created yet.');
    }
}

checkJob().catch(console.error);
