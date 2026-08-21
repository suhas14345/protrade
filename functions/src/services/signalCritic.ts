import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { SEPA_CONFIG, EQUITY_STRATEGIES } from '../config/runtime';
import { settledCash, computeDeployedCost, computeOpenUnrealized } from './portfolioEquity';
import { raiseAlert, AlertType } from './alerting';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

// ── Types ────────────────────────────────────────────────────────────
export type Severity = 'INFO' | 'WARN' | 'CRITICAL';
export interface Finding { code: string; severity: Severity; message: string; context?: Record<string, any>; }

const SEV_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };
export function worstSeverity(findings: Finding[]): Severity {
  return findings.reduce<Severity>((w, f) => (SEV_RANK[f.severity] > SEV_RANK[w] ? f.severity : w), 'INFO');
}

const VALID_STRATEGIES = new Set([
  'PullbackEOD', 'BreakoutCloseEOD', 'ShortBounceEOD', 'MeanReversionEOD',
  'BearBounceEOD', 'RSLeaderEOD', 'SepaBreakoutEOD', 'MetalsRotation', 'ATHPullbackEOD',
]);

// ── Pure checks (unit-tested in isolation) ───────────────────────────

/** EOD job completed cleanly and every dispatched symbol finished. */
export function checkJob(job: any): Finding[] {
  if (!job) return [{ code: 'JOB_MISSING', severity: 'CRITICAL', message: 'No EOD job found for the date' }];
  const f: Finding[] = [];
  if (job.status !== 'DONE') f.push({ code: 'JOB_NOT_DONE', severity: 'CRITICAL', message: `EOD job status is ${job.status}`, context: { stage: job.stage } });
  const c = job.counts || {};
  const total = Number(c.total || 0), done = Number(c.done || 0), failed = Number(c.failed || 0);
  if (failed > 0) f.push({ code: 'JOB_SYMBOLS_FAILED', severity: 'CRITICAL', message: `${failed} symbols failed in fan-out`, context: { failed, total } });
  if (total > 0 && done + failed < total) f.push({ code: 'JOB_INCOMPLETE', severity: 'WARN', message: `fan-out incomplete: ${done + failed}/${total}` });
  return f;
}

/** Feature-window health — the class of bug that silently zeroed all signals. */
export function checkFeatureStats(
  s: { total: number; deepBars: number; sma200RisingTrue: number; criticalNaN: number; rsMissing: number; athSeeded: number },
  indexUp: boolean,
): Finding[] {
  if (s.total === 0) return [{ code: 'FEATURES_MISSING', severity: 'CRITICAL', message: 'No feature docs for the universe on this date' }];
  const f: Finding[] = [];
  // The exact Aug-2026 defect: a rising 200-SMA impossible for the whole universe.
  if (indexUp && s.sma200RisingTrue === 0) {
    f.push({ code: 'TREND_TEMPLATE_IMPOSSIBLE', severity: 'CRITICAL', message: 'Index is up but sma200Rising is FALSE for the entire universe — the trend template can never pass (feature-window/slope bug)', context: { total: s.total } });
  }
  if (s.criticalNaN > 0) f.push({ code: 'FEATURE_NAN', severity: 'CRITICAL', message: `${s.criticalNaN} symbols have non-finite critical features (sma50/150/200/high252)`, context: { count: s.criticalNaN } });
  const deepPct = s.deepBars / s.total;
  if (deepPct < 0.8) f.push({ code: 'SHALLOW_HISTORY', severity: 'WARN', message: `${Math.round((1 - deepPct) * 100)}% of universe has < 260 bars — feature window not full`, context: { deepBars: s.deepBars, total: s.total } });
  if (s.rsMissing / s.total > 0.1) f.push({ code: 'RS_RANK_MISSING', severity: 'WARN', message: `${s.rsMissing} symbols missing rsRank126 (RS pass gap)`, context: { rsMissing: s.rsMissing, total: s.total } });
  if (s.athSeeded < s.total) f.push({ code: 'ATH_SEED_PENDING', severity: 'INFO', message: `true-ATH full-history seed pending for ${s.total - s.athSeeded} symbols`, context: { seeded: s.athSeeded, total: s.total } });
  return f;
}

