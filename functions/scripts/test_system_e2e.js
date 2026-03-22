const admin = require('firebase-admin');
const path = require('path');

// Setup for local emulator
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: 'suhas-ag' });
}
const db = admin.firestore();

const dateId = '20260316';
const nextDateId = '20260317';
const runDate = '2026-03-16';
const symbol = 'RELIANCE.NS';

async function clearData() {
    console.log('[CLEANUP] Purging test data...');
    // Clear signals for this symbol across all dates
    const signals = await db.collectionGroup('items').where('symbol', '==', symbol).get();
    for (const d of signals.docs) await d.ref.delete();
    
    // Clear orders
    const orders = await db.collectionGroup('items').where('symbol', '==', symbol).get(); // Both paperOrders and signals use 'items'
    // This is a bit broad, but okay for test
    
    // Clear positions
    await db.collection('portfolio').doc('default').collection('positions').doc(symbol).delete();
    // Clear trades
    const trades = await db.collection('trades').doc('default').collection('items').get();
    for (const d of trades.docs) if (d.data().symbol === symbol) await d.ref.delete();
}

async function runE2E() {
  console.log('--- STARTING E2E SYSTEM TEST ---');

  const riskPath = path.resolve(__dirname, '../lib/services/riskEngine.js');
  const brokerPath = path.resolve(__dirname, '../lib/services/paperBroker.js');
  const managerPath = path.resolve(__dirname, '../lib/services/tradeManager.js');

  const { doProcessRisk } = require(riskPath);
  const { doPlaceOrders, doSimulateFills } = require(brokerPath);
  const { doManageTrades } = require(managerPath);

  const jobId = 'e2e_test_' + Date.now();

  try {
    await clearData();

    // 0. Setup Job & Regime
    await db.collection('jobs').doc(jobId).set({ runDate, type: 'EOD_RUN', status: 'RUNNING' });
    await db.collection('regime').doc(dateId).set({
        marketState: 'TREND', tradeAllowed: true, riskMultiplier: 1.0, minSignalScore: 70, timestamp: admin.firestore.Timestamp.now()
    });

    // 1. Seed Signal
    console.log('\n[STAGE 1] Seeding Force Signal...');
    const signalId = `${symbol}_FORCE`;
    await db.collection('signals').doc(dateId).collection('items').doc(signalId).set({
        symbol, direction: 'BUY', strategy: 'PullbackEOD', score: 85,
        entryPlan: { type: 'NEXT_OPEN' }, stopPrice: 1300, targets: [1500],
        status: 'NEW', checklist: { regimeAligned: true, indicatorMatch: true },
        reasons: { close: 1385, marketState: 'TREND', atr14: 30 }
    });

    // 2. Risk & Orders
    await doProcessRisk(dateId, jobId);
    await doPlaceOrders(dateId, jobId);

    // 3. Fills
    console.log('\n[STAGE 3] Simulating Fills...');
    await db.collection('barsD').doc(symbol).collection('days').doc(nextDateId).set({
        open: 1386, high: 1420, low: 1380, close: 1410, volume: 1100000, timestamp: admin.firestore.Timestamp.now()
    });
    await doSimulateFills(dateId, nextDateId);
    
    // 4. Trade Management
    console.log('\n[STAGE 4] Managing Open Trades...');
    const thirdDateId = '20260318';
    await db.collection('barsD').doc(symbol).collection('days').doc(thirdDateId).set({
        open: 1410, high: 1510, low: 1400, close: 1505, volume: 1200000, timestamp: admin.firestore.Timestamp.now()
    });
    
    await doManageTrades(thirdDateId);
    
    const tradeSnap = await db.collection('trades').doc('default').collection('items').get();
    if (tradeSnap.size > 0) {
        const trade = tradeSnap.docs[0].data();
        console.log(`SUCCESS: Trade ${trade.status} via ${trade.exitReason} PnL=${trade.pnl.toFixed(0)} R=${trade.rMultiple.toFixed(2)}`);
    } else {
        console.warn('FAILED: No trade logged in trades collection.');
    }

    console.log('\n--- E2E TEST COMPLETED ---');

  } catch (error) {
    console.error('\nE2E TEST FAILED:', error);
  }
}

runE2E();
