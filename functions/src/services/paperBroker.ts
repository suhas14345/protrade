import * as admin from 'firebase-admin';
import { Signal, PaperOrder, PaperFill, PaperPosition, PaperTrade } from '../models';
import { checkSafety } from './safety';
import { SLIPPAGE_CONFIG, INDIAN_FEE_CONFIG, ADV_LIMITS, SEPA_CONFIG } from '../config/runtime';
import { Timestamp } from 'firebase-admin/firestore';
import { CalendarService } from './calendar';
import { computeExitPnl } from './portfolioEquity';
import { getBarOn } from './barCache';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * V2.4: Dynamic slippage model — f(liquidityBucket, regimeState, orderSize, medVol20).
 * Includes order-size impact: larger orders as % of ADV get proportionally worse fills.
 * Returns slippage in basis points.
 */
function computeSlippageBps(
  liquidityBucket: 'A' | 'B' | 'C' | undefined,
  regimeState: string | undefined,
  orderQty?: number,
  medVol20?: number
): number {
  const bucket = liquidityBucket ?? 'A';
  const bucketConfig = SLIPPAGE_CONFIG.BUCKETS[bucket] ?? SLIPPAGE_CONFIG.BUCKETS['A'];
  const regimeMult = SLIPPAGE_CONFIG.REGIME_MULT[regimeState ?? 'TREND'] ?? 1.0;

  // Base slippage from bucket range
  const rawBps = bucketConfig.minBps + Math.random() * (bucketConfig.maxBps - bucketConfig.minBps);

  // V2.4: Order-size impact — participation rate scaling
  // If order is >1% of daily volume, slippage increases non-linearly
  let sizeImpactMult = 1.0;
  if (orderQty && medVol20 && medVol20 > 0) {
    const participationRate = orderQty / medVol20;
    if (participationRate > 0.01) {
      // Square-root market impact model: impact ∝ sqrt(participation rate)
      // At 2% participation: ~1.4x slippage; at 5%: ~2.2x; at 10%: ~3.2x
      sizeImpactMult = 1.0 + Math.sqrt(participationRate / 0.01) - 1.0;
    }
  }

  return Math.round(rawBps * regimeMult * sizeImpactMult);
}

/**
 * V3.0: Full Indian equity fee breakdown.
 * STT (sell), stamp duty, exchange txn, SEBI turnover, GST, brokerage.
 */
function computeFeeEstimate(fillPrice: number, fillQty: number, side: 'BUY' | 'SELL'): number {
  const tradeValue = fillPrice * fillQty;
  const brokerage = Math.min(INDIAN_FEE_CONFIG.BROKERAGE_FLAT_INR, tradeValue * INDIAN_FEE_CONFIG.BROKERAGE_PCT / 100);
  const exchangeTxn = tradeValue * INDIAN_FEE_CONFIG.EXCHANGE_TXN_PCT / 100;
  const sebiTurnover = tradeValue * INDIAN_FEE_CONFIG.SEBI_TURNOVER_PCT / 100;
  const stampDuty = side === 'BUY' ? tradeValue * INDIAN_FEE_CONFIG.STAMP_DUTY_PCT / 100 : 0; // Stamp duty only on buy
  const stt = side === 'SELL' ? tradeValue * INDIAN_FEE_CONFIG.STT_SELL_PCT / 100 : 0; // STT on sell (delivery)
  const gst = (brokerage + exchangeTxn + sebiTurnover) * INDIAN_FEE_CONFIG.GST_PCT / 100;
  
  return Math.round((brokerage + exchangeTxn + sebiTurnover + stampDuty + stt + gst) * 100) / 100;
}

/**
 * SEPA buying-power gate (pure): the largest quantity ≤ `desiredQty` that keeps
 * gross deployed SEPA capital within `book`. Returns 0 when the book is full, and
 * `desiredQty` unchanged when `priceRef` is unknown (0). Keeps the two strategies
 * from jointly committing more than 100% of equity.
 */
export function capSepaQtyToBook(desiredQty: number, priceRef: number, deployed: number, book: number): number {
  if (!(priceRef > 0)) return desiredQty;
  const affordable = Math.max(0, Math.floor((book - deployed) / priceRef));
  return Math.min(desiredQty, affordable);
}

