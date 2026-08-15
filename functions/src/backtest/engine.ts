/**
 * Synchronous replay engine.
 *
 * Faithful backtest driver: it calls the SAME stage functions the live
 * orchestrator uses (features, regime, RS ranking, signals, risk, paper broker,
 * trade manager) in the SAME order — but invokes them directly, in-process,
 * instead of via the Cloud Tasks queue (which the local emulator does not run).
 * This guarantees backtest and live share identical decision + fill logic.
 *
 * It also closes the P&L loop the production code leaves open: on each fill it
 * updates a cash ledger, reconstructs closed trades, marks open positions to
 * market at the day's close, and writes equity / peakEquity / equityEMA25 /
 * portfolioRealizedVol back to config/account so the drawdown and vol-targeting
 * risk gates actually respond during the replay.
 */
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { PaperTrade, PaperFill, PaperPosition } from '../models';
import { RUNTIME_CONFIG } from '../config/runtime';
import { doComputeFeatures } from '../services/features';
import { doComputeRegime } from '../services/regime';
import { doComputeRsRanking } from '../services/rsRanking';
import { doEvaluateSignals } from '../services/strategy';
import { doManageTrades } from '../services/tradeManager';
import { doPlaceOrders, doOpenFillSimulation } from '../services/paperBroker';
import { recomputeAccountEquity, computeOpenUnrealized, lastCloseOnOrBefore } from '../services/portfolioEquity';
import { INDEX_SYMBOL } from './seed';
import { ClosedTrade, EquityPoint } from './metrics';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/** Max concurrent per-symbol stage calls against the emulator. Override with BT_CONCURRENCY. */
const STAGE_CONCURRENCY = Math.max(1, parseInt(process.env.BT_CONCURRENCY || '16', 10));

/** Firestore path to the append-only realised-trade ledger (matches production paperBroker). */
const tradesCol = (db: FirebaseFirestore.Firestore) =>
  db.collection('portfolio').doc('default').collection('trades');

export interface ReplayOptions {
  universeId: string;
  symbols: string[];
  dates: { dateId: string; isoDate: string }[];
  /** Index into `dates` at which trading begins (earlier bars are warm-up only). */
  tradeStartIndex: number;
  initialEquity: number;
  /** Optional progress callback (dayIndex, dateId, equity). */
  onDay?: (i: number, dateId: string, equity: number) => void;
}

export interface ReplayResult {
  curve: EquityPoint[];
  trades: ClosedTrade[];
}

/**
 * Run the day-by-day replay. Returns the equity curve and reconstructed trades.
 */
export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const db = getDb();
  // Backtest mode: disables market-hours guard and data-staleness checks.
  RUNTIME_CONFIG.MODE = 'REPLAY';

  const { universeId, symbols, dates } = opts;
  const initial = opts.initialEquity;
  const curve: EquityPoint[] = [];

  for (let i = opts.tradeStartIndex; i < dates.length; i++) {
    const day = dates[i];
    const jobId = `bt_${day.dateId}`;

    // Ensure a job doc exists so stage functions' .update() calls succeed.
    await db.collection('jobs').doc(jobId).set({
      runDate: day.isoDate,
      universeId,
      type: 'EOD_RUN',
      stage: 'FETCH',
      counts: { total: symbols.length, processed: 0, failed: 0 },
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });

    // 1. Fill yesterday's ACCEPTED orders at today's open (entries and exits). This
    //    is the SAME production path that writes authoritative position docs and,
    //    on every exit, appends an immutable realised-trade record. The engine no
    //    longer keeps a parallel cash ledger — it reads that authoritative state.
    await mapPool(symbols, STAGE_CONCURRENCY, (sym) => doOpenFillSimulation(jobId, day.isoDate, sym));

    // 2. Manage open positions vs today's close → queues exit orders for tomorrow.
    await doManageTrades(day.dateId, jobId);

    // 3. Features for the index and every tradable symbol.
    await safeStage(() => doComputeFeatures(jobId, INDEX_SYMBOL, day.isoDate));
    await mapPool(symbols, STAGE_CONCURRENCY, (sym) => safeStage(() => doComputeFeatures(jobId, sym, day.isoDate)));

    // 4. Regime, 5. RS ranking.
    await doComputeRegime(day.isoDate, jobId, INDEX_SYMBOL, universeId);
    await doComputeRsRanking(day.dateId, jobId, universeId);

    // 6. Signals per symbol.
    await mapPool(symbols, STAGE_CONCURRENCY, (sym) => safeStage(() => doEvaluateSignals(jobId, sym, day.isoDate, undefined, universeId)));

    // 7. Approved signals → ACCEPTED entry orders (filled tomorrow at open).
    await doPlaceOrders(day.dateId, jobId);

    // 8. Equity from AUTHORITATIVE state via the SHARED updater the live EOD path
    //    also calls (services/portfolioEquity): realised P&L booked so far plus
    //    open positions marked to market at today's close. It writes equity /
    //    peakEquity / equityEMA25 / portfolioRealizedVol back to config/account so
    //    the drawdown and vol-targeting risk gates respond during replay — and,
    //    because live calls the SAME function, the two paths cannot diverge.
    const update = await recomputeAccountEquity(db, day.dateId);
    const equity = update ? update.equity : initial;
    curve.push({ dateId: day.dateId, equity });

    if (opts.onDay) opts.onDay(i, day.dateId, equity);
  }

  // Authoritative closed-trade list from the append-only trades ledger.
  const trades = await loadClosedTrades(db);
  const lastDateId = dates[dates.length - 1].dateId;
  const curveEnd = curve.length ? curve[curve.length - 1].equity : initial;

  // ---- Reconciliation 1 (self-consistency): the equity curve must equal
  //      realised P&L plus open-position MTM, both derived from the ledger. ----
  const totalRealized = trades.reduce((a, t) => a + t.pnl, 0);
  const finalOpenUnrealized = await computeOpenUnrealized(db, lastDateId);
  const ledgerPnl = totalRealized + finalOpenUnrealized;
  const selfDrift = Math.abs((initial + ledgerPnl) - curveEnd);

  // ---- Reconciliation 2 (INDEPENDENT double-entry): reconstruct net trading
  //      P&L purely from raw cash flows (every fill: sell = +cash, buy = -cash,
  //      minus fees) plus the market value of still-open positions. This shares
  //      NO code with the per-share P&L formula, so a formula bug shows up here
  //      as a rupee-scale mismatch. The two methods are algebraically identical
  //      (incl. entry-fee proration on partials), so they must agree to the paisa. ----
  const dateIds = dates.map((d) => d.dateId);
  const independentPnl = await reconstructPnlFromCashFlows(db, dateIds, lastDateId);
  const crossDrift = Math.abs(ledgerPnl - independentPnl);

  console.log(
    `[backtest] ledger reconciled: curveEnd=₹${curveEnd.toFixed(2)} ` +
    `realised=₹${totalRealized.toFixed(2)} openUnreal=₹${finalOpenUnrealized.toFixed(2)} | ` +
    `independent(cash-flow)=₹${independentPnl.toFixed(2)} ` +
    `selfDrift=₹${selfDrift.toFixed(4)} crossDrift=₹${crossDrift.toFixed(4)}`
  );

  // Zero-tolerance policy: a ledger error of even ₹1 is a bug, not noise. The
  // threshold is 1 paisa to absorb pure float re-summation ordering only.
  const TOL = 0.01;
  if (selfDrift > TOL) {
    throw new Error(
      `[backtest] Self-reconciliation FAILED: initial+realised+unrealised ₹${(initial + ledgerPnl).toFixed(2)} ` +
      `!= equity curve end ₹${curveEnd.toFixed(2)} (drift ₹${selfDrift.toFixed(4)}).`
    );
  }
  if (crossDrift > TOL) {
    throw new Error(
      `[backtest] Independent double-entry reconciliation FAILED: ledger P&L ₹${ledgerPnl.toFixed(2)} ` +
      `!= cash-flow P&L ₹${independentPnl.toFixed(2)} (drift ₹${crossDrift.toFixed(4)}). ` +
      `A realised-P&L formula or fill-accounting bug is present.`
    );
  }

  return { curve, trades };
}