/** Signal integrity + presence given the regime/leadership context. */
export function checkSignals(signals: any[], ctx: { indexUp: boolean; sma200RisingTrue: number }): Finding[] {
  const f: Finding[] = [];
  for (const s of signals) {
    if (!VALID_STRATEGIES.has(s.strategy)) f.push({ code: 'SIGNAL_BAD_STRATEGY', severity: 'WARN', message: `signal ${s.symbol} has unknown strategy "${s.strategy}"` });
    if (s.status === 'APPROVED') {
      if (!(Number(s.riskApproval?.sizedQty) > 0)) f.push({ code: 'SIGNAL_ZERO_QTY', severity: 'WARN', message: `APPROVED signal ${s.symbol} has non-positive sizedQty`, context: { strategy: s.strategy } });
      if (!(Number(s.atrRef) > 0)) f.push({ code: 'SIGNAL_BAD_ATRREF', severity: 'WARN', message: `signal ${s.symbol} has atrRef <= 0 (stop distance undefined)` });
    }
  }
  const equity = signals.filter((s) => s.strategy === 'SepaBreakoutEOD' || s.strategy === 'ATHPullbackEOD');
  // Leaders exist and the index is up, yet nothing fired — legit if none are near-high, but worth a look.
  if (ctx.indexUp && ctx.sma200RisingTrue > 0 && equity.length === 0) {
    f.push({ code: 'NO_EQUITY_SIGNALS', severity: 'WARN', message: `index up with ${ctx.sma200RisingTrue} trend-leaders, but 0 equity signals — verify near-high / pullback gates`, context: { sma200RisingTrue: ctx.sma200RisingTrue } });
  }
  return f;
}

/** Orders map to real signals, are sized, and limit orders carry a ceiling. */
export function checkOrders(entryOrders: any[], signalIds: Set<string>): Finding[] {
  const f: Finding[] = [];
  for (const o of entryOrders) {
    if (o.createdFromSignalId && !signalIds.has(o.createdFromSignalId)) f.push({ code: 'ORDER_ORPHAN', severity: 'WARN', message: `entry order ${o.symbol} references a missing signal`, context: { signalId: o.createdFromSignalId } });
    if (!(Number(o.intendedQty) > 0)) f.push({ code: 'ORDER_ZERO_QTY', severity: 'WARN', message: `entry order ${o.symbol} has qty <= 0` });
    if (o.intendedEntryRef === 'LIMIT' && !(Number(o.limitHi) > 0)) f.push({ code: 'ORDER_LIMIT_NO_CEILING', severity: 'WARN', message: `LIMIT order ${o.symbol} has no limitHi ceiling` });
  }
  return f;
}

/** No symbol ordered by more than one equity strategy on the same day (double-entry guard). */
export function checkCrossStrategyDup(entryOrders: { symbol: string; strategy: string }[]): Finding[] {
  const bySym = new Map<string, Set<string>>();
  for (const o of entryOrders) {
    if (!bySym.has(o.symbol)) bySym.set(o.symbol, new Set());
    bySym.get(o.symbol)!.add(o.strategy);
  }
  const f: Finding[] = [];
  for (const [sym, strats] of bySym) {
    if (strats.size > 1) f.push({ code: 'DUP_SYMBOL_ORDERS', severity: 'CRITICAL', message: `${sym} ordered by multiple strategies same day: ${[...strats].join(', ')}` });
  }
  return f;
}

/** Open positions: one per symbol, positive qty, sane entry. */
export function checkPositions(openPositions: any[]): Finding[] {
  const f: Finding[] = [];
  const seen = new Set<string>();
  for (const p of openPositions) {
    if (seen.has(p.symbol)) f.push({ code: 'DUP_OPEN_POSITION', severity: 'CRITICAL', message: `duplicate OPEN position for ${p.symbol}` });
    seen.add(p.symbol);
    if (!(Number(p.qty) > 0)) f.push({ code: 'POSITION_ZERO_QTY', severity: 'CRITICAL', message: `OPEN position ${p.symbol} has qty <= 0` });
    if (!(Number(p.avgEntryPrice) > 0)) f.push({ code: 'POSITION_BAD_ENTRY', severity: 'WARN', message: `OPEN position ${p.symbol} has avgEntryPrice <= 0` });
  }
  return f;
}

/** Gross equity capital never exceeds the shared book (settled cash × BOOK_PCT). */
export function checkCapital(openEquityCost: number, settled: number, bookPct: number): Finding[] {
  const book = settled * bookPct;
  if (openEquityCost > book * 1.001) return [{ code: 'BOOK_OVER_DEPLOYED', severity: 'CRITICAL', message: `equity deployed ${openEquityCost.toFixed(0)} exceeds book ${book.toFixed(0)}`, context: { openEquityCost, book } }];
  return [];
}

