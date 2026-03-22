const admin = require('firebase-admin');
const path = require('path');

// Configure environment for local emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'suhas-ag';

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();
const { runEodLogic } = require('./lib/services/orchestrator');

async function seedUniverseSubset() {
  console.log('[TEST] Seeding a subset of symbols to local emulator...');
  const symbols = ['RELIANCE.NS', 'TCS.NS', 'INFY.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'HINDUNILVR.NS', 'BHARTIARTL.NS', 'SBI.NS', 'LT.NS', 'ITC.NS', 'AXISBANK.NS', 'KOTAKBANK.NS', 'ADANIENT.NS', 'BAJFINANCE.NS', 'M&M.NS'];
  
  const batch = db.batch();
  for (const s of symbols) {
    const docRef = db.collection('universes').doc('default').collection('members').doc(s);
    batch.set(docRef, { symbol: s, sector: 'TEST', liquidityBucket: 'A' });
  }
  await batch.commit();
  console.log(`[TEST] Seeded ${symbols.length} symbols.`);
}

async function test() {
  await seedUniverseSubset();
  
  const date = '2026-03-16';
  const jobId = `local_test_${Date.now()}`;
  
  console.log(`[TEST] Starting local EOD run for ${date} (Job: ${jobId})`);
  
  try {
    // Listen for progress updates locally
    const unsub = db.collection('jobs').doc(jobId).onSnapshot(doc => {
      const data = doc.data();
      if (data && data.counts) {
        console.log(`[PROGRESS] Stage: ${data.stage} | Done: ${data.counts.done} | Failed: ${data.counts.failed} | Total: ${data.counts.total}`);
      }
    });

    await runEodLogic(date, jobId);
    console.log('[TEST] Local EOD run completed successfully');
    
    // Close listener
    unsub();
  } catch (err) {
    console.error('[TEST] Local EOD run failed:', err);
  }
}

test();
