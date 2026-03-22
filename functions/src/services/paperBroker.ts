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
      side: signal.direction,
      orderType: 'NEXT_OPEN',
      intendedQty: signal.riskApproval?.sizedQty || 0,
      intendedEntryRef: 'OPEN',
      createdFromSignalId: signalId,
      risk: {
        plannedR: 1.0, 
        riskAmount: signal.riskApproval?.riskAmount || 0,
        stopDistance: Math.abs((signal.reasons.close || 0) - signal.indicativeStopPrice)
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

    console.log(`[PaperBroker] Order placed for ${signal.symbol}: ${orderId} (${signal.direction})`);
  }

  if (jobId) {
    await db.collection('jobs').doc(jobId).update({ 
      stage: 'ORDERS',
      updatedAt: admin.firestore.Timestamp.now() 
    });
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

    const fillPrice = order.side === 'BUY' ? bar.open * 1.0005 : bar.open * 0.9995; 
    const fillId = `fill_${doc.id}`;

    // Gap 4: Definitive price anchoring at fill (V1.1 precision)
    const atrRef = signal.atrRef || signal.reasons.atr14 || 0;
    const stopMult = signal.stopAtrMult || 2.0;
    const targetMult = signal.targetAtrMult || 3.0;

    const finalStop = order.side === 'BUY' 
        ? fillPrice - (atrRef * stopMult) 
        : fillPrice + (atrRef * stopMult);
    
    const finalTarget = order.side === 'BUY'
        ? fillPrice + (atrRef * targetMult)
        : fillPrice - (atrRef * targetMult);

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
      stopPrice: finalStop, 
      targets: [finalTarget], 
      status: 'OPEN',
      unrealizedPnl: 0,
      realizedPnl: 0,
      openedAt: Timestamp.now(),
      lastUpdatedAt: Timestamp.now(),
      entryFillId: fillId,
      // V1.1 Fields
      atrAtEntry: atrRef,
      partialTaken: false,
      mfeAtr: 0,
      entryDateId: dateId
    };

    batch.set(db.collection('paperFills').doc(dateId).collection('items').doc(fillId), fill);
    batch.set(db.collection('portfolio').doc('default').collection('positions').doc(symbol), position); 
    batch.update(doc.ref, { status: 'FILLED' });
    
    batch.update(sigSnap.ref, { 
      status: 'IN_TRADE',
      stopPrice: finalStop, // Final anchored value
      targets: [finalTarget], // Final anchored value
      rr: targetMult / stopMult, // Final R:R
      execution: {
        status: 'FILLED',
        orderId: doc.id,
        fillId,
        entryPrice: fillPrice,
        entryDateId: dateId
      }
    });

    console.log(`[PaperBroker] ${symbol} ${order.side} FILLED at ${fillPrice.toFixed(2)}. Stop: ${finalStop.toFixed(2)}, Target: ${finalTarget.toFixed(2)}`);
  }

  await batch.commit();
}

/**
 * Legacy Fill Simulation (Fallback)
 */
export async function doSimulateFills(dateId: string, nextDateId: string) {
    const db = getDb();
    const ordersSnap = await db.collection('paperOrders').doc(dateId).collection('items').where('status', '==', 'ACCEPTED').get();
    for (const doc of ordersSnap.docs) {
        const order = doc.data() as PaperOrder;
        await doOpenFillSimulation('manual', nextDateId, order.symbol);
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
