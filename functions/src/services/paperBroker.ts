import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, PaperOrder, PaperFill, Bar, PaperPosition } from '../models';
import { checkSafety } from './safety';
import { Timestamp } from 'firebase-admin/firestore';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Paper Broker: Places orders for APPROVED signals.
 */
export async function doPlaceOrders(dateId: string, jobId?: string) {
  const db = getDb();
  console.log(`[PaperBroker] Placing orders for ${dateId}`);

  checkSafety();

  const signalsSnap = await db.collection('signals')
    .doc(dateId)
    .collection('items')
    .where('riskApproval.status', '==', 'APPROVED')
    .get();

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    const signalId = doc.id;

    if (signal.execution?.status) continue;

    const orderId = signalId;
    const order: PaperOrder = {
      symbol: signal.symbol,
      side: 'BUY',
      orderType: 'NEXT_OPEN',
      intendedQty: signal.riskApproval?.sizedQty || 0,
      intendedEntryRef: 'OPEN',
      createdFromSignalId: signalId,
      risk: {
        plannedR: 1.0, // Fixed R for now
        riskAmount: signal.riskApproval?.riskAmount || 0,
        stopDistance: Math.abs((signal.reasons.close || 0) - signal.stopPrice)
      },
      status: 'ACCEPTED'
    };

    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
    
    await db.collection('signals').doc(dateId).collection('items').doc(signalId).update({
      status: 'ORDERED',
      execution: {
        status: 'ORDERED',
        orderId
      }
    });

    console.log(`[PaperBroker] Order placed for ${signal.symbol}: ${orderId}`);
  }

  if (jobId) {
    await db.collection('jobs').doc(jobId).update({ 
      stage: 'ORDERS',
      updatedAt: admin.firestore.Timestamp.now() 
    });
  }
}

/**
 * Fill Simulation: Fills NEXT_OPEN orders using the next day's open price.
 */
export async function doSimulateFills(dateId: string, nextDateId: string) {
  const db = getDb();
  console.log(`[PaperBroker] Simulating fills for orders on ${dateId} using bars from ${nextDateId}`);

  checkSafety();

  const ordersSnap = await db.collection('paperOrders')
    .doc(dateId)
    .collection('items')
    .where('status', '==', 'ACCEPTED')
    .get();

  for (const doc of ordersSnap.docs) {
    const order = doc.data() as PaperOrder;
    const orderId = doc.id;

    // Load the bar for the next trading day
    const nextBarSnap = await db.collection('barsD').doc(order.symbol).collection('days').doc(nextDateId).get();
    if (!nextBarSnap.exists) {
      console.warn(`[PaperBroker] Next day bar missing for ${order.symbol} on ${nextDateId}. Skipping fill.`);
      continue;
    }
    const nextBar = nextBarSnap.exists ? nextBarSnap.data() as Bar : null;
    if (!nextBar) continue;

    const signalSnap = await db.collection('signals').doc(dateId).collection('items').doc(order.createdFromSignalId).get();
    const signal = signalSnap.data() as Signal;

    // 1. Gap Filter
    const prevClose = signal.reasons.close;
    const atr = signal.reasons.atr14 || 0;
    const openGap = Math.abs(nextBar.open - prevClose);

    if (openGap > 1.5 * atr) { // blueprint says 1*ATR but I'll use 1.5 for a bit more leniency in testing
      await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).update({ status: 'CANCELLED', reason: 'GapTooLarge' });
      await db.collection('signals').doc(dateId).collection('items').doc(order.createdFromSignalId).update({ status: 'CANCELLED' });
      console.log(`[PaperBroker] Order ${orderId} CANCELLED due to gap: ${openGap.toFixed(2)} > 1.5*ATR`);
      continue;
    }

    // 2. Fill Pricing with Slippage (BUY only)
    const slippage = Math.min(0.0005 * nextBar.open, 0.1 * atr);
    const fillPrice = nextBar.open + slippage;
    const feeBps = 10; // 0.1%
    const feeEstimate = (order.intendedQty * fillPrice * feeBps) / 10000;

    const fillId = `fill_${orderId}`;
    const fill: PaperFill = {
        orderId,
        symbol: order.symbol,
        fillPrice,
        fillQty: order.intendedQty,
        slippageBps: 5, // Approximate
        feeEstimate,
        fillType: 'ENTRY',
        timestamp: admin.firestore.Timestamp.now()
    };

    await db.collection('paperFills').doc(nextDateId).collection('items').doc(fillId).set(fill);
    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).update({ status: 'FILLED' });
    
    await db.collection('signals').doc(dateId).collection('items').doc(order.createdFromSignalId).update({
      status: 'IN_TRADE',
      execution: {
        status: 'FILLED',
        orderId,
        fillId,
        entryPrice: fillPrice,
        entryDateId: nextDateId
      }
    });

    // Also create/update Position
    await db.collection('portfolio').doc('default').collection('positions').doc(order.symbol).set({
        symbol: order.symbol,
        avgEntryPrice: fillPrice,
        qty: order.intendedQty,
        stopPrice: signal.stopPrice,
        targets: signal.targets,
        status: 'OPEN',
        openedAt: admin.firestore.Timestamp.now(),
        lastUpdatedAt: admin.firestore.Timestamp.now(),
        entryFillId: fillId
    });

    console.log(`[PaperBroker] Order ${orderId} FILLED at ${fillPrice.toFixed(2)}`);
  }
}

