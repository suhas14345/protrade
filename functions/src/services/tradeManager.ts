import * as functionsV1 from 'firebase-functions';
import * as admin from 'firebase-admin';
import { PaperPosition, PaperOrder } from '../models';
import { CalendarService } from './calendar';
import { EXIT_PROFILES, SEPA_CONFIG, METALS_CONFIG } from '../config/runtime';
import { getBarOn, getWindowOnOrBefore } from './barCache';

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

    // SEPA regime-off liquidation reads the PREVIOUS trading day's regime: within
    // a day's pipeline doManageTrades runs BEFORE doComputeRegime, so regime/{today}
    // does not exist yet — reading it would look "off" every day and dump the whole
    // book daily. Use the last regime that actually exists. A genuinely missing prior
    // regime (e.g. first managed day) is treated as NOT off, so we never force-
    // liquidate on absent data — only on a confirmed index-uptrend break.
    let sepaRegimeOff = false;
    if (SEPA_CONFIG.SEPA_ONLY) {
        const regimeDateId = (await CalendarService.getPrevTradingDateId(dateId)) || dateId;
        const regimeSnap = await db.collection('regime').doc(regimeDateId).get();
        const rd: any = regimeSnap.exists ? regimeSnap.data() : null;
        const rm: any = rd?.metrics;
        if (rm) {
            const indexUp = Number(rm.close) > Number(rm.ema200) && Number(rm.ema200Slope ?? 0) > 0 && rd?.marketState !== 'BEAR';
            sepaRegimeOff = !indexUp;
        }
    }

    for (const doc of positionsSnap.docs) {
        const pos = doc.data() as PaperPosition;
        const symbol = pos.symbol;
        const profile = getExitProfile(pos.strategy);

        const currentBar = await getBarOn(db, symbol, dateId);
        if (!currentBar) continue;
        const currentClose = Number(currentBar.close);
        const currentHigh = Number(currentBar.high);
        const currentLow = Number(currentBar.low);

        // Metals rotation exit: pure trend-following. Hold while close is above the
        // 200-SMA; liquidate (EXIT_THESIS) the moment the trend gate breaks. A wide
        // hard-stop floor (HARD_STOP_PCT below entry) is the only price stop — the
        // trend gate, not a tight stop, is the primary exit. Bypasses the ATR logic.
        if (pos.strategy === 'MetalsRotation') {
            const entry = pos.avgEntryPrice;
            const hardStop = entry * (1 - METALS_CONFIG.HARD_STOP_PCT);

            const bars = await getWindowOnOrBefore(db, symbol, dateId, METALS_CONFIG.SMA_TREND);
            const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c) && c > 0);
            const haveSma = closes.length >= METALS_CONFIG.SMA_TREND;
            const sma200 = haveSma
                ? closes.slice(-METALS_CONFIG.SMA_TREND).reduce((a, b) => a + b, 0) / METALS_CONFIG.SMA_TREND
                : NaN;

            await doc.ref.update({
                stopPrice: hardStop,
                lastUpdatedAt: admin.firestore.Timestamp.now(),
            });

            let metalsExit = false;
            let metalsType: PaperOrder['exitType'] = undefined;
            // Trend-gate break only fires once we actually have a full 200-SMA, so we
            // never liquidate on insufficient data — only on a confirmed break.
            if (haveSma && currentClose < sma200) { metalsExit = true; metalsType = 'EXIT_THESIS'; }
            else if (currentClose <= hardStop) { metalsExit = true; metalsType = 'EXIT_STOP'; }
            if (metalsExit) await queueExitOrder(db, pos, doc.ref.path, metalsType!, dateId, jobId);
            continue;
        }

        // SEPA percent-based exit: 7% hard-stop floor, arm a 20%-below-highest-close
        // trailing lock (never below the 50-SMA) once up LOCK_AT_PCT, ratcheting up
        // only; plus a regime-off liquidation that dumps every SEPA position when the
        // index breaks its uptrend. Bypasses the ATR/target/time/partial logic below.
        if (pos.strategy === 'SepaBreakoutEOD') {
            const entry = pos.avgEntryPrice;
            const hh = Math.max(pos.sepaHH ?? entry, currentClose);
            const gain = entry > 0 ? currentClose / entry - 1 : 0;
            const lockActive = (pos.sepaLockActive || false) || gain >= SEPA_CONFIG.LOCK_AT_PCT;

            let stop = entry * (1 - SEPA_CONFIG.HARD_STOP_PCT);
            if (lockActive) {
                let trail = hh * (1 - SEPA_CONFIG.TRAIL_PCT);
                const featSnap = await db.collection('features').doc(symbol).collection('days').doc(dateId).get();
                const sma50 = featSnap.exists ? Number((featSnap.data() as any)?.sma50) : NaN;
                if (Number.isFinite(sma50) && sma50 > 0) trail = Math.max(trail, sma50);
                stop = Math.max(stop, trail);
            }
            stop = Math.max(stop, pos.stopPrice ?? stop); // ratchet up only

            await doc.ref.update({
                sepaHH: hh,
                sepaLockActive: lockActive,
                stopPrice: stop,
                lastUpdatedAt: admin.firestore.Timestamp.now(),
            });

            let sepaExit = false;
            let sepaType: PaperOrder['exitType'] = undefined;
            if (sepaRegimeOff) { sepaExit = true; sepaType = 'EXIT_THESIS'; }
            else if (currentClose <= stop) { sepaExit = true; sepaType = 'EXIT_STOP'; }
            if (sepaExit) await queueExitOrder(db, pos, doc.ref.path, sepaType!, dateId, jobId);
            continue;
        }

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
