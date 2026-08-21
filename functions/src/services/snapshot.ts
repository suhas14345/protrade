import * as admin from 'firebase-admin';
import { computeDeployedCost, settledCash } from './portfolioEquity';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

export interface SnapshotPosition {
  symbol: string; strategy: string; qty: number;
  entry: number; current: number | null; pnl: number | null; pnlPct: number | null; stop: number;
}
export interface DailySnapshot {
  dateId: string;
  account: { equity: number; cash: number; deployed: number; realized: number; unrealized: number };
  positions: SnapshotPosition[];
  activity: { signals: number; approved: number; byStrategy: Record<string, number>; entryOrders: number; entryFills: number; exitFills: number };
  critic: { severity: string; critical: number; warn: number } | null;
}

const inr = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '—' : '₹' + Math.round(Number(n)).toLocaleString('en-IN'));
const pct = (n: number | null | undefined) => (n == null || !Number.isFinite(Number(n)) ? '—' : (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(1) + '%');

/** Render the snapshot as a compact plain-text digest (Telegram/email friendly). Pure. */
export function formatSnapshotText(s: DailySnapshot): string {
  const a = s.account;
  const lines: string[] = [];
  lines.push(`ProTrade snapshot — ${s.dateId}`);
  const critTag = s.critic ? `[${s.critic.severity}${s.critic.critical ? ` ${s.critic.critical} crit` : ''}${s.critic.warn ? ` ${s.critic.warn} warn` : ''}]` : '[critic: n/a]';
  lines.push(`Health ${critTag}`);
  lines.push('');
  lines.push(`Equity ${inr(a.equity)} | Cash ${inr(a.cash)} | Deployed ${inr(a.deployed)}`);
  lines.push(`Realized ${inr(a.realized)} | Unrealized ${inr(a.unrealized)}`);
  lines.push('');
  if (s.positions.length === 0) {
    lines.push('Active trades: none');
  } else {
    lines.push(`Active trades (${s.positions.length}):`);
    for (const p of s.positions) {
      lines.push(`  ${p.symbol} (${p.strategy}) x${p.qty} @ ${inr(p.entry)} -> ${inr(p.current)}  ${inr(p.pnl)} (${pct(p.pnlPct)})  stop ${inr(p.stop)}`);
    }
  }
  lines.push('');
  const byStrat = Object.entries(s.activity.byStrategy).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  lines.push(`Today: ${s.activity.signals} signals (${s.activity.approved} approved; ${byStrat}), ${s.activity.entryOrders} orders, ${s.activity.entryFills} entries / ${s.activity.exitFills} exits filled`);
  return lines.join('\n');
}

/** Assemble the daily snapshot from live Firestore state. */
export async function buildDailySnapshot(dateInput?: string): Promise<DailySnapshot> {
  const db = getDb();
  const date = (dateInput || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const dateId = date.replace(/-/g, '');

  const [accSnap, posSnap, sigSnap, ordSnap, fillSnap, criticSnap] = await Promise.all([
    db.collection('config').doc('account').get(),
    db.collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get(),
    db.collection('signals').doc(dateId).collection('items').get(),
    db.collection('paperOrders').doc(dateId).collection('items').get(),
    db.collection('paperFills').doc(dateId).collection('items').get(),
    db.collection('critic').doc(dateId).get(),
  ]);

  const account: any = accSnap.exists ? accSnap.data() : {};
  const deployed = await computeDeployedCost(db);

  const positions: SnapshotPosition[] = posSnap.docs.map((d) => {
    const p: any = d.data();
    return {
      symbol: p.symbol, strategy: p.strategy || '—', qty: Number(p.qty),
      entry: Number(p.avgEntryPrice),
      current: p.currentPrice != null ? Number(p.currentPrice) : null,
      pnl: p.unrealizedPnl != null ? Number(p.unrealizedPnl) : null,
      pnlPct: p.unrealizedPnlPct != null ? Number(p.unrealizedPnlPct) : null,
      stop: Number(p.stopPrice),
    };
  }).sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));

  const byStrategy: Record<string, number> = {};
  let approved = 0;
  for (const d of sigSnap.docs) {
    const s: any = d.data();
    byStrategy[s.strategy] = (byStrategy[s.strategy] || 0) + 1;
    if (s.status === 'APPROVED' || s.status === 'ORDERED' || s.status === 'IN_TRADE') approved++;
  }
  const entryOrders = ordSnap.docs.filter((d) => (d.data() as any).orderType === 'ENTRY').length;
  let entryFills = 0, exitFills = 0;
  for (const d of fillSnap.docs) {
    const t = (d.data() as any).fillType;
    if (t === 'ENTRY') entryFills++; else exitFills++;
  }

  const critic = criticSnap.exists
    ? { severity: (criticSnap.data() as any).severity, critical: (criticSnap.data() as any).counts?.critical ?? 0, warn: (criticSnap.data() as any).counts?.warn ?? 0 }
    : null;

  return {
    dateId,
    account: {
      equity: Number(account.equity ?? 0),
      cash: account.cashBalance != null ? Number(account.cashBalance) : settledCash(account) - deployed,
      deployed,
      realized: Number(account.realizedPnl ?? 0),
      unrealized: Number(account.openUnrealized ?? 0),
    },
    positions,
    activity: { signals: sigSnap.size, approved, byStrategy, entryOrders, entryFills, exitFills },
    critic,
  };
}

/** Gateway task: { action:"snapshot", date?, format? } — returns text (default) or json. */
export async function snapshotTask(req: any, res: any): Promise<void> {
  try {
    const date = req.body?.date || req.query?.date;
    const format = String(req.body?.format || req.query?.format || 'text');
    const snap = await buildDailySnapshot(date);
    if (format === 'json') { res.status(200).send(snap); return; }
    res.status(200).type('text/plain').send(formatSnapshotText(snap));
  } catch (e: any) {
    res.status(500).send({ error: e.message });
  }
}
