/**
 * Emulator seeder for backtests.
 *
 * Writes the minimum Firestore state the real stage functions require:
 *   - calendar/{dateId}            (trading-day index + prev/next links)
 *   - universes/{id}/members/{sym} (tradable symbol set)
 *   - config/account               (equity + risk config the risk gates read)
 *   - barsD/{symbol}/days/{dateId} (daily OHLCV, incl. the ^NSEI index)
 *
 * In synthetic mode it fabricates deterministic OHLCV so the engine can be
 * validated without any broker data. A `bars` map can also be supplied to seed
 * real (e.g. Kite) history instead.
 */
import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { CalendarService } from '../services/calendar';
import { generateSeries, tradingDates, SyntheticBar } from './syntheticData';

export const INDEX_SYMBOL = '^NSEI';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/** Deterministic 32-bit hash so each symbol's synthetic series is stable. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Commit an array of write closures in chunks that respect the 500-op batch limit. */
async function chunkedWrite(
  db: FirebaseFirestore.Firestore,
  ops: ((batch: FirebaseFirestore.WriteBatch) => void)[],
  chunkSize = 400
): Promise<void> {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + chunkSize)) op(batch);
    await batch.commit();
  }
}

async function writeSeries(db: FirebaseFirestore.Firestore, symbol: string, bars: SyntheticBar[]): Promise<void> {
  const ops = bars.map((b) => (batch: FirebaseFirestore.WriteBatch) => {
    const ref = db.collection('barsD').doc(symbol).collection('days').doc(b.dateId);
    batch.set(ref, {
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      dateId: b.dateId,
      timestamp: Timestamp.fromDate(new Date(b.isoDate + 'T00:00:00Z')),
    });
  });
  await chunkedWrite(db, ops);
}

export interface SeedOptions {
  universeId: string;
  symbols: string[];
  startISO: string; // inclusive — includes warm-up history
  endISO: string; // inclusive
  initialEquity?: number;
  /** Optional real OHLCV keyed by symbol (and INDEX_SYMBOL). If omitted, synthetic data is generated. */
  bars?: Record<string, SyntheticBar[]>;
}

/**
 * Seed everything needed for a replay. Returns the ordered list of trading dates.
 */
export async function seedBacktest(opts: SeedOptions): Promise<{ dateId: string; isoDate: string }[]> {
  const db = getDb();

  // Real mode = caller supplied actual bars. Trading days then come from the
  // index series itself (real NSE holidays are absent), matching production's
  // calendar source-of-truth. Synthetic mode uses every weekday in range.
  const realMode = !!(opts.bars && opts.bars[INDEX_SYMBOL]);
  const dates = realMode
    ? opts.bars![INDEX_SYMBOL].map((b) => ({ dateId: b.dateId, isoDate: b.isoDate }))
    : tradingDates(opts.startISO, opts.endISO);

  // 2. Universe members (doc id === symbol; index is intentionally excluded).
  const memberOps = opts.symbols.map((sym) => (batch: FirebaseFirestore.WriteBatch) => {
    batch.set(db.collection('universes').doc(opts.universeId).collection('members').doc(sym), {
      symbol: sym,
      addedAt: Timestamp.now(),
    });
  });
  await chunkedWrite(db, memberOps);

  // 3. Account config (shape mirrors maintenance.seedConfig).
  await db.collection('config').doc('account').set(
    {
      equity: opts.initialEquity ?? 1_000_000,
      baseRiskPct: 0.005,
      maxOpenRiskR: 6,
      maxPositions: 10,
      strategyRiskWeights: {
        PullbackEOD: 1.0,
        BreakoutCloseEOD: 1.2,
        MeanReversionEOD: 0.8,
        ShortBounceEOD: 0.8,
        BearBounceEOD: 0.8,
        RSLeaderEOD: 1.0,
      },
      peakEquity: opts.initialEquity ?? 1_000_000,
    },
    { merge: true }
  );

  // 4. Bars for the index, then every tradable symbol.
  const indexBars = opts.bars?.[INDEX_SYMBOL] ?? generateSeries(hashSeed(INDEX_SYMBOL), dates, { annualDrift: 0.10, annualVol: 0.15 });
  await writeSeries(db, INDEX_SYMBOL, indexBars);

  for (const sym of opts.symbols) {
    const series = opts.bars?.[sym] ?? generateSeries(hashSeed(sym), dates);
    await writeSeries(db, sym, series);
  }

  // 5. Calendar. In real mode derive it from the seeded index bars (production
  // source-of-truth: real trading days + non-trading gaps). In synthetic mode
  // reuse the weekday seeder for identical prev/next semantics.
  if (realMode) {
    await CalendarService.syncFromIndexData(INDEX_SYMBOL);
  } else {
    await CalendarService.seedCalendar(opts.startISO, opts.endISO);
  }

  return dates;
}
