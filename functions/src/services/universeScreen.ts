import * as admin from 'firebase-admin';
import { Bar } from '../models';
import { getWindowOnOrBefore } from './barCache';
import { SCREEN_CONFIG } from '../config/runtime';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

export interface ScreenStats {
  close: number;
  medTradedValue20: number;
  barsCount: number;
  sma200: number;
  high252: number;
  ret126: number | null;
  priceOk: boolean;
  liquidOk: boolean;
  historyOk: boolean;
  above200: boolean;
  nearHigh: boolean;
  eligibleBase: boolean;      // passes every non-momentum precondition
  failedGate: string | null;  // first failing gate (for diagnostics)
}

/**
 * Pure per-symbol screen evaluation. Applies SEPA's necessary preconditions (price, liquidity,
 * history, above-200DMA, within 25% of 52w high) and returns 126-day momentum for cross-sectional
 * RS ranking done by the caller. No I/O — unit-testable.
 */
export function evaluateScreenStats(bars: Pick<Bar, 'close' | 'volume'>[], cfg = SCREEN_CONFIG): ScreenStats {
  const empty: ScreenStats = {
    close: NaN, medTradedValue20: NaN, barsCount: bars.length, sma200: NaN, high252: NaN,
    ret126: null, priceOk: false, liquidOk: false, historyOk: false, above200: false, nearHigh: false,
    eligibleBase: false, failedGate: 'history',
  };
  if (bars.length < cfg.MIN_BARS) return empty;

  const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c));
  if (closes.length < cfg.MIN_BARS) return empty;
  const close = closes[closes.length - 1];

  const recent20 = bars.slice(-20);
  const tradedValues = recent20.map((b) => (Number(b.close) || 0) * (Number(b.volume) || 0)).sort((a, b) => a - b);
  const medTradedValue20 = tradedValues[Math.floor(tradedValues.length / 2)] || 0;

  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
  const win252 = closes.slice(-252);
  const high252 = Math.max(...win252);
  const ret126 = closes.length >= 127 ? close / closes[closes.length - 127] - 1 : null;

  const priceOk = close >= cfg.MIN_PRICE;
  const liquidOk = medTradedValue20 >= cfg.MIN_MED_TRADED_VALUE;
  const historyOk = closes.length >= cfg.MIN_BARS;
  const above200 = !cfg.REQUIRE_ABOVE_200DMA || close > sma200;
  const nearHigh = high252 > 0 && close >= high252 * (1 - cfg.NEAR_HIGH_PCT);

  let failedGate: string | null = null;
  if (!historyOk) failedGate = 'history';
  else if (!priceOk) failedGate = 'price';
  else if (!liquidOk) failedGate = 'liquidity';
  else if (!above200) failedGate = 'below_200dma';
  else if (!nearHigh) failedGate = 'far_from_high';

  return {
    close, medTradedValue20, barsCount: closes.length, sma200, high252, ret126,
    priceOk, liquidOk, historyOk, above200, nearHigh,
    eligibleBase: failedGate === null, failedGate,
  };
}

function istTodayDateId(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10).replace(/-/g, '');
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; try { await worker(items[idx]); } catch { /* fail-soft per symbol */ } } };
  await Promise.all(Array.from({ length: concurrency }, run));
}

/**
 * Screen the source pool into a pruned candidate universe (universes/dynamic/members).
 * Lossless: only SEPA necessary preconditions gate, plus a top-momentum cut. Non-disruptive —
 * writes only the `dynamic` universe; the live default path is untouched.
 */
export async function doScreenUniverse(req: any, res: any): Promise<void> {
  const db = getDb();
  const source = (req.body?.source as string) || SCREEN_CONFIG.SOURCE_UNIVERSE;
  const target = (req.body?.target as string) || 'dynamic';
  const dateId = req.body?.date ? String(req.body.date).replace(/-/g, '') : istTodayDateId();

  const memSnap = await db.collection('universes').doc(source).collection('members').get();
  const members = memSnap.docs.map((d) => ({ symbol: d.id, sector: (d.data() as any)?.sector || 'UNKNOWN' }));
  if (members.length === 0) {
    res.status(400).send({ error: `Source universe '${source}' has no members` });
    return;
  }

  const gateFails: Record<string, number> = { history: 0, price: 0, liquidity: 0, below_200dma: 0, far_from_high: 0 };
  const survivors: { symbol: string; sector: string; ret126: number }[] = [];
  let screened = 0;

  await pool(members, async ({ symbol, sector }) => {
    const bars = await getWindowOnOrBefore(db, symbol, dateId, SCREEN_CONFIG.WINDOW);
    screened++;
    const s = evaluateScreenStats(bars);
    if (!s.eligibleBase) { if (s.failedGate) gateFails[s.failedGate] = (gateFails[s.failedGate] || 0) + 1; return; }
    survivors.push({ symbol, sector, ret126: s.ret126 ?? -Infinity });
  }, 20);

  // Top-momentum cut: keep the strongest MOMENTUM_TOP_PCT by 126-day return (RS leadership).
  survivors.sort((a, b) => b.ret126 - a.ret126);
  const keep = Math.max(1, Math.ceil(survivors.length * SCREEN_CONFIG.MOMENTUM_TOP_PCT));
  const candidates = survivors.slice(0, keep);

  // Rewrite the target universe members (clear then write).
  const targetRef = db.collection('universes').doc(target).collection('members');
  const existing = await targetRef.get();
  for (let i = 0; i < existing.docs.length; i += 400) {
    const batch = db.batch();
    existing.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  for (let i = 0; i < candidates.length; i += 400) {
    const batch = db.batch();
    candidates.slice(i, i + 400).forEach((c) => batch.set(targetRef.doc(c.symbol), { symbol: c.symbol, sector: c.sector, liquidityBucket: 'A', screenedAt: admin.firestore.Timestamp.now() }));
    await batch.commit();
  }

  await logger.info(`[Screen] ${source}→${target}: ${screened} screened, ${survivors.length} eligible, ${candidates.length} candidates`, 'Screen', { source, target, dateId });
  res.status(200).send({
    source, target, dateId, screened,
    eligibleBase: survivors.length,
    candidates: candidates.length,
    gateFails,
    topCandidates: candidates.slice(0, 15).map((c) => c.symbol),
  });
}
