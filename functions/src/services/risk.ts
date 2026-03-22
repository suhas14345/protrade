import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, PaperOrder, Regime } from '../models';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Task Queue Trigger to approve/reject signals and generate Paper Orders.
 */
export async function doRiskApproval(jobId: string, symbol: string, runDate: string, signalId: string) {
  const db = getDb();
  await logger.info(`[Job ${jobId}] Risk approval for signal ${signalId}`, 'Risk', { jobId, signalId });

  const dateId = runDate.replace(/-/g, '');
  
  // Load Signal and Regime
  const sigSnap = await db.collection('signals').doc(dateId).collection('items').doc(signalId).get();
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  
  if (!sigSnap.exists || !regimeSnap.exists) {
    await logger.warn(`Signal or Regime not found for ${signalId}`, 'Risk', { jobId, signalId });
    return;
  }
  
  const signal = sigSnap.data() as Signal;
  const regime = regimeSnap.data() as Regime;

  // 1. Hard Gates
  if (!regime.tradeAllowed) {
    await sigSnap.ref.update({ status: 'REJECTED', reasons: { ...signal.reasons, rejection: 'Regime says tradeAllowed=false' } });
    return;
  }

  // 3. Adaptive Sizing & Heat Limits
  const portfolioSnap = await db.collection('portfolio').doc('default').get();
  const portfolioData = portfolioSnap.exists ? portfolioSnap.data() : { equity: 1000000, openRiskR: 0 };
  const equity = portfolioData?.equity || 1000000;
  const openRiskR = portfolioData?.openRiskR || 0;

  // Set Heat Limits per Regime
  const heatLimits: Record<string, number> = {
    TREND: 4.0,
    RANGE: 3.0,
    BEAR: 3.0,
    HIGH_VOL: 2.0,
    TRANSITION: 0.0
  };

  const currentHeatLimit = heatLimits[regime.marketState] || 3.0;

  if (openRiskR >= currentHeatLimit) {
    await sigSnap.ref.update({ status: 'REJECTED', reasons: { ...signal.reasons, rejection: `Portfolio heat limit reached: ${openRiskR} >= ${currentHeatLimit}` } });
    return;
  }

  const baseRiskPct = 0.005; // 0.5% risk per trade
  let riskBudget = equity * baseRiskPct * regime.riskMultiplier;

  // Volatility Safety Valve (Symbol Level)
  const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
  if (featSnap.exists) {
    const feat = featSnap.data() as any;
    if (feat.atrp > 1.5 * (feat.atrpMa100 || feat.atrp || 0)) {
      riskBudget *= 0.5; // 50% reduction on spikes
      await logger.info(`Risk reduced for ${symbol} due to ATRP spike: ${feat.atrp?.toFixed(2)}`, 'Risk', { jobId, symbol });
    }
  }
  
  const entryPriceAssumption = signal.reasons.close || signal.stopPrice; 
  const stopDistance = Math.abs(entryPriceAssumption - (signal.stopPrice || 0));
  
  const intendedQty = stopDistance > 0 ? Math.floor(riskBudget / stopDistance) : 0;
  const riskAmount = intendedQty * stopDistance; 

  // 4. Create Paper Order
  if (intendedQty > 0) {
    const orderId = `ord_${signalId}`;
    const order: PaperOrder = {
      symbol: signal.symbol,
      side: signal.direction as any,
      orderType: signal.entryPlan.type as any,
      intendedQty,
      intendedEntryRef: 'OPEN',
      createdFromSignalId: signalId,
      risk: {
        plannedR: 1,
        riskAmount,
        stopDistance
      },
      status: 'CREATED'
    };

    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
    await sigSnap.ref.update({ status: 'ORDERED' });
    await logger.info(`Order ${orderId} created for ${symbol} with Qty ${intendedQty}`, 'Risk', { jobId, symbol, orderId });
  } else {
    await sigSnap.ref.update({ status: 'REJECTED', reasons: { ...signal.reasons, rejection: 'Qty evaluates to 0' } });
  }
}

export const riskApproveTask = functionsV1.https.onRequest(async (req, res) => {
  const { jobId, symbol, runDate, signalId } = req.body;
  try {
    await doRiskApproval(jobId, symbol, runDate, signalId);
    res.status(200).send('Risk approval complete');
  } catch (error) {
    console.error(`Failed risk approval for ${signalId}:`, error);
    res.status(500).send(error instanceof Error ? error.message : 'Unknown error');
  }
});
