import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, PaperFill, Bar, PaperPosition } from '../models';
import { STRATEGY_V11 } from '../config/runtime';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Trade Manager: Manages open trades daily with V1.1 Prioritized Exits.
 */
export async function doManageTrades(dateId: string) {
  const db = getDb();
  console.log(`[TradeManager] Managing open trades for ${dateId} (V1.1 Priority)`);

  const signalsSnap = await db.collectionGroup('items')
    .where('status', '==', 'IN_TRADE')
    .get();

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    const signalId = doc.id;
    const symbol = signal.symbol;
    
    // V1.1: Use ATR at entry for MFE tracking
    const atrAtEntry = Number(signal.features?.atr14 || 0);
    const entryPrice = signal.execution?.entryPrice || 0;
    const entryDateId = signal.execution?.entryDateId || '';
    const stopPrice = signal.stopPrice;
    const target = signal.targets[0];
    
    if (!atrAtEntry || !entryPrice) continue;

    // Load bars since entry to track duration and MFE
    const barsSnap = await db.collection('barsD')
      .doc(symbol)
      .collection('days')
      .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .get();

    const bars = barsSnap.docs.map(d => ({ id: d.id, ...(d.data() as Bar) })).sort((a, b) => a.id.localeCompare(b.id));
    if (bars.length === 0) continue;

    const currentBar = bars[bars.length - 1];
    const highSeen = Math.max(...bars.map(b => b.high));
    const lowSeen = Math.min(...bars.map(b => b.low));

    // Update MFE in ATR units (V1.1 requirement)
    const mfeAtr = signal.direction === 'BUY' 
      ? (highSeen - entryPrice) / atrAtEntry
      : (entryPrice - lowSeen) / atrAtEntry;

    // Load existing position state for partial profit tracking
    const posDoc = await db.collection('portfolio').doc('default').collection('positions').doc(symbol).get();
    const position = posDoc.exists ? posDoc.data() as PaperPosition : {} as any;

    let exitPrice: number | null = null;
    let exitType: PaperFill['fillType'] | null = null;
    let exitQty: number = signal.riskApproval?.sizedQty || 0;

    // EXIT PRIORITY: 1) HARD_STOP -> 2) TIME_STOP -> 3) PARTIAL -> 4) TARGET

    // 1. Hard Stop
    const isStopHit = signal.direction === 'BUY' ? currentBar.low <= stopPrice : currentBar.high >= stopPrice;
    if (isStopHit) {
      exitPrice = stopPrice; // For simulation, we use the stop level
      exitType = 'EXIT_STOP';
    } 
    // 2. Time Stop (after 5 trading days if mfeAtr < 1.0)
    else if (bars.length >= STRATEGY_V11.TIME_STOP_DAYS && mfeAtr < STRATEGY_V11.TIME_STOP_PROGRESS_ATR) {
      exitPrice = currentBar.close;
      exitType = 'EXIT_TIME';
    }
    // 3. Partial Profit (+1.5 ATR take 33% and move stop to breakeven)
    else if (STRATEGY_V11.PARTIAL_PROFIT_ENABLED && !position.partialTaken && mfeAtr >= STRATEGY_V11.PARTIAL_PROFIT_ATR) {
      exitPrice = currentBar.close;
      exitType = 'PARTIAL_PROFIT';
      exitQty = Math.floor(exitQty * STRATEGY_V11.PARTIAL_PROFIT_FRACTION);
    }
    // 4. Profit Target
    else {
      const isTargetHit = signal.direction === 'BUY' ? currentBar.high >= target : currentBar.low <= target;
      if (isTargetHit) {
        exitPrice = target;
        exitType = 'EXIT_TARGET';
      }
    }

    if (exitPrice !== null && exitType !== null) {
      console.log(`[TradeManager] v1.1 Event for ${symbol}: ${exitType} at ${exitPrice.toFixed(2)} (MFE_ATR: ${mfeAtr.toFixed(2)})`);

      if (exitType === 'PARTIAL_PROFIT') {
        const remainingQty = (signal.riskApproval?.sizedQty || 0) - exitQty;
        // Handle Partial: Move stop to breakeven and stay in trade
        await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
          partialTaken: true,
          stopPrice: entryPrice, // Move to breakeven
          qty: remainingQty,
          lastUpdatedAt: admin.firestore.Timestamp.now()
        });
        // We also need to update the signal's stopPrice so subsequent days use the new stop
        await doc.ref.update({ stopPrice: entryPrice });
        
        // Record the partial fill
        const fillId = `partial_${signalId}_${dateId}`;
        await db.collection('paperFills').doc(dateId).collection('items').doc(fillId).set({
          symbol, fillPrice: exitPrice, fillQty: exitQty, fillType: 'PARTIAL_PROFIT', timestamp: admin.firestore.Timestamp.now()
        });
      } else {
        // Full Exit
        const exitFillId = `exit_${signalId}_${dateId}`;
        const exitFill: PaperFill = {
          orderId: signal.execution?.orderId || '',
          symbol,
          fillPrice: exitPrice,
          fillQty: position.qty || exitQty, // Use currently held qty
          slippageBps: 5,
          feeEstimate: 0,
          fillType: exitType,
          timestamp: admin.firestore.Timestamp.now()
        };
        await db.collection('paperFills').doc(dateId).collection('items').doc(exitFillId).set(exitFill);
        
        await doc.ref.update({ status: 'DONE' });
        await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({ 
          status: 'CLOSED',
          exitReason: exitType,
          closedAt: admin.firestore.Timestamp.now()
        });
      }
    } else {
        // Just update MFE/MAE for monitoring
        await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
            lastUpdatedAt: admin.firestore.Timestamp.now(),
            mfeAtr,
            barsActive: bars.length
        });
    }
  }
}

export const manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId } = req.body;
  if (!dateId) {
    res.status(400).send('Missing dateId');
    return;
  }
  try {
    await doManageTrades(dateId);
    res.status(200).send('Trades managed');
  } catch (error) {
    console.error('Trade management failed:', error);
    res.status(500).send(error instanceof Error ? error.message : 'Internal Error');
  }
});
