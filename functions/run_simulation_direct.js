
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8081";
process.env.GCLOUD_PROJECT = "demo-protrade";

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'demo-protrade' });
}

const { doManageTrades } = require('./lib/services/tradeManager');

async function runSimulation() {
  const db = admin.firestore();
  const day2 = "2026-03-13";
  const dateId2 = "20260313";
  const jobId = `sim_test_${Date.now()}`;

  console.log("=== STEP 1: PRE-SEEDING POSITION (for Exit Test) ===");
  const mockPosition = {
    symbol: 'RELIANCE',
    avgEntryPrice: 1350,
    qty: 100,
    direction: 'BUY',
    stopPrice: 1250,
    targets: [1400],
    status: 'OPEN',
    atrAtEntry: 15,
    unrealizedPnl: 0,
    realizedPnl: 0,
    openedAt: admin.firestore.Timestamp.now(),
    lastUpdatedAt: admin.firestore.Timestamp.now(),
    entryFillId: 'mock_entry'
  };
  // tradeManager reads from portfolio/default/positions
  await db.collection('portfolio').doc('default').collection('positions').doc('RELIANCE').set(mockPosition);
  console.log("Mock position created: RELIANCE BUY@1350, Stop=1250, Target=1400");

  console.log("\n=== STEP 2: SEED MOCK CANDLE (close=1450 → triggers EXIT_TARGET) ===");
  const mockBar = {
    open: 1360,
    high: 1460,
    low: 1340,
    close: 1450,  // above target 1400 → EXIT_TARGET
    volume: 500000,
    timestamp: admin.firestore.Timestamp.fromDate(new Date(`${day2}T09:15:00+05:30`)),
    dateId: dateId2
  };
  await db.collection('barsD').doc('RELIANCE').collection('days').doc(dateId2).set(mockBar);
  await db.collection('barsD').doc('RELIANCE').set({ lastUpdated: admin.firestore.Timestamp.now(), type: 'EQUITY' }, { merge: true });
  console.log(`Candle seeded: RELIANCE ${day2} O=${mockBar.open} H=${mockBar.high} L=${mockBar.low} C=${mockBar.close}`);

  console.log("\n=== STEP 3: MANAGE TRADES (EXIT CHECK) ===");
  await doManageTrades(dateId2, jobId);

  console.log("\n=== FINAL VALIDATION ===");
  // Position stays OPEN — exit is queued as a paper order for next-morning fill
  const posSnap = await db.collection('portfolio').doc('default').collection('positions').doc('RELIANCE').get();
  const p = posSnap.data();
  console.log(`Position: ${p.symbol} status=${p.status} (expected OPEN, fill queued for tomorrow)`);

  const ordersSnap = await db.collection('paperOrders').doc(dateId2).collection('items')
    .where('symbol', '==', 'RELIANCE').where('exitType', '==', 'EXIT_TARGET').get();
  if (!ordersSnap.empty) {
    const o = ordersSnap.docs[0].data();
    console.log(`Exit Order: ${ordersSnap.docs[0].id} | status=${o.status} | side=${o.side} | qty=${o.intendedQty}`);
    console.log(`\n✅ EXIT_TARGET order queued correctly! Trade lifecycle validated.`);
  } else {
    console.log(`\n❌ No EXIT_TARGET order found in paperOrders.`);
  }

  console.log("\n=== SIMULATION COMPLETE ===");
  process.exit(0);
}

runSimulation().catch(err => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