/**
 * Paper Broker: Places orders for APPROVED signals.
 */
export async function doPlaceOrders(dateId: string, jobId?: string) {
  const db = getDb();
  await logger.info(`[PaperBroker] Placing orders for ${dateId}`, 'PaperBroker', { dateId, jobId });

  checkSafety();

  if (!dateId) {
    console.error('[PaperBroker] Missing dateId for order placement');
    return;
  }

  const signalsSnap = await db.collection('signals').doc(dateId).collection('items')
    .where('status', '==', 'APPROVED').get();

  // SEPA: only the strongest leaders get orders. Rank the day's approved signals by
  // 126-day momentum rank and keep just enough to fill the remaining position slots
  // (MAX_POS minus currently-open positions). The rest are left APPROVED-but-unfilled.
  // The cap applies ONLY to SEPA signals — the metals sleeve manages its own slots in
  // its evaluator, so metals signals are never ranked or dropped here.
  let allowedIds: Set<string> | null = null;
  let sepaBook = Number.POSITIVE_INFINITY;   // gross-capital cap for the SEPA book (INR)
  let sepaDeployed = 0;                        // capital already committed to open SEPA positions (INR, at cost)
  if (SEPA_CONFIG.SEPA_ONLY) {
    const openSnap = await db.collection('portfolio').doc('default').collection('positions')
      .where('status', '==', 'OPEN').get();
    const sepaPositions = openSnap.docs.filter(d => (d.data() as PaperPosition).strategy === 'SepaBreakoutEOD');
    const openSepa = sepaPositions.length;
    // Gross capital already tied up in open SEPA positions (at entry cost).
    sepaDeployed = sepaPositions.reduce((s, d) => {
      const p = d.data() as PaperPosition;
      return s + Math.abs(Number(p.avgEntryPrice) * Number(p.qty));
    }, 0);
    const accountSnap = await db.collection('config').doc('account').get();
    const equity = Number((accountSnap.data() as any)?.equity) || 0;
    sepaBook = equity * SEPA_CONFIG.BOOK_PCT;
    const slots = Math.max(0, SEPA_CONFIG.MAX_POS - openSepa);
    const ranked = signalsSnap.docs
      .filter(d => (d.data() as Signal).strategy === 'SepaBreakoutEOD' && !(d.data() as Signal).execution?.status)
      .map(d => ({ id: d.id, rank: Number((d.data() as Signal).features?.rsRank126 ?? Number.MAX_SAFE_INTEGER) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, slots)
      .map(x => x.id);
    allowedIds = new Set(ranked);
  }

  for (const doc of signalsSnap.docs) {
    const signal = doc.data() as Signal;
    if (signal.execution?.status) continue;
    // The SEPA leader cap only gates SEPA signals; metals (and any other) signals pass.
    if (allowedIds && signal.strategy === 'SepaBreakoutEOD' && !allowedIds.has(doc.id)) continue;

    const atrRef = signal.atrRef || signal.features?.atr14 || 0;
    const stopMult = signal.stopAtrMult || 2.0;
    const originalQty = signal.riskApproval?.sizedQty || 0;
    let sizedQty = originalQty;
    let riskAmount = signal.riskApproval?.riskAmount || 0;

    // SEPA buying-power gate: cap gross deployed capital to the SEPA book so SEPA and
    // the metals sleeve never jointly commit > 100% of equity. priceRef reconstructs
    // the decision close from the SEPA stop (atrRef = close * HARD_STOP_PCT). Scale the
    // order down to the remaining book; skip (leave APPROVED-unfilled) if none is left.
    if (SEPA_CONFIG.SEPA_ONLY && signal.strategy === 'SepaBreakoutEOD') {
      const priceRef = SEPA_CONFIG.HARD_STOP_PCT > 0 ? atrRef / SEPA_CONFIG.HARD_STOP_PCT : 0;
      if (priceRef > 0) {
        sizedQty = capSepaQtyToBook(sizedQty, priceRef, sepaDeployed, sepaBook);
        if (sizedQty <= 0) {
          await logger.info(`[PaperBroker] SEPA ${signal.symbol} unfunded — book full (deployed ${sepaDeployed.toFixed(0)}/${sepaBook.toFixed(0)})`, 'PaperBroker', { jobId, symbol: signal.symbol });
          continue;
        }
        if (sizedQty < originalQty && originalQty > 0) riskAmount = riskAmount * (sizedQty / originalQty);
        sepaDeployed += sizedQty * priceRef;
      }
    }

    const orderId = doc.id;
    const order: PaperOrder = {
      symbol: signal.symbol,
      side: signal.direction,
      orderType: 'ENTRY',
      intendedQty: sizedQty,
      intendedEntryRef: 'OPEN',
      createdFromSignalId: doc.id,
      risk: { plannedR: 1.0, riskAmount, stopDistance: atrRef * stopMult },
      status: 'ACCEPTED'
    };

    await db.collection('paperOrders').doc(dateId).collection('items').doc(orderId).set(order);
    await doc.ref.update({ status: 'ORDERED', execution: { status: 'ORDERED', orderId } });
    await logger.info(`[PaperBroker] ENTRY Order: ${orderId} (${signal.direction})`, 'PaperBroker', { symbol: signal.symbol, orderId, jobId });
  }

  if (jobId) await db.collection('jobs').doc(jobId).update({ stage: 'ORDERS', updatedAt: admin.firestore.Timestamp.now() });
}

/**
 * Morning Fill Simulation (NEXT_OPEN for both Entry and Exit)
 */
export async function doOpenFillSimulation(jobId: string, runDate: string, symbol: string) {
  const db = getDb();
  const dateId = runDate.replace(/-/g, '');
  const prevDateId = await CalendarService.getPrevTradingDateId(dateId);
  if (!prevDateId) return;

  if (!dateId || !prevDateId) {
    console.warn(`[PaperBroker] Skipping fill simulation: missing dateId(${dateId}) or prevDateId(${prevDateId})`);
    return;
  }

  const ordersSnap = await db.collection('paperOrders').doc(prevDateId).collection('items')
    .where('symbol', '==', symbol).where('status', '==', 'ACCEPTED').get();

  if (ordersSnap.empty) return;

  const bar = await getBarOn(db, symbol, dateId);
  if (!bar) return;

  const batch = db.batch();

  for (const doc of ordersSnap.docs) {
    const order = doc.data() as PaperOrder;

    // V2.2: Fetch regime and liquidity bucket for dynamic slippage
    const [regimeSnap, signalSnap] = await Promise.all([
      db.collection('regime').doc(prevDateId).get(),
      order.createdFromSignalId
        ? db.collection('signals').doc(prevDateId).collection('items').doc(order.createdFromSignalId).get()
        : Promise.resolve(null as any),
    ]);
    const regimeState: string = regimeSnap.exists ? (regimeSnap.data() as any)?.marketState ?? 'TREND' : 'TREND';
    const liquidityBucket: 'A' | 'B' | 'C' = (signalSnap?.exists ? (signalSnap.data() as any)?.features?.liquidity?.bucket : undefined) ?? 'A';
    const medVol20: number = (signalSnap?.exists ? (signalSnap.data() as any)?.features?.liquidity?.medVol20 : undefined) ?? 0;

    const slippageBps = computeSlippageBps(liquidityBucket, regimeState, order.intendedQty, medVol20);
    const slippageMult = order.side === 'BUY' ? (1 + slippageBps / 10000) : (1 - slippageBps / 10000);
    let fillPrice = bar.open * slippageMult;
    
    // V3.0: Fill price bounds — clamp to [bar.low, bar.high]
    fillPrice = Math.max(bar.low, Math.min(bar.high, fillPrice));
    
    // V3.0: Gap-through-stop simulation — if open gaps past stop, fill at open (not stop)
    if (order.orderType === 'EXIT' || order.exitType) {
      const posRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
      const posCheck = await posRef.get();
      if (posCheck.exists) {
        const pos = posCheck.data() as PaperPosition;
        if (pos.direction === 'BUY' && bar.open < pos.stopPrice) {
          fillPrice = bar.open; // Gap down through stop — fill at open, not stop
          await logger.warn(`[PaperBroker] GAP THROUGH STOP: ${symbol} opened at ${bar.open} below stop ${pos.stopPrice}`, 'PaperBroker', { symbol, jobId });
        } else if (pos.direction === 'SELL' && bar.open > pos.stopPrice) {
          fillPrice = bar.open; // Gap up through stop for shorts
          await logger.warn(`[PaperBroker] GAP THROUGH STOP: ${symbol} opened at ${bar.open} above stop ${pos.stopPrice}`, 'PaperBroker', { symbol, jobId });
        }
      }
    }
    
    // V3.0: Reject illiquid orders (bucket C with > 5% ADV)
    if (liquidityBucket === 'C' && medVol20 > 0 && order.intendedQty > medVol20 * ADV_LIMITS.MAX_ADV_PCT * 2.5) {
      await logger.warn(`[PaperBroker] REJECTING illiquid order: ${symbol} qty ${order.intendedQty} > ${(ADV_LIMITS.MAX_ADV_PCT * 250).toFixed(0)}% of ADV`, 'PaperBroker', { symbol, jobId });
      batch.update(doc.ref, { status: 'REJECTED', rejectReason: 'ILLIQUID_ORDER' });
      continue;
    }
    
    const feeEstimate = computeFeeEstimate(fillPrice, order.intendedQty, order.side);
    const fillId = `fill_${doc.id}_${dateId}`;

    const fill: PaperFill = {
      orderId: doc.id, symbol, side: order.side, fillPrice, fillQty: order.intendedQty,
      slippageBps, feeEstimate, fillType: order.exitType || 'ENTRY', timestamp: Timestamp.now()
    };
    const fillRef = db.collection('paperFills').doc(dateId).collection('items').doc(fillId);
    // The fill is recorded ONLY once we know it establishes (entry) or settles
    // (exit) a tracked position — see the guarded writes below. Writing it up
    // front left "phantom" fills for orders that then aborted on a missing
    // signal/position: cash the equity ledger never saw (an audit break) and,
    // in live, a filled order with no position behind it.

    if (order.orderType === 'ENTRY') {
      const signalPath = `signals/${prevDateId}/items/${order.createdFromSignalId}`;
      const sigSnap = await db.doc(signalPath).get();
      if (!sigSnap.exists) {
        batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'SIGNAL_MISSING' });
        continue;
      }
      // One position per symbol. The position doc is keyed by symbol, so a second
      // ENTRY while one is still OPEN would OVERWRITE the first — spending cash on
      // shares the system then stops tracking and never exits (a capital leak that
      // broke the independent cash-flow audit). Reject the stacked entry instead.
      const posDocRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
      const existingPos = await posDocRef.get();
      if (existingPos.exists && (existingPos.data() as PaperPosition).status === 'OPEN') {
        batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'POSITION_ALREADY_OPEN' });
        await logger.warn(`[PaperBroker] REJECTING stacked entry: ${symbol} already has an OPEN position`, 'PaperBroker', { symbol, jobId });
        continue;
      }
      batch.set(fillRef, fill);
      const signal = sigSnap.data() as Signal;

      const atrRef = signal.atrRef || 0;
      const finalStop = order.side === 'BUY' ? fillPrice - (atrRef * (signal.stopAtrMult || 2.0)) : fillPrice + (atrRef * (signal.stopAtrMult || 2.0));
      const finalTarget = order.side === 'BUY' ? fillPrice + (atrRef * (signal.targetAtrMult || 3.0)) : fillPrice - (atrRef * (signal.targetAtrMult || 3.0));

      const position: PaperPosition = {
        symbol: order.symbol,
        direction: order.side === 'BUY' ? 'BUY' : 'SELL',
        avgEntryPrice: fillPrice,
        qty: order.intendedQty,
        stopPrice: finalStop, targets: [finalTarget],
        status: 'OPEN', unrealizedPnl: 0, realizedPnl: 0, openedAt: Timestamp.now(), lastUpdatedAt: Timestamp.now(),
        entryFillId: fillId, atrAtEntry: atrRef, partialTaken: false, mfeAtr: 0, entryDateId: dateId,
        riskAmount: order.risk.riskAmount, signalId: order.createdFromSignalId, signalPath,
        // V2.4: Strategy field for per-strategy exit profiles
        strategy: signal.strategy,
        // V3.1: fee/qty basis for realised-P&L attribution across (partial) exits
        entryFee: feeEstimate,
        entryQty: order.intendedQty,
      };

      batch.set(db.collection('portfolio').doc('default').collection('positions').doc(symbol), position);
      batch.update(sigSnap.ref, { 
        status: 'IN_TRADE', stopPrice: finalStop, targets: [finalTarget], rr: (signal.targetAtrMult || 3.0)/(signal.stopAtrMult || 2.0),
        execution: { status: 'FILLED', orderId: doc.id, fillId, entryPrice: fillPrice, entryDateId: dateId }
      });
    } else {
      // EXIT Order Logic
      const posRef = db.collection('portfolio').doc('default').collection('positions').doc(symbol);
      const posSnap = await posRef.get();
      if (!posSnap.exists) {
        batch.update(doc.ref, { status: 'CANCELLED', rejectReason: 'POSITION_MISSING' });
        continue;
      }
      batch.set(fillRef, fill);
      const pos = posSnap.data() as PaperPosition;

      // V3.1: Realise P&L on the exited quantity (partial or full). Attribute a
      // prorated share of the entry fee so entry cost is counted exactly once
      // across all exits of this position. Netting long and short here avoids the
      // broken signed-cash convention entirely.
      const exitQty = order.intendedQty; // == fill.fillQty
      const entryQty = pos.entryQty ?? pos.qty;
      const { realizedPnl, entryFeeShare } = computeExitPnl({
        direction: pos.direction,
        avgEntryPrice: pos.avgEntryPrice,
        exitPrice: fillPrice,
        exitQty,
        entryQty,
        entryFee: pos.entryFee ?? 0,
        exitFee: feeEstimate,
      });
      const rMultiple = pos.riskAmount && pos.riskAmount > 0 && entryQty > 0
        ? realizedPnl / (pos.riskAmount * (exitQty / entryQty))
        : undefined;

      const tradeRec: PaperTrade = {
        symbol,
        direction: pos.direction,
        strategy: pos.strategy,
        entryDateId: pos.entryDateId || '',
        exitDateId: dateId,
        entryPrice: pos.avgEntryPrice,
        exitPrice: fillPrice,
        qty: exitQty,
        fees: feeEstimate + entryFeeShare,
        realizedPnl,
        exitReason: order.exitType,
        entryFillId: pos.entryFillId,
        exitFillId: fillId,
        closedAt: Timestamp.now(),
      };
      if (rMultiple !== undefined) tradeRec.rMultiple = rMultiple;
      // Append-only: keyed by the (unique) exit fill id, never overwritten on re-entry.
      batch.set(db.collection('portfolio').doc('default').collection('trades').doc(fillId), tradeRec);

      if (order.exitType === 'PARTIAL_PROFIT') {
        batch.update(posRef, {
            qty: admin.firestore.FieldValue.increment(-exitQty),
            realizedPnl: admin.firestore.FieldValue.increment(realizedPnl),
            stopPrice: pos.avgEntryPrice, // Breakeven (Gap B3 Rules)
            partialTaken: true,
            lastUpdatedAt: Timestamp.now()
        });
        // Update signal doc also
        if (pos.signalPath) batch.update(db.doc(pos.signalPath), { stopPrice: pos.avgEntryPrice });
      } else {
        // Full Exit
        batch.update(posRef, {
          status: 'CLOSED',
          realizedPnl: admin.firestore.FieldValue.increment(realizedPnl),
          exitReason: order.exitType,
          exitFillId: fillId,
          exitPrice: fillPrice,
          exitDateId: dateId,
          closedAt: Timestamp.now(),
        });
        if (pos.signalPath) batch.update(db.doc(pos.signalPath), { status: 'DONE' });
      }
    }

    batch.update(doc.ref, { status: 'FILLED' });
    await logger.info(`[PaperBroker] ${order.orderType} FILLED for ${symbol} at ${fillPrice.toFixed(2)}`, 'PaperBroker', { symbol, jobId, orderType: order.orderType });
  }

  await batch.commit();
}
