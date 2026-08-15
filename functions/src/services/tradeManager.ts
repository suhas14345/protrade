import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { PaperPosition, PaperOrder } from '../models';
import { CalendarService } from './calendar';
import { EXIT_PROFILES } from '../config/runtime';
import { getBarOn } from './barCache';

const getDb = () => {
    if (admin.apps.length === 0) admin.initializeApp();
    return admin.firestore();
};

/**
 * V2.3: Get exit profile for a strategy (falls back to PullbackEOD defaults)
 */
function getExitProfile(strategy?: string) {
    return EXIT_PROFILES[strategy || 'PullbackEOD'] || EXIT_PROFILES['PullbackEOD'];
}

/**
 * Manage existing OPEN positions with V2.3 per-strategy exit profiles
 */
export async function doManageTrades(dateId: string, jobId: string) {
    const db = getDb();
    
    const positionsSnap = await db.collection('portfolio').doc('default').collection('positions')
        .where('status', '==', 'OPEN')
        .get();

    if (positionsSnap.empty) return;

    for (const doc of positionsSnap.docs) {
        const pos = doc.data() as PaperPosition;
        const symbol = pos.symbol;
        const profile = getExitProfile(pos.strategy);

        const currentBar = await getBarOn(db, symbol, dateId);
        if (!currentBar) continue;
        const currentClose = Number(currentBar.close);
        const currentHigh = Number(currentBar.high);
        const currentLow = Number(currentBar.low);

        const atrAtEntry = pos.atrAtEntry || 1.0;
        const priceDiff = pos.direction === 'BUY'
            ? (currentHigh - pos.avgEntryPrice)
            : (pos.avgEntryPrice - currentLow);
        const mfeAtr = Math.max(pos.mfeAtr || 0, priceDiff / atrAtEntry);
        
        // V2.3: Trailing stop logic (for Pullback and Breakout strategies)
        let currentStopPrice = pos.stopPrice;
        let trailingActive = pos.trailingStopActive || false;
        let trailingStopPrice = pos.trailingStopPrice || pos.stopPrice;

        if (profile.useTrailingStop && mfeAtr >= profile.trailingActivationAtr) {
            trailingActive = true;
            if (pos.direction === 'BUY') {
                const newTrail = currentHigh - (profile.trailingStopAtr * atrAtEntry);
                trailingStopPrice = Math.max(trailingStopPrice, newTrail);
                currentStopPrice = Math.max(currentStopPrice, trailingStopPrice);
            } else {
                const newTrail = currentLow + (profile.trailingStopAtr * atrAtEntry);
                trailingStopPrice = Math.min(trailingStopPrice, newTrail);
                currentStopPrice = Math.min(currentStopPrice, trailingStopPrice);
            }
        }

        await doc.ref.update({
            mfeAtr,
            stopPrice: currentStopPrice,
            trailingStopActive: trailingActive,
            trailingStopPrice: trailingActive ? trailingStopPrice : null,
            lastUpdatedAt: admin.firestore.Timestamp.now()
        });

        let exitTriggered = false;
        let exitType: PaperOrder['exitType'] = undefined;

        // 1. Stop loss check (uses trailing stop if active)
        if (pos.direction === 'BUY' && currentClose <= currentStopPrice) {
            exitTriggered = true; exitType = 'EXIT_STOP';
        } else if (pos.direction === 'SELL' && currentClose >= currentStopPrice) {
            exitTriggered = true; exitType = 'EXIT_STOP';
        }

        // 2. Target check
        const targetPrice = pos.targets && pos.targets.length > 0 ? pos.targets[0] : null;
        if (!exitTriggered && targetPrice) {
            if (pos.direction === 'BUY' && currentClose >= targetPrice) {
                exitTriggered = true; exitType = 'EXIT_TARGET';
            } else if (pos.direction === 'SELL' && currentClose <= targetPrice) {
                exitTriggered = true; exitType = 'EXIT_TARGET';
            }
        }

        // 3. Time stop — per-strategy hold period
        if (!exitTriggered && pos.entryDateId) {
            const [entryDay, currentDay] = await Promise.all([
                CalendarService.getCalendarDay(pos.entryDateId),
                CalendarService.getCalendarDay(dateId)
            ]);
            if (entryDay && currentDay) {
                const heldDays = currentDay.tradingIndex - entryDay.tradingIndex;
                if (heldDays >= profile.timeStopDays) {
                    exitTriggered = true; exitType = 'EXIT_TIME';
                }
            }
        }

        // 4. Partial profit — per-strategy thresholds
        if (!exitTriggered && !pos.partialTaken && mfeAtr >= profile.partialProfitAtr) {
           const partialQty = Math.floor(pos.qty * profile.partialFraction);
           if (partialQty > 0) {
             await queueExitOrder(db, pos, doc.ref.path, 'PARTIAL_PROFIT', dateId, jobId, true, partialQty);
             // Move stop to breakeven after partial
             await doc.ref.update({ partialTaken: true, stopPrice: pos.avgEntryPrice });
           }
        }

        if (exitTriggered) {
            await queueExitOrder(db, pos, doc.ref.path, exitType!, dateId, jobId);
        }
    }
}

async function queueExitOrder(
    db: FirebaseFirestore.Firestore,
    pos: PaperPosition,
    posPath: string,
    type: NonNullable<PaperOrder['exitType']>,
    dateId: string,
    jobId: string,
    isPartial = false,
    overrideQty?: number
) {
    const orderId = `EXIT_${pos.symbol}_${dateId}_${type}`;
    const qty = overrideQty ?? (isPartial ? Math.floor(pos.qty / 2) : pos.qty);
    
    if (qty <= 0) return;

    const exitOrder: PaperOrder = {
        symbol: pos.symbol,
        orderType: 'EXIT',
        side: pos.direction === 'BUY' ? 'SELL' : 'BUY',
        intendedQty: qty,
        intendedEntryRef: 'OPEN',
        createdFromSignalId: pos.signalId || 'MANUAL',
        risk: {
            plannedR: 1,
            riskAmount: pos.riskAmount || 0,
            stopDistance: 0
        },
        status: 'ACCEPTED',
        exitType: type,
        parentPositionPath: posPath,
        createdAt: admin.firestore.Timestamp.now(),
        jobId
    };

    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(exitOrder);
    console.log(`[TradeManager] Queued ${type} for ${pos.symbol} (Qty: ${qty}, Strategy: ${pos.strategy || 'legacy'})`);
}

export const manageTradesTask = functionsV1.https.onRequest(async (req, res) => {
    const { dateId, jobId } = req.body || {};
    try {
        await doManageTrades(String(dateId), String(jobId));
        res.status(200).send('OK');
    } catch (e: any) { res.status(500).send(e.message); }
});
