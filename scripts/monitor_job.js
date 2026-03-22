const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();
const jobId = 'eod_2026-03-20_nifty50_1774020391874';

async function monitorJob() {
    console.log(`--- Monitoring Job: ${jobId} ---`);
    const doc = await db.collection('jobs').doc(jobId).get();
    
    if (!doc.exists) {
        console.log('Job document NOT FOUND yet...');
        return;
    }
    
    const data = doc.data();
    console.log(`Stage: ${data.stage}`);
    console.log(`Status: ${data.status}`);
    console.log(`Progress: ${data.counts.done} / ${data.counts.total}`);
    if (data.errorMessage) {
        console.log(`Error: ${data.errorMessage}`);
    }
    
    if (data.stage === 'REGIME' || data.stage === 'SIGNALS' || data.stage === 'DONE') {
        const regimeSnap = await db.collection('regime').doc('20260320').get();
        if (regimeSnap.exists) {
            console.log('--- Regime Found ---');
            console.log(JSON.stringify(regimeSnap.data(), null, 2));
        } else {
            console.log('Regime doc not created yet.');
        }
    }
}

monitorJob().catch(console.error);
