const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();

async function listRecentJobs() {
    console.log('Fetching last 10 jobs...');
    const snap = await db.collection('jobs').orderBy('startedAt', 'desc').limit(10).get();
    
    if (snap.empty) {
        console.log('No jobs found.');
        return;
    }
    
    snap.forEach(doc => {
        const d = doc.data();
        console.log(`JobID: ${doc.id} | Date: ${d.runDate} | Status: ${d.status} | Stage: ${d.stage} | MarketState: ${d.marketState}`);
    });
}

listRecentJobs().catch(console.error);
