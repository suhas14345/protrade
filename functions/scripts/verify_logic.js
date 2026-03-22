const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Configure for local emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'suhas-ag';
process.env.OTEL_SDK_DISABLED = 'true';

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}

const db = admin.firestore();

// Paths to compiled JS
const regimePath = path.resolve(__dirname, '../lib/services/regime.js');
const strategyPath = path.resolve(__dirname, '../lib/services/strategy.js');

async function test() {
  const date = '2026-03-16';
  const jobId = 'test_run_' + Date.now();
  
  console.log(`[TEST] Creating dummy job ${jobId}...`);
  await db.collection('jobs').doc(jobId).set({ status: 'PENDING', runDate: date, startedAt: admin.firestore.Timestamp.now() });

  const { doComputeRegime } = require(regimePath);
  const { doEvaluateSignals } = require(strategyPath);

  // console.log(`[TEST] Computing Regime for ${date}...`);
  // const regime = await doComputeRegime(date, jobId);
  // console.log('[TEST] Regime:', JSON.stringify(regime, null, 2));

  const regimeSnap = await db.collection('regime').doc(date.replace(/-/g, '')).get();
  console.log('[TEST] Using Regime:', JSON.stringify(regimeSnap.data(), null, 2));

  const nifty50 = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../src/data/nifty50.json'), 'utf8'));
  const symbols = nifty50.slice(0, 10).map(s => s.symbol);

  console.log(`[TEST] Evaluating signals for ${symbols.length} symbols...`);
  for (const symbol of symbols) {
    await doEvaluateSignals(jobId, symbol, date);
  }

  // Check results in 'signals' collection
  const dateId = date.replace(/-/g, '');
  const signalsSnap = await db.collection('signals').doc(dateId).collection('items').get();
  console.log(`[TEST] Total Signals Generated: ${signalsSnap.size}`);
  signalsSnap.docs.forEach(doc => {
    const data = doc.data();
    console.log(` - ${data.symbol}: ${data.strategy} (${data.direction})`);
  });
}

test().catch(console.error);