/** Run a per-symbol stage but swallow "insufficient data" style errors so one bad symbol can't halt the day. */
async function safeStage(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/insufficient|not enough|Needs 25|No bars|missing/i.test(msg)) throw e;
  }
}

/**
 * Run `fn` over `items` with bounded concurrency. The per-symbol stages
 * (fill sim, feature compute, signal eval) are independent within a stage —
 * each reads/writes only its own symbol's documents — so parallelising them
 * changes only wall-clock time, not results. Aggregate stages (regime, RS
 * ranking, order placement) stay sequential and run after these complete.
 */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

/**
 * Independent double-entry reconstruction of net trading P&L from raw cash flows.
 *
 * For every fill: SELL brings cash in (+price*qty), BUY takes cash out (-price*qty),
 * and fees always reduce cash. Add back the market value of positions still open
 * on `lastDateId` (long = +qty*close, short = -qty*close). The result equals total
 * realised P&L (closed trades) + open-position mark-to-market — but is computed
 * without touching the per-share P&L formula or the trades ledger, so it is a true
 * independent check on both.
 */
async function reconstructPnlFromCashFlows(
  db: FirebaseFirestore.Firestore,
  dateIds: string[],
  lastDateId: string
): Promise<number> {
  let cashFlow = 0;
  for (const dateId of dateIds) {
    const snap = await db.collection('paperFills').doc(dateId).collection('items').get();
    snap.docs.forEach((d) => {
      const f = d.data() as PaperFill;
      const sign = f.side === 'SELL' ? 1 : -1;
      cashFlow += sign * f.fillPrice * f.fillQty - f.feeEstimate;
    });
  }

  let marketValue = 0;
  const openSnap = await db
    .collection('portfolio').doc('default').collection('positions')
    .where('status', '==', 'OPEN')
    .get();
  for (const doc of openSnap.docs) {
    const p = doc.data() as PaperPosition;
    if (!p.qty || p.qty <= 0) continue;
    const close = await lastCloseOnOrBefore(db, p.symbol, lastDateId);
    if (close === null) continue;
    marketValue += (p.direction === 'BUY' ? 1 : -1) * p.qty * close;
  }

  return cashFlow + marketValue;
}

/** Load the authoritative closed-trade list from the append-only trades ledger. */
async function loadClosedTrades(db: FirebaseFirestore.Firestore): Promise<ClosedTrade[]> {
  const snap = await tradesCol(db).get();
  const out: ClosedTrade[] = snap.docs.map((d) => {
    const t = d.data() as PaperTrade;
    const ct: ClosedTrade = {
      symbol: t.symbol,
      direction: t.direction,
      entryDateId: t.entryDateId,
      exitDateId: t.exitDateId,
      qty: t.qty,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      fees: t.fees,
      pnl: t.realizedPnl,
      rMultiple: t.rMultiple,
      exitReason: t.exitReason,
    };
    return ct;
  });
  out.sort((a, b) => (a.exitDateId < b.exitDateId ? -1 : a.exitDateId > b.exitDateId ? 1 : 0));
  return out;
}
