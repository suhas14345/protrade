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
import { getLatestOnOrBefore } from './barCache';

/** Number of trailing equity points used for the realised-vol estimate (→ up to 20 daily returns). */
const VOL_LOOKBACK_POINTS = 21;

/**
 * Pure realised-P&L formula for one (partial or full) exit, fees included.
 *
 * Extracted so it is unit-testable and used by EXACTLY ONE place in production
 * (paperBroker exit path). The entry fee is attributed pro-rata to the exited
 * quantity so the total entry cost is counted once across all exits of a
 * position. Long vs short is netted via price difference, never signed cash.
 */
export function computeExitPnl(params: {
  direction: 'BUY' | 'SELL';
  avgEntryPrice: number;
  exitPrice: number;
  exitQty: number;
  entryQty: number;
  entryFee: number;
  exitFee: number;
}): { realizedPnl: number; entryFeeShare: number } {
  const grossPerShare = params.direction === 'BUY'
    ? params.exitPrice - params.avgEntryPrice
    : params.avgEntryPrice - params.exitPrice;
  const entryFeeShare = params.entryQty > 0
    ? params.entryFee * (params.exitQty / params.entryQty)
    : 0;
  const realizedPnl = grossPerShare * params.exitQty - params.exitFee - entryFeeShare;
  return { realizedPnl, entryFeeShare };
}

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
 * Latest close at or before `dateId` for a symbol, or null if it has no bar on
 * or before that date. A position may still be open on a date the symbol has no
 * bar for (end of data, a halt, or a delisting), so marking to a strict `dateId`
 * lookup would silently value it at zero. Both the equity derivation and the
 * independent backtest audit use THIS function, so they value open positions
 * identically and reconcile. Ascending key-range scan (the emulator rejects
 * descending documentId scans).
 */
export async function lastCloseOnOrBefore(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string
): Promise<number | null> {
  const bar = await getLatestOnOrBefore(db, symbol, dateId);
  return bar ? Number(bar.close) : null;
}

/**
 * Mark ONE open position to `close`, netting the still-unrealised share of its
 * entry fee. This is the SINGLE formula shared by the account-equity roll-up
 * (`computeOpenUnrealized`) and the per-position write-back
 * (`persistOpenPositionMarks`), so a position doc's `unrealizedPnl` always
 * reconciles to `config/account` to the paisa. Long/short is netted via price
 * difference so that, when the position later closes, its realised record
 * replaces exactly this unrealised amount.
 */
export function markPosition(
  p: PaperPosition,
  close: number
): { unrealizedPnl: number; unrealizedPnlPct: number } {
  const gross = (p.direction === 'BUY' ? close - p.avgEntryPrice : p.avgEntryPrice - close) * p.qty;
  const entryQty = p.entryQty ?? p.qty;
  const openEntryFeeShare = (p.entryFee ?? 0) * (entryQty > 0 ? p.qty / entryQty : 0);
  const unrealizedPnl = gross - openEntryFeeShare;
  const cost = Math.abs(p.avgEntryPrice * p.qty);
  const unrealizedPnlPct = cost > 0 ? unrealizedPnl / cost : 0;
  return { unrealizedPnl, unrealizedPnlPct };
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
    const close = await lastCloseOnOrBefore(db, p.symbol, dateId);
    if (close === null) continue;
    total += markPosition(p, close).unrealizedPnl;
  }
  return total;
}

/**
 * Persist each OPEN position's mark-to-market onto its own doc
 * (`currentPrice`, `unrealizedPnl`, `unrealizedPnlPct`, `markDateId`,
 * `lastUpdatedAt`) at `dateId`'s close. Uses the SAME `markPosition` formula and
 * the SAME `lastCloseOnOrBefore` source as `computeOpenUnrealized`, so the sum of
 * the per-position `unrealizedPnl` equals the account's `openUnrealized` exactly —
 * no per-position/account drift. Skips a position whose symbol has no bar on/before
 * `dateId` (so it is valued identically to the account roll-up, which also skips it).
 */
export async function persistOpenPositionMarks(
  db: FirebaseFirestore.Firestore,
  dateId: string
): Promise<void> {
  const snap = await db
    .collection('portfolio').doc('default').collection('positions')
    .where('status', '==', 'OPEN')
    .get();
  const now = admin.firestore.Timestamp.now();
  for (const doc of snap.docs) {
    const p = doc.data() as PaperPosition;
    if (!p.qty || p.qty <= 0) continue;
    const close = await lastCloseOnOrBefore(db, p.symbol, dateId);
    if (close === null) continue;
    const { unrealizedPnl, unrealizedPnlPct } = markPosition(p, close);
    await doc.ref.update({
      currentPrice: close,
      unrealizedPnl,
      unrealizedPnlPct,
      markDateId: dateId,
      lastUpdatedAt: now,
    });
  }
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
 * Resolve the IMMUTABLE equity anchor (deposited capital). Uses `initialEquity` when
 * present; otherwise backfills a STABLE baseline once as `equity − realized − openUnrealized`
 * and flags it for persistence. It deliberately NEVER falls back to `peakEquity`/`equity`
 * as a live anchor — those move every run, so anchoring on them re-adds P&L each EOD and
 * drifts equity up by ~openUnrealized per run (the bug this guards against).
 */
export function resolveInitialEquity(
  account: { initialEquity?: number | null; equity?: number | null },
  realizedToDate: number,
  openUnrealized: number
): { initial: number; backfill: boolean } {
  const existing = account.initialEquity;
  if (existing !== undefined && existing !== null && Number.isFinite(Number(existing))) {
    return { initial: Number(existing), backfill: false };
  }
  const initial = (Number(account.equity) || 0) - realizedToDate - openUnrealized;
  return { initial, backfill: true };
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

  const realizedToDate = await sumRealizedToDate(db, dateId);
  const openUnrealized = await computeOpenUnrealized(db, dateId);

  // Anchor = deposited capital, IMMUTABLE. It must NEVER be peakEquity or equity:
  // those move every run, so anchoring on them re-adds realised+unrealised P&L each
  // EOD and inflates equity unboundedly. See resolveInitialEquity.
  const anchor = resolveInitialEquity(account, realizedToDate, openUnrealized);
  const initial = anchor.initial;
  if (anchor.backfill) {
    await accountRef.set({ initialEquity: initial }, { merge: true });
  }

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

  // Persist equity AND its authoritative breakdown so every consumer (dashboard,
  // reports) reconciles by construction: equity === initialEquity + realizedPnl + openUnrealized.
  await accountRef.update({ equity, peakEquity, equityEMA25, portfolioRealizedVol, realizedPnl: realizedToDate, openUnrealized });
  // Persist per-position marks with the SAME formula/close so position docs
  // reconcile to config/account to the paisa.
  await persistOpenPositionMarks(db, dateId);
  return { equity, peakEquity, equityEMA25, portfolioRealizedVol, realizedToDate, openUnrealized };
}