/** Ledger identities to the rupee: equity = initial + realized + unrealized; cash = settled − deployed. */
export function checkLedger(
  l: { equity: number; deployed: number; unrealized: number; realizedPnl: number; initialEquity: number; cashBalance?: number | null; sumTradesRealized?: number | null },
  tolInr = 1,
): Finding[] {
  const f: Finding[] = [];
  const anchor = l.initialEquity + l.realizedPnl + l.unrealized;
  if (Math.abs(l.equity - anchor) > tolInr) f.push({ code: 'EQUITY_IDENTITY_BREAK', severity: 'CRITICAL', message: `equity ${l.equity.toFixed(2)} != initial+realized+unrealized ${anchor.toFixed(2)} (diff ${(l.equity - anchor).toFixed(2)})` });
  const cash = l.initialEquity + l.realizedPnl - l.deployed;
  if (l.cashBalance != null && Math.abs(l.cashBalance - cash) > tolInr) f.push({ code: 'CASH_IDENTITY_BREAK', severity: 'CRITICAL', message: `cashBalance ${l.cashBalance.toFixed(2)} != settledCash-deployed ${cash.toFixed(2)}` });
  if (cash < -tolInr) f.push({ code: 'NEGATIVE_CASH', severity: 'CRITICAL', message: `available cash is negative: ${cash.toFixed(2)}` });
  if (l.sumTradesRealized != null && Math.abs(l.realizedPnl - l.sumTradesRealized) > tolInr) f.push({ code: 'REALIZED_MISMATCH', severity: 'WARN', message: `account.realizedPnl ${l.realizedPnl.toFixed(2)} != Σ trades ${l.sumTradesRealized.toFixed(2)}` });
  return f;
}

// ── Orchestrator ─────────────────────────────────────────────────────

function toDateId(d: string): string { return d.replace(/-/g, ''); }
function toDate(d: string): string { return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d; }

/**
 * Daily signal critic: runs the full battery of invariant checks over one day's
 * features/regime/signals/orders/positions/ledger and returns a report. Writes the
 * report to critic/{dateId}; raises an alert only when opts.alert is true.
 */
