
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = "demo-protrade";

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'demo-protrade' });
}

const { doFetchCandles } = require('./lib/services/marketdata');
const { doOpenFillSimulation, doExitSimulation } = require('./lib/services/paper_broker');

async function runSimulation() {
  const db = admin.firestore();
  const day1 = "2026-03-12";
  const day2 = "2026-03-13";
  const symbols = ['RELIANCE'];

  console.log("=== STEP 1: PRE-SEEDING POSITION (for Exit Test) ===");
  // We'll manually create a position for RELIANCE that we know will either HIT STOP or TARGET
  // Based on logs, Reliance Mar 13: Low=1285, High=1406, Close=1310
  // Let's set a Target at 1400 (Hit) and a Stop at 1200 (Not Hit)
  
  const mockPosition = {
    symbol: 'RELIANCE',
    avgEntryPrice: 1350,
    qty: 100,
    stopPrice: 1250,
    targets: [1400],
    status: 'OPEN',
    unrealizedPnl: 0,
    realizedPnl: 0,
    openedAt: admin.firestore.Timestamp.now(),
    lastUpdatedAt: admin.firestore.Timestamp.now(),
    entryFillId: 'mock_entry'
  };
  await db.collection('positions').doc('RELIANCE').set(mockPosition);
  console.log("Mock position created for RELIANCE at 1350, Target=1400");

  console.log("\n=== STEP 2: SIMULATING DAY 2 (Checking for Exits) ===");
  const jobId = `exit_test_${Date.now()}`;
  await doFetchCandles(jobId, 'RELIANCE', day2);
  await doExitSimulation(jobId, day2, 'RELIANCE');

  console.log("\n=== FINAL POSITION STATUS ===");
  const posSnap = await db.collection('positions').doc('RELIANCE').get();
  const p = posSnap.data();
  console.log(`${p.symbol}: status=${p.status}, realizedPnl=${p.realizedPnl}, exitReason=${p.exitReason}`);

  console.log("\n=== SIMULATION COMPLETE ===");
  process.exit(0);
}

runSimulation().catch(err => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
