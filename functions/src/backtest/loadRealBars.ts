/**
 * Real-data loader for the backtest engine.
 *
 * Reads daily OHLCV CSVs (yfinance format: `Date,Close,High,Low,Open,Volume`)
 * from a directory and returns them in the `SyntheticBar` shape the seeder
 * accepts. This is how Increment 2 (real-edge validation) feeds actual NSE
 * history into the exact same replay path as synthetic data — no broker login,
 * no credentials.
 *
 * The index file `^NSEI.csv` is mapped to INDEX_SYMBOL so the regime engine and
 * RS-ranking benchmark find it; stock files `SYMBOL.NS.csv` are mapped to the
 * bare NSE symbol (`SYMBOL`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { SyntheticBar } from './syntheticData';
import { INDEX_SYMBOL } from './seed';

export interface LoadRealBarsOptions {
  /** Directory containing the CSV files. */
  dataDir: string;
  /** Inclusive ISO date lower bound (e.g. '2022-01-01'). */
  startISO: string;
  /** Inclusive ISO date upper bound (e.g. '2026-08-13'). */
  endISO: string;
  /** Cap the number of stock symbols (deterministic: sorted, most-complete first). */
  maxSymbols?: number;
  /** Minimum bars a symbol must have in-range to be included. */
  minBars?: number;
  /** Symbols to always include (bypasses the maxSymbols cap), e.g. the metals sleeve ETFs. */
  alwaysInclude?: string[];
}

export interface LoadRealBarsResult {
  /** OHLCV keyed by symbol, including INDEX_SYMBOL ('^NSEI'). */
  bars: Record<string, SyntheticBar[]>;
  /** The stock symbols loaded (excludes the index). */
  symbols: string[];
}

/** Parse one yfinance CSV into in-range, ascending SyntheticBar[]. */
function parseCsv(file: string, startId: string, endId: string): SyntheticBar[] {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const iDate = header.indexOf('date');
  const iOpen = header.indexOf('open');
  const iHigh = header.indexOf('high');
  const iLow = header.indexOf('low');
  const iClose = header.indexOf('close');
  const iVol = header.indexOf('volume');
  if ([iDate, iOpen, iHigh, iLow, iClose, iClose].some((i) => i < 0)) return [];

  const out: SyntheticBar[] = [];
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r];
    if (!line) continue;
    const cols = line.split(',');
    const iso = (cols[iDate] || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const dateId = iso.replace(/-/g, '');
    if (dateId < startId || dateId > endId) continue;

    const open = Number(cols[iOpen]);
    const high = Number(cols[iHigh]);
    const low = Number(cols[iLow]);
    const close = Number(cols[iClose]);
    const volume = iVol >= 0 ? Number(cols[iVol]) : 0;
    // Skip rows with any non-finite OHLC (yfinance sometimes emits blanks).
    if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) continue;

    out.push({
      dateId,
      isoDate: iso,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  out.sort((a, b) => (a.dateId < b.dateId ? -1 : a.dateId > b.dateId ? 1 : 0));
  return out;
}

/**
 * Load the index plus up to `maxSymbols` stock series from a CSV directory.
 * Throws if the index file is missing (the regime engine requires it).
 */
export function loadRealBars(opts: LoadRealBarsOptions): LoadRealBarsResult {
  const startId = opts.startISO.replace(/-/g, '');
  const endId = opts.endISO.replace(/-/g, '');
  const minBars = opts.minBars ?? 250;

  const indexPath = path.join(opts.dataDir, '^NSEI.csv');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Index file not found: ${indexPath}. The regime/RS benchmark needs ^NSEI.`);
  }
  const indexBars = parseCsv(indexPath, startId, endId);
  if (indexBars.length < minBars) {
    throw new Error(`Index ^NSEI has only ${indexBars.length} bars in range (need >= ${minBars}).`);
  }

  const bars: Record<string, SyntheticBar[]> = { [INDEX_SYMBOL]: indexBars };

  // Discover stock CSVs (everything except the index), deterministic order.
  const files = fs
    .readdirSync(opts.dataDir)
    .filter((f) => f.toLowerCase().endsWith('.csv') && f !== '^NSEI.csv')
    .sort();

  const candidates: { symbol: string; series: SyntheticBar[] }[] = [];
  for (const f of files) {
    const series = parseCsv(path.join(opts.dataDir, f), startId, endId);
    if (series.length < minBars) continue;
    // 'AXISBANK.NS.csv' -> 'AXISBANK'; strip trailing exchange suffix + .csv.
    const symbol = f.replace(/\.csv$/i, '').replace(/\.(NS|BO)$/i, '').toUpperCase();
    candidates.push({ symbol, series });
  }

  // Prefer the most-complete series when capping, keep a stable tie-break.
  candidates.sort((a, b) => b.series.length - a.series.length || (a.symbol < b.symbol ? -1 : 1));
  const chosen = opts.maxSymbols && opts.maxSymbols > 0 ? candidates.slice(0, opts.maxSymbols) : candidates;

  const symbols: string[] = [];
  for (const c of chosen) {
    bars[c.symbol] = c.series;
    symbols.push(c.symbol);
  }

  // Force-include any always-include symbols (e.g. metals ETFs) that the cap dropped,
  // so a small dedicated sleeve is never squeezed out of the universe by the cap.
  const force = new Set((opts.alwaysInclude ?? []).map((s) => s.toUpperCase()));
  if (force.size > 0) {
    const already = new Set(symbols);
    for (const c of candidates) {
      if (force.has(c.symbol) && !already.has(c.symbol)) {
        bars[c.symbol] = c.series;
        symbols.push(c.symbol);
        already.add(c.symbol);
      }
    }
  }

  symbols.sort();
  return { bars, symbols };
}
