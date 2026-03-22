import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Signal, PaperFill, Bar, Trade } from '../models';
import { checkSafety } from './safety';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Trade Manager: Manages open trades daily.
 */
export async function doManageTrades(dateId: string) {
  const db = getDb();
  console.log(`[TradeManager] Managing open trades for ${dateId}`);

  checkSafety();

  const signalsSnap = await db.collectionGroup('items')
    .where('status', '==', 'IN_TRADE')
    .get();

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    const signalId = doc.id;
    const symbol = signal.symbol;
    const entryPrice = signal.execution?.entryPrice || 0;
    const entryDateId = signal.execution?.entryDateId || '';
    const stopPrice = signal.stopPrice;
    const target = signal.targets[0];
    const riskPerShare = Math.abs(entryPrice - stopPrice);

    if (riskPerShare === 0) continue;

    // Load bars since entry
    const barsSnap = await db.collection('barsD')
      .doc(symbol)
      .collection('days')
      .where(admin.firestore.FieldPath.documentId(), '>=', entryDateId)
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .get();

    const bars = barsSnap.docs.map(d => d.data() as Bar).sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
    if (bars.length === 0) continue;

    const currentBar = bars[bars.length - 1];
    const highSeen = Math.max(...bars.map(b => b.high));
    const lowSeen = Math.min(...bars.map(b => b.low));

    // MFE / MAE in R units
    const mfeR = (highSeen - entryPrice) / riskPerShare;
    const maeR = (entryPrice - lowSeen) / riskPerShare;

    let exitPrice: number | null = null;
    let exitType: PaperFill['fillType'] | null = null;

    // 1. Hard Stop
    if (currentBar.low <= stopPrice) {
      exitPrice = Math.min(currentBar.open, stopPrice); // Gap through stop handled
      exitType = 'EXIT_STOP';
    } 
    // 2. Fixed Target
    else if (currentBar.high >= target) {
      exitPrice = target;
      exitType = 'EXIT_TARGET';
    }
    // 3. Break-even logic (MFE >= 1R)
    else if (mfeR >= 1.0 && currentBar.close <= entryPrice) {
      exitPrice = currentBar.close;
      exitType = 'EXIT_THESIS'; // Breakeven
    }
    // 4. Time exit (after 5 bars, low MFE)
    else if (bars.length >= 5 && mfeR < 0.5) {
      exitPrice = currentBar.close;
      exitType = 'EXIT_TIME';
    }
    // 5. Trailing Stop (MFE >= 2R -> entry + 0.5R)
    else if (mfeR >= 2.0 && currentBar.close <= (entryPrice + 0.5 * riskPerShare)) {
        exitPrice = currentBar.close;
        exitType = 'EXIT_THESIS'; // Trailed exit
    }

    if (exitPrice !== null && exitType !== null) {
      console.log(`[TradeManager] Exiting ${symbol} at ${exitPrice.toFixed(2)} (${exitType})`);

      const exitFillId = `exit_${signalId}_${dateId}`;
      const exitFill: PaperFill = {
        orderId: signal.execution?.orderId || '',
        symbol,
        fillPrice: exitPrice,
        fillQty: signal.riskApproval?.sizedQty || 0,
        slippageBps: 5,
        feeEstimate: 0,
        fillType: exitType,
        timestamp: admin.firestore.Timestamp.now()
      };

      await db.collection('paperFills').doc(dateId).collection('items').doc(exitFillId).set(exitFill);
      
      const tradeId = `trade_${signalId}`;
      const trade: Trade = {
          symbol,
          direction: signal.direction,
          entryPrice,
          entryDateId,
          exitPrice,
          exitDateId: dateId,
          qty: signal.riskApproval?.sizedQty || 0,
          pnl: (exitPrice - entryPrice) * (signal.riskApproval?.sizedQty || 0),
          rMultiple: (exitPrice - entryPrice) / riskPerShare,
          status: 'CLOSED',
          exitReason: exitType,
          mfeR,
          maeR
      };

      await db.collection('trades').doc('default').collection('items').doc(tradeId).set(trade);
      await doc.ref.update({ status: 'DONE' });
      await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({ status: 'CLOSED' });
    } else {
        // Update Position MFE/MAE
        await db.collection('portfolio').doc('default').collection('positions').doc(symbol).update({
            lastUpdatedAt: admin.firestore.Timestamp.now(),
            mfeR,
            maeR
        });
    }
  }
}

export const manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
  const { dateId } = req.body;
  try {
    await doManageTrades(dateId);
    res.status(200).send('Trades managed');
  } catch (error) {
    console.error('Trade management failed:', error);
    res.status(500).send('Internal Error');
  }
});
