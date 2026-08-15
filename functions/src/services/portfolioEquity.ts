/**
 * Single source of truth for account equity, drawdown, and realized-vol.
 *
 * The daily "roll realised + unrealised P&L into account equity" step used to
 * live ONLY in the backtest engine, so live never updated `config/account.equity`
 * after the seed — position sizing never compounded, the drawdown gate never
 * fired, and `portfolioRealizedVol` (which switches strategy.ts into vol-targeted
 * sizing) was never written in production. That made live and backtest diverge on
 * exactly the risk gates the strategy depends on.
 *
 * Both the live orchestrator (via aggregateStats.updateEquityCurve) and the
 * backtest engine now call `recomputeAccountEquity` so the two paths cannot drift.
 *
 * Equity is derived from AUTHORITATIVE state, never a parallel ledger:
 *   equity = initialEquity
 *          + Σ realizedPnl over all trades closed on/before dateId
 *          + Σ open-position mark-to-market at dateId's close (net of the still
 *            -unrealised share of each position's entry fee)
 */
import * as admin from 'firebase-admin';
import { PaperPosition, PaperTrade } from '../models';
import { DRAWDOWN_CONFIG } from '../config/runtime';

/** Number of trailing equity points used for the realised-vol estimate (→ up to 20 daily returns). */
const VOL_LOOKBACK_POINTS = 21;

/** Cumulative realised P&L booked by the exit path for all trades closed on/before `dateId`. */
export async function sumRealizedToDate(
  db: FirebaseFirestore.Firestore,
  dateId: string
): Promise<number> {
  const snap = await db
    .collection('portfolio').doc('default').collection('trades')
    .where('exitDateId', '<=', dateId)
    .get();
  let total = 0;
  snap.docs.forEach((d) => { total += Number((d.data() as PaperTrade).realizedPnl) || 0; });
  return total;
}

/**
 * Mark every currently-OPEN position to market at `dateId`'s close, netting the
 * still-unrealised share of its entry fee. Netting long/short via P&L (not signed
 * cash) is what makes the equity curve reconcile: when a position later closes,
 * its realised record replaces exactly this unrealised amount.
 */
export async function computeOpenUnrealized(
  db: FirebaseFirestore.Firestore,
  dateId: string
): Promise<number> {
  const snap = await db
    .collection('portfolio').doc('default').collection('positions')
    .where('status', '==', 'OPEN')
    .get();
  let total = 0;
  for (const doc of snap.docs) {
    const p = doc.data() as PaperPosition;
    if (!p.qty || p.qty <= 0) continue;
    const barSnap = await db.collection('barsD').doc(p.symbol).collection('days').doc(dateId).get();
    if (!barSnap.exists) continue;
    const close = Number((barSnap.data() as { close: number }).close);
    const gross = (p.direction === 'BUY' ? close - p.avgEntryPrice : p.avgEntryPrice - close) * p.qty;
    const entryQty = p.entryQty ?? p.qty;
    const openEntryFeeShare = (p.entryFee ?? 0) * (entryQty > 0 ? p.qty / entryQty : 0);
    total += gross - openEntryFeeShare;
  }
  return total;
}

/** Simple period-over-period returns from an equity series (skips non-positive prevs). */
function dailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) out.push(equity[i] / prev - 1);
  }
  return out;
}

/** Annualised (252d) standard deviation of a return series. */
function annualisedVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - m) * (b - m), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

export interface EquityUpdate {
  equity: number;
  peakEquity: number;
  equityEMA25: number;
  portfolioRealizedVol: number;
  realizedToDate: number;
  openUnrealized: number;
}

/**
 * Recompute account equity from authoritative state at `dateId`, persist a daily
 * equity snapshot, refresh peak / EMA / realised-vol, and write them back to
 * `config/account`. Returns the update, or null if there is no account config.
 *
 * Idempotent per `dateId`: re-running overwrites that day's snapshot and account
 * fields with the same derived values.
 */
export async function recomputeAccountEquity(
  db: FirebaseFirestore.Firestore,
  dateId: string
): Promise<EquityUpdate | null> {
  const accountRef = db.collection('config').doc('account');
  const accountSnap = await accountRef.get();
  if (!accountSnap.exists) return null;
  const account = accountSnap.data() as {
    initialEquity?: number; equity?: number; peakEquity?: number;
  };
  // Anchor for the derivation. Falls back to the seed value if an older account
  // doc predates the initialEquity field.
  const initial = account.initialEquity ?? account.peakEquity ?? account.equity ?? 1_000_000;

  const realizedToDate = await sumRealizedToDate(db, dateId);
  const openUnrealized = await computeOpenUnrealized(db, dateId);
  const equity = initial + realizedToDate + openUnrealized;

  // Persist today's equity snapshot (idempotent per dateId).
  await db.collection('stats').doc('equityCurve').collection('days').doc(dateId).set({
    equity, dateId, recordedAt: admin.firestore.Timestamp.now(),
  });

  // Refresh EMA + realised-vol from the snapshot series. Bounded ascending
  // key-range scan (the emulator rejects descending key scans, and limitToLast
  // is rewritten into one by the SDK).
  const period = DRAWDOWN_CONFIG.EQUITY_EMA_PERIOD;
  const lb = new Date(Date.UTC(+dateId.slice(0, 4), +dateId.slice(4, 6) - 1, +dateId.slice(6, 8)));
  lb.setUTCDate(lb.getUTCDate() - Math.ceil(Math.max(period, VOL_LOOKBACK_POINTS) * 1.7) - 15);
  const lowerBound = `${lb.getUTCFullYear()}${String(lb.getUTCMonth() + 1).padStart(2, '0')}${String(lb.getUTCDate()).padStart(2, '0')}`;
  const snapshots = await db.collection('stats').doc('equityCurve').collection('days')
    .where(admin.firestore.FieldPath.documentId(), '>=', lowerBound)
    .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .get();
  const series = snapshots.docs.map((d) => (d.data() as { equity: number }).equity);

  const emaWindow = series.slice(-period);
  let equityEMA25 = emaWindow[0] ?? equity;
  const k = 2 / (period + 1);
  for (let i = 1; i < emaWindow.length; i++) {
    equityEMA25 = emaWindow[i] * k + equityEMA25 * (1 - k);
  }

  const volWindow = series.slice(-VOL_LOOKBACK_POINTS);
  const portfolioRealizedVol = annualisedVol(dailyReturns(volWindow));

  const peakEquity = Math.max(account.peakEquity ?? equity, equity);

  await accountRef.update({ equity, peakEquity, equityEMA25, portfolioRealizedVol });
  return { equity, peakEquity, equityEMA25, portfolioRealizedVol, realizedToDate, openUnrealized };
}
