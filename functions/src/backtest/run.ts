/**
 * Backtest CLI runner.
 *
 * Usage (from functions/):
 *   npm run build
 *   node lib/backtest/run.js --start 2023-01-01 --end 2024-01-01 --warmup 130 --symbols 8
 *
 * SAFETY: this script forces firebase-admin to talk to the local Firestore
 * emulator. It refuses to run against production. Start the emulator first:
 *   npm run serve            (or)   firebase emulators:start --only firestore
 */
import * as admin from 'firebase-admin';

// ---- Hard emulator guard (must happen before any Firestore access) ----------
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8081';
if (!/^(localhost|127\.0\.0\.1)/.test(EMULATOR_HOST)) {
  console.error(`Refusing to run: FIRESTORE_EMULATOR_HOST (${EMULATOR_HOST}) is not a local emulator.`);
  process.exit(1);
}
process.env.FIRESTORE_EMULATOR_HOST = EMULATOR_HOST;
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'suhas-ag';
if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
}

import { seedBacktest } from './seed';
import { runReplay } from './engine';
import { computeMetrics, formatReport } from './metrics';

interface Args {
  start: string;
  end: string;
  warmup: number;
  symbols: number;
  equity: number;
  universe: string;
  clear: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, def?: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : def;
  };
  return {
    start: get('start', '2023-01-01')!,
    end: get('end', '2024-01-01')!,
    warmup: parseInt(get('warmup', '130')!, 10),
    symbols: parseInt(get('symbols', '8')!, 10),
    equity: parseInt(get('equity', '1000000')!, 10),
    universe: get('universe', 'nifty500')!,
    clear: argv.includes('--clear'),
  };
}

/** Delete a handful of collections so repeated runs start clean. */
async function clearState(db: FirebaseFirestore.Firestore): Promise<void> {
  const roots = ['barsD', 'features', 'signals', 'paperOrders', 'paperFills', 'regime', 'jobs', 'calendar', 'stats', 'universes', 'rsRanking'];
  for (const root of roots) {
    // Recursive delete via the admin BulkWriter helper.
    await db.recursiveDelete(db.collection(root));
  }
  await db.collection('portfolio').doc('default').collection('positions').get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = admin.firestore();

  console.log(`[backtest] emulator=${EMULATOR_HOST} project=${process.env.GCLOUD_PROJECT}`);
  console.log(`[backtest] ${args.start}..${args.end}  warmup=${args.warmup}d  symbols=${args.symbols}  equity=${args.equity}`);

  if (args.clear) {
    console.log('[backtest] clearing prior state...');
    await clearState(db);
  }

  const symbols = Array.from({ length: args.symbols }, (_, i) => `SYNTH${String(i + 1).padStart(3, '0')}`);

  console.log('[backtest] seeding...');
  const dates = await seedBacktest({
    universeId: args.universe,
    symbols,
    startISO: args.start,
    endISO: args.end,
    initialEquity: args.equity,
  });
  console.log(`[backtest] seeded ${dates.length} trading days, ${symbols.length} symbols + index`);

  if (args.warmup >= dates.length) {
    throw new Error(`warmup (${args.warmup}) >= trading days (${dates.length}); widen the date range.`);
  }

  console.log('[backtest] replaying...');
  const t0 = Date.now();
  const { curve, trades } = await runReplay({
    universeId: args.universe,
    symbols,
    dates,
    tradeStartIndex: args.warmup,
    initialEquity: args.equity,
    onDay: (i, dateId, equity) => {
      if ((i - args.warmup) % 20 === 0) console.log(`  day ${dateId}: equity ₹${Math.round(equity).toLocaleString('en-IN')}`);
    },
  });
  console.log(`[backtest] replay done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const metrics = computeMetrics(curve, trades);
  console.log('\n' + formatReport(metrics));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('[backtest] FAILED:', e);
  process.exit(1);
});