export async function doAuditSignals(
  dateInput?: string,
  opts: { alert?: boolean; universe?: string } = {},
): Promise<any> {
  const db = getDb();
  const date = toDate(dateInput || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const dateId = toDateId(date);
  const universe = opts.universe || 'nifty200';

  // 1. EOD job for the date
  const jobsSnap = await db.collection('jobs').where('runDate', '==', date).get();
  const eodJobs = jobsSnap.docs.map((d) => d.data()).filter((j: any) => j.type === 'EOD_RUN');
  eodJobs.sort((a: any, b: any) => String(b.updatedAt?.toMillis?.() ?? 0).localeCompare(String(a.updatedAt?.toMillis?.() ?? 0)));
  const job = eodJobs[0] || null;

  // 2. Regime → indexUp
  const regimeSnap = await db.collection('regime').doc(dateId).get();
  const regime: any = regimeSnap.exists ? regimeSnap.data() : null;
  const m = regime?.metrics;
  const indexUp = !!m && Number(m.close) > Number(m.ema200) && Number(m.ema200Slope ?? 0) > 0 && regime.marketState !== 'BEAR';

  // 3. Feature stats across the universe
  const membersSnap = await db.collection('universes').doc(universe).collection('members').get();
  const symbols = membersSnap.docs.map((d) => d.id);
  const featRefs = symbols.map((s) => db.collection('features').doc(s).collection('days').doc(dateId));
  const parentRefs = symbols.map((s) => db.collection('features').doc(s));
  const stats = { total: 0, deepBars: 0, sma200RisingTrue: 0, criticalNaN: 0, rsMissing: 0, athSeeded: 0 };
  for (let i = 0; i < featRefs.length; i += 200) {
    const [daySnaps, parentSnaps] = await Promise.all([
      db.getAll(...featRefs.slice(i, i + 200)),
      db.getAll(...parentRefs.slice(i, i + 200)),
    ]);
    daySnaps.forEach((snap, k) => {
      if (!snap.exists) return;
      const d: any = snap.data();
      stats.total++;
      if (Number(d.barsCount) >= 260) stats.deepBars++;
      if (d.sma200Rising === true) stats.sma200RisingTrue++;
      const finite = [d.sma50, d.sma150, d.sma200, d.high252].every((x) => Number.isFinite(Number(x)));
      if (!finite) stats.criticalNaN++;
      if (!Number.isFinite(Number(d.rsRank126))) stats.rsMissing++;
      const p: any = parentSnaps[k]?.data();
      if (p?.athHighFullScan === true) stats.athSeeded++;
    });
  }

  // 4. Signals / orders / positions / account
  const [sigSnap, ordSnap, posSnap, accSnap] = await Promise.all([
    db.collection('signals').doc(dateId).collection('items').get(),
    db.collection('paperOrders').doc(dateId).collection('items').get(),
    db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get(),
    db.collection('config').doc('account').get(),
  ]);
  const signals = sigSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
  const signalIds = new Set(signals.map((s) => s.id));
  const signalStrategyById = new Map(signals.map((s) => [s.id, s.strategy]));
  const orders = ordSnap.docs.map((d) => d.data() as any);
  const entryOrders = orders.filter((o) => o.orderType === 'ENTRY');
  const entryOrdersWithStrat = entryOrders.map((o) => ({ symbol: o.symbol, strategy: signalStrategyById.get(o.createdFromSignalId) || 'UNKNOWN' }));
  const openPositions = posSnap.docs.map((d) => d.data() as any);
  const account: any = accSnap.exists ? accSnap.data() : {};

  // 5. Ledger inputs (independent recompute)
  const EQUITY = new Set(EQUITY_STRATEGIES);
  const openEquityCost = openPositions
    .filter((p) => EQUITY.has(p.strategy || ''))
    .reduce((s, p) => s + Math.abs(Number(p.avgEntryPrice) * Number(p.qty)), 0);
  const [deployed, unrealized] = await Promise.all([
    computeDeployedCost(db),
    computeOpenUnrealized(db, dateId),
  ]);
  const initialEquity = Number(account.initialEquity ?? account.equity ?? 0);
  const realizedPnl = Number(account.realizedPnl ?? 0);

  // 6. Run the battery
  const findings: Finding[] = [
    ...checkJob(job),
    ...checkFeatureStats(stats, indexUp),
    ...checkSignals(signals, { indexUp, sma200RisingTrue: stats.sma200RisingTrue }),
    ...checkOrders(entryOrders, signalIds),
    ...checkCrossStrategyDup(entryOrdersWithStrat),
    ...checkPositions(openPositions),
    ...checkCapital(openEquityCost, settledCash(account), SEPA_CONFIG.BOOK_PCT),
    ...checkLedger({
      equity: Number(account.equity ?? 0),
      deployed: Number(deployed),
      unrealized: Number(unrealized),
      realizedPnl,
      initialEquity,
      cashBalance: account.cashBalance != null ? Number(account.cashBalance) : null,
    }),
  ];

  const severity = worstSeverity(findings);
  const report = {
    dateId,
    date,
    universe,
    generatedAt: Timestamp.now(),
    severity,
    indexUp,
    counts: {
      signals: signals.length,
      approvedSignals: signals.filter((s) => s.status === 'APPROVED').length,
      entryOrders: entryOrders.length,
      openPositions: openPositions.length,
      findings: findings.length,
      critical: findings.filter((f) => f.severity === 'CRITICAL').length,
      warn: findings.filter((f) => f.severity === 'WARN').length,
    },
    featureStats: stats,
    findings,
  };

  await db.collection('critic').doc(dateId).set(report);
  await logger.info(`[Critic] ${dateId} severity=${severity} findings=${findings.length} (crit=${report.counts.critical} warn=${report.counts.warn})`, 'Critic', { dateId });

  if (opts.alert && severity !== 'INFO') {
    const top = findings.filter((f) => f.severity === 'CRITICAL').slice(0, 5).map((f) => f.code).join(', ') || findings.filter((f) => f.severity === 'WARN').slice(0, 5).map((f) => f.code).join(', ');
    await raiseAlert(AlertType.SIGNAL_AUDIT, severity === 'CRITICAL' ? 'CRITICAL' : 'WARN', `Daily signal critic ${dateId}: ${report.counts.critical} critical, ${report.counts.warn} warn (${top})`, { dateId, findings });
  }

  return report;
}

/** Gateway task wrapper: { action:"auditSignals", date?, universe?, alert? } */
export async function auditSignalsTask(req: any, res: any): Promise<void> {
  try {
    const date = req.body?.date || req.query?.date;
    const universe = req.body?.universe || req.query?.universe;
    const alert = String(req.body?.alert ?? req.query?.alert ?? 'false') === 'true';
    const report = await doAuditSignals(date, { alert, universe });
    res.status(200).send(report);
  } catch (e: any) {
    res.status(500).send({ error: e.message });
  }
}
