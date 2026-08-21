/**
 * Replay-only in-process bar cache.
 *
 * During a backtest the price bars in `barsD` are IMMUTABLE (seeded once, never
 * written while the replay runs), yet every stage re-queries overlapping windows
 * from the Firestore emulator every single day — thousands of cross-process gRPC
 * round-trips for data that never changes. That out-of-process I/O, not the
 * indicator math, dominates the wall-clock time.
 *
 * This module memoises each symbol's full bar history in memory on first access
 * (one Firestore read per symbol for the entire run) and answers subsequent
 * lookups with an array slice + binary search. Because the cache is populated
 * FROM the same Firestore data the queries would return, results are identical
 * by construction — the ledger's independent cash-flow audit (which throws on any
 * drift > ₹0.01) is the guarantee.
 *
 * Caching is gated on REPLAY mode. In every other mode (live / paper-live) each
 * helper falls through to the EXACT query the call site used before, so live
 * behaviour — where bars mutate daily — is unchanged and never reads stale data.
 */
import * as admin from 'firebase-admin';
import { Bar } from '../models';
import { RUNTIME_CONFIG } from '../config/runtime';

interface CachedSymbol {
  /** Ascending document ids (YYYYMMDD — lexicographically == chronologically sortable). */
  ids: string[];
  /** Bars aligned 1:1 with `ids`, each with `dateId` populated from its doc id. */
  bars: Bar[];
}

const cache = new Map<string, CachedSymbol>();

function isReplay(): boolean {
  // BT_NO_BARCACHE forces the direct-Firestore path even in REPLAY — a correctness
  // escape hatch and the control arm for A/B verification of the cache.
  if (process.env.BT_NO_BARCACHE === '1') return false;
  return RUNTIME_CONFIG.MODE === 'REPLAY';
}

/** Drop all cached bars. Called at the start of a replay so reseeded data is never reused. */
export function clearBarCache(): void {
  cache.clear();
}

/** Lazily load a symbol's entire (immutable, during replay) bar history into memory. */
async function loadSymbol(db: FirebaseFirestore.Firestore, symbol: string): Promise<CachedSymbol> {
  const hit = cache.get(symbol);
  if (hit) return hit;
  const snap = await db.collection('barsD').doc(symbol).collection('days')
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .get();
  const ids: string[] = [];
  const bars: Bar[] = [];
  for (const d of snap.docs) {
    const b = d.data() as Bar;
    b.dateId = d.id;
    ids.push(d.id);
    bars.push(b);
  }
  const entry: CachedSymbol = { ids, bars };
  cache.set(symbol, entry);
  return entry;
}

/** Rightmost index whose id is <= dateId, or -1 if none. Binary search over sorted YYYYMMDD ids. */
function upperIndex(ids: string[], dateId: string): number {
  let lo = 0, hi = ids.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid] <= dateId) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

/**
 * Lower-bound YYYYMMDD key for a bounded ascending key-range scan guaranteed to
 * contain at least `count` trading days (~69% of calendar days → 1.7x + 15 margin).
 * Mirrors the bound the call sites used, so the live fall-through stays O(count).
 */
function keyLowerBoundDateId(dateId: string, count: number): string {
  const y = +dateId.slice(0, 4), m = +dateId.slice(4, 6) - 1, d = +dateId.slice(6, 8);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() - Math.ceil(count * 1.7) - 15);
  return `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The single bar on exactly `dateId`, or null. Replaces `.doc(dateId).get()`.
 */
export async function getBarOn(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string
): Promise<Bar | null> {
  if (!isReplay()) {
    const s = await db.collection('barsD').doc(symbol).collection('days').doc(dateId).get();
    if (!s.exists) return null;
    const b = s.data() as Bar;
    b.dateId = dateId;
    return b;
  }
  const c = await loadSymbol(db, symbol);
  const idx = upperIndex(c.ids, dateId);
  return idx >= 0 && c.ids[idx] === dateId ? c.bars[idx] : null;
}

/**
 * The last `limit` bars with id <= `dateId`, ascending. Replaces the bounded
 * lower-bound scan + `slice(-limit)` used by the feature and signal stages.
 */
export async function getWindowOnOrBefore(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string,
  limit: number
): Promise<Bar[]> {
  if (!isReplay()) {
    const snap = await db.collection('barsD').doc(symbol).collection('days')
      .where(admin.firestore.FieldPath.documentId(), '>=', keyLowerBoundDateId(dateId, limit))
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .get();
    return snap.docs.map((d) => { const b = d.data() as Bar; b.dateId = d.id; return b; }).slice(-limit);
  }
  const c = await loadSymbol(db, symbol);
  const idx = upperIndex(c.ids, dateId);
  if (idx < 0) return [];
  const start = Math.max(0, idx + 1 - limit);
  return c.bars.slice(start, idx + 1);
}

/**
 * The maximum daily HIGH across ALL stored bars with id <= dateId. Seeds a TRUE
 * all-time high: the ~260-bar feature window can't see older peaks, so the running
 * max alone would only ever be a rolling ~1-year high.
 */
export async function maxHighOnOrBefore(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string
): Promise<number> {
  if (!isReplay()) {
    const snap = await db.collection('barsD').doc(symbol).collection('days')
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .select('high')
      .get();
    let mx = 0;
    for (const d of snap.docs) { const h = Number((d.data() as any).high); if (Number.isFinite(h) && h > mx) mx = h; }
    return mx;
  }
  const c = await loadSymbol(db, symbol);
  const idx = upperIndex(c.ids, dateId);
  let mx = 0;
  for (let i = 0; i <= idx; i++) { const h = Number(c.bars[i].high); if (Number.isFinite(h) && h > mx) mx = h; }
  return mx;
}

/**
 * The most recent bar with id <= `dateId`, or null. Replaces the full
 * `<= dateId` ascending scan whose last row the regime and equity stages take.
 */
export async function getLatestOnOrBefore(
  db: FirebaseFirestore.Firestore,
  symbol: string,
  dateId: string
): Promise<Bar | null> {
  if (!isReplay()) {
    const snap = await db.collection('barsD').doc(symbol).collection('days')
      .where(admin.firestore.FieldPath.documentId(), '<=', dateId)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .get();
    if (snap.empty) return null;
    const d = snap.docs[snap.docs.length - 1];
    const b = d.data() as Bar;
    b.dateId = d.id;
    return b;
  }
  const c = await loadSymbol(db, symbol);
  const idx = upperIndex(c.ids, dateId);
  if (idx < 0) return null;
  return c.bars[idx];
}