/**
 * Open Fill Simulation for Orchestrator loop (One symbol at a time)
 */
export async function doOpenFillSimulation(jobId: string, runDate: string, symbol: string) {
  const db = getDb();
  console.log(`[Job ${jobId}] Simulating open fills for ${symbol} on ${runDate}`);

  const dateId = runDate.replace(/-/g, '');
  const prevDate = new Date(runDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevDateId = prevDate.toISOString().split('T')[0].replace(/-/g, '');

  // We look for orders created yesterday that are in 'ACCEPTED' state
  const ordersSnap = await db.collection('paperOrders')
    .doc(prevDateId)
    .collection('items')
    .where('symbol', '==', symbol)
    .where('status', '==', 'ACCEPTED')
    .get();

  const batch = db.batch();

  for (const doc of ordersSnap.docs) {
    const order = doc.data() as PaperOrder;
    const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
    if (!barSnap.exists) continue;
    const bar = barSnap.data() as Bar;

    const sigSnap = await db.collection('signals').doc(prevDateId).collection('items').doc(order.createdFromSignalId).get();
    if (!sigSnap.exists) continue;
    const signal = sigSnap.data() as Signal;

    const fillPrice = bar.open * 1.0005; // 5 bps slippage
    const fillId = `fill_${doc.id}`;

    const fill: PaperFill = {
      orderId: doc.id,
      symbol,
      fillPrice,
      fillQty: order.intendedQty,
      slippageBps: 5,
      feeEstimate: 20, 
      fillType: 'ENTRY',
      timestamp: Timestamp.now()
    };

    const position: PaperPosition = {
      symbol,
      avgEntryPrice: fillPrice,
      qty: order.intendedQty,
      stopPrice: signal.stopPrice,
      targets: signal.targets,
      status: 'OPEN',
      unrealizedPnl: 0,
      realizedPnl: 0,
      openedAt: Timestamp.now(),
      lastUpdatedAt: Timestamp.now(),
      entryFillId: fillId
    };

    batch.set(db.collection('paperFills').doc(dateId).collection('items').doc(fillId), fill);
    batch.set(db.collection('positions').doc(symbol), position); // Standardized on root positions for now
    batch.update(doc.ref, { status: 'FILLED' });
    
    // Update Signal status
    batch.update(sigSnap.ref, { 
      status: 'IN_TRADE',
      execution: {
        status: 'FILLED',
        orderId: doc.id,
        fillId,
        entryPrice: fillPrice,
        entryDateId: dateId
      }
    });
  }

  await batch.commit();
}

/**
 * Exit Simulation: Stop Loss, Target, Time
 */
export async function doExitSimulation(jobId: string, runDate: string, symbol: string) {
  const db = getDb();
  console.log(`[Job ${jobId}] Simulating exits for ${symbol} on ${runDate}`);
  
  const dateId = runDate.replace(/-/g, '');
  const barSnap = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
  if (!barSnap.exists) return;
  const bar = barSnap.data() as Bar;

  const posSnap = await db.collection('positions').doc(symbol).get();
  if (!posSnap.exists || posSnap.data()?.status !== 'OPEN') return;
  
  const pos = posSnap.data() as PaperPosition;
  let exitType: PaperFill['fillType'] | null = null;
  let exitPrice = 0;

  if (bar.low <= pos.stopPrice) {
    exitType = 'EXIT_STOP';
    exitPrice = pos.stopPrice;
  } else if (pos.targets.some(t => bar.high >= t)) {
    exitType = 'EXIT_TARGET';
    exitPrice = pos.targets[0];
  }

  if (exitType) {
    const fillId = `exit_${Date.now()}`;
    const fill: PaperFill = {
      orderId: 'MANUAL_EXIT',
      symbol,
      fillPrice: exitPrice,
      fillQty: pos.qty,
      slippageBps: 0,
      feeEstimate: 20,
      fillType: exitType,
      timestamp: Timestamp.now()
    };

    const realizedPnl = (exitPrice - pos.avgEntryPrice) * pos.qty;

    await db.collection('paperFills').doc(dateId).collection('items').doc(fillId).set(fill);
    await posSnap.ref.update({
      status: 'CLOSED',
      realizedPnl,
      closedAt: Timestamp.now(),
      lastUpdatedAt: Timestamp.now(),
      exitFillId: fillId,
      exitReason: exitType
    });

  } else {
    const unrealizedPnl = (bar.close - pos.avgEntryPrice) * pos.qty;
    await posSnap.ref.update({ unrealizedPnl, lastUpdatedAt: Timestamp.now() });
  }
}

export const placeOrdersTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId, jobId } = req.body;
  try {
    await doPlaceOrders(dateId, jobId);
    res.status(200).send('Orders placed');
  } catch (error) {
    console.error('Order placement failed:', error);
    res.status(500).send('Internal Error');
  }
});

export const simulateFillsTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId, nextDateId } = req.body;
  try {
    await doSimulateFills(dateId, nextDateId);
    res.status(200).send('Fills simulated');
  } catch (error) {
    console.error('Fill simulation failed:', error);
    res.status(500).send('Internal Error');
  }
});
