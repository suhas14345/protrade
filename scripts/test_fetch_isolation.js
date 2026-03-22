const admin = require('firebase-admin');

if (admin.apps.length === 0) {
    admin.initializeApp({
        projectId: 'suhas-ag'
    });
}

const db = admin.firestore();

// Mock imports for marketdata
const marketDataPath = '../functions/lib/services/marketdata.js';
const { doFetchCandles } = require(marketDataPath);

async function testFetch() {
    const jobId = 'test_fetch_' + Date.now();
    const symbol = 'NIFTY 50';
    const date = '2026-03-20';
    
    console.log(`--- Testing doFetchCandles in isolation: ${symbol} for ${date} ---`);
    try {
        await doFetchCandles(jobId, symbol, date);
        console.log('SUCCESS: doFetchCandles completed.');
        
        const snap = await db.collection('barsD').doc(symbol).collection('days').get();
        console.log(`Bar count for ${symbol}: ${snap.size}`);
    } catch (err) {
        console.error('FAILURE:', err);
    }
}

testFetch();
