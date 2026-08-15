import * as admin from 'firebase-admin';
import { Bar } from '../models';
import { fetchHistoricalBars, getNSEInstrumentsMap } from './marketdata';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

function dateIdFromBar(bar: Bar): string {
  const date = bar.timestamp.toDate();
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(ist.getUTCDate()).padStart(2, '0')}`;
}

async function writeBars(db: FirebaseFirestore.Firestore, symbol: string, bars: Bar[]): Promise<void> {
  for (let i = 0; i < bars.length; i += 400) {
    const batch = db.batch();
    for (const bar of bars.slice(i, i + 400)) {
      batch.set(db.collection('barsD').doc(symbol).collection('days').doc(dateIdFromBar(bar)), {
        ...bar,
        dateId: dateIdFromBar(bar),
      });
    }
    await batch.commit();
  }
  await db.collection('barsD').doc(symbol).set({
    lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    type: symbol === 'NIFTY 50' ? 'INDEX' : 'EQUITY',
  }, { merge: true });
}

export interface HistoricalBackfillOptions {
  universeId: string;
  startISO: string;
  endISO: string;
  maxSymbols?: number;
  /** Skip symbols whose latest bar already covers the requested range. Default true. */
  skipExisting?: boolean;
  /** Soft wall-clock budget; stops before the Cloud Functions timeout and reports a resume cursor. */
  maxRuntimeMs?: number;
}

export interface HistoricalBackfillResult {
  fetched: number;
  failed: number;
  skipped: number;
  bars: number;
  processed: number;
  remaining: number;
  done: boolean;
  lastSymbol: string | null;
}

/** True if the symbol already has history reaching back to the requested start (earliest bar at/before start + buffer). */
async function hasCoverage(db: FirebaseFirestore.Firestore, symbol: string, startISO: string): Promise<boolean> {
  const start = new Date(startISO);
  start.setUTCDate(start.getUTCDate() + 10); // tolerate the first tradable day after a holiday/weekend gap
  const threshold = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}${String(start.getUTCDate()).padStart(2, '0')}`;
  const earliest = await db.collection('barsD').doc(symbol).collection('days')
    .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
    .limit(1)
    .get();
  return !earliest.empty && earliest.docs[0].id <= threshold;
}

export async function runHistoricalBackfill(opts: HistoricalBackfillOptions): Promise<HistoricalBackfillResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startISO) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.endISO)) {
    throw new Error('startISO and endISO must use YYYY-MM-DD');
  }
  if (opts.startISO > opts.endISO) throw new Error('startISO must be before endISO');

  const db = getDb();
  const settings = (await db.collection('settings').doc('kite').get()).data() as any;
  if (!settings?.apiKey || !settings?.accessToken || settings.status === 'ERROR') {
    throw new Error('Kite session is not active; run scheduledKiteRenew first');
  }

  const skipExisting = opts.skipExisting !== false;
  const deadline = Date.now() + (opts.maxRuntimeMs ?? 460_000); // leave margin under the 540s function cap
  const members = await db.collection('universes').doc(opts.universeId).collection('members').get();
  const symbols = members.docs.map(doc => doc.id).slice(0, opts.maxSymbols ?? 500);
  const instruments = await getNSEInstrumentsMap(settings.apiKey, settings.accessToken);
  const targets = ['NIFTY 50', ...symbols.filter(symbol => symbol !== 'NIFTY 50')];
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  let bars = 0;
  let processed = 0;
  let lastSymbol: string | null = null;

  for (const symbol of targets) {
    if (Date.now() >= deadline) {
      console.warn(`[HistoricalBackfill] Time budget reached; resume after ${lastSymbol}`);
      break;
    }
    processed++;
    lastSymbol = symbol;
    try {
      if (skipExisting && await hasCoverage(db, symbol, opts.startISO)) {
        skipped++;
        continue;
      }
      const token = symbol === 'NIFTY 50'
        ? 256265
        : instruments.get(symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol);
      if (!token) throw new Error(`Instrument not found: ${symbol}`);
      const result = await fetchHistoricalBars(symbol, opts.startISO, opts.endISO, settings.apiKey, settings.accessToken, token);
      await writeBars(db, symbol, result);
      fetched++;
      bars += result.length;
      console.log(`[HistoricalBackfill] ${symbol}: ${result.length} bars`);
    } catch (error) {
      failed++;
      console.error(`[HistoricalBackfill] ${symbol} failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  const remaining = targets.length - processed;
  return { fetched, failed, skipped, bars, processed, remaining, done: remaining === 0, lastSymbol };
}