/**
 * Deterministic synthetic OHLCV generator for engine validation.
 *
 * This produces reproducible price series so the replay engine, P&L loop and
 * metrics can be validated end-to-end WITHOUT any broker data or credentials.
 * It is NOT a source of edge — synthetic data only proves the machinery runs
 * and the numbers reconcile. Real-edge validation uses Kite historical data.
 */

export interface SyntheticBar {
  dateId: string; // YYYYMMDD
  isoDate: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Small, fast, seedable PRNG (mulberry32) — deterministic across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller standard-normal draw from a uniform PRNG. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** All weekday dates in [startISO, endISO] as {dateId, isoDate}. Mirrors CalendarService weekend skip. */
export function tradingDates(startISO: string, endISO: string): { dateId: string; isoDate: string }[] {
  const out: { dateId: string; isoDate: string }[] = [];
  const cur = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const iso = cur.toISOString().slice(0, 10);
      out.push({ isoDate: iso, dateId: iso.replace(/-/g, '') });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * Generate a synthetic OHLCV series for one symbol across the given dates.
 * `seed` makes each symbol's path reproducible and independent.
 */
export function generateSeries(
  seed: number,
  dates: { dateId: string; isoDate: string }[],
  opts?: { startPrice?: number; annualDrift?: number; annualVol?: number; baseVolume?: number }
): SyntheticBar[] {
  const rand = mulberry32(seed);
  const startPrice = opts?.startPrice ?? 100 + rand() * 1900;
  const mu = opts?.annualDrift ?? -0.05 + rand() * 0.35; // -5%..+30% drift
  const sigma = opts?.annualVol ?? 0.18 + rand() * 0.30; // 18%..48% vol
  const baseVol = opts?.baseVolume ?? 200_000 + rand() * 5_000_000;

  const dtDrift = mu / 252;
  const dtVol = sigma / Math.sqrt(252);

  const bars: SyntheticBar[] = [];
  let prevClose = startPrice;
  for (const d of dates) {
    const ret = dtDrift + dtVol * gaussian(rand);
    const close = Math.max(1, prevClose * Math.exp(ret));
    const open = prevClose * (1 + (rand() - 0.5) * 0.01); // small overnight gap
    const intradayRange = Math.abs(close - open) + prevClose * dtVol * (0.5 + rand());
    const high = Math.max(open, close) + intradayRange * rand() * 0.5;
    const low = Math.min(open, close) - intradayRange * rand() * 0.5;
    const volume = Math.round(baseVol * (0.5 + rand()));
    bars.push({
      dateId: d.dateId,
      isoDate: d.isoDate,
      open: round2(open),
      high: round2(Math.max(high, open, close)),
      low: round2(Math.max(0.5, Math.min(low, open, close))),
      close: round2(close),
      volume,
    });
    prevClose = close;
  }
  return bars;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
