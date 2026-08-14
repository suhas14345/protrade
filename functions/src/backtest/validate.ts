// Standalone validation of the pure backtest modules (no Firebase / emulator needed).
// Run: node lib/backtest/validate.js
const {
  computeMetrics,
  formatReport,
  cagr,
  maxDrawdown,
  sharpeRatio,
  dailyReturns,
} = require('./metrics');
const { generateSeries, tradingDates } = require('./syntheticData');

let failures = 0;
function check(name: string, cond: unknown, extra?: string): void {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}
function approx(a: number, b: number, tol?: number): boolean {
  return Math.abs(a - b) <= (tol == null ? 1e-6 : tol);
}

// 1. maxDrawdown: 100 -> 120 -> 90 -> 130. Peak 120, trough 90 => DD = 25%.
{
  const dd = maxDrawdown([100, 120, 90, 130]);
  check('maxDrawdown 25%', approx(dd, 0.25, 1e-9), `got ${(dd * 100).toFixed(2)}%`);
}

// 2. CAGR: double in exactly one year (252 trading days) => 100%.
{
  const c = cagr(100, 200, 252);
  check('CAGR doubling in 1yr = 100%', approx(c, 100, 1e-6), `got ${c.toFixed(4)}%`);
}

// 3. Sharpe of a flat (zero-variance) curve = 0.
{
  const s = sharpeRatio([0, 0, 0, 0]);
  check('Sharpe of zero returns = 0', s === 0, `got ${s}`);
}

// 4. dailyReturns length = n-1 and correct values.
{
  const r = dailyReturns([100, 110, 99]);
  check('dailyReturns length', r.length === 2, `got ${r.length}`);
  check('dailyReturns[0] = +10%', approx(r[0], 0.1), `got ${r[0]}`);
  check('dailyReturns[1] = -10%', approx(r[1], -0.1), `got ${r[1]}`);
}

// 5. computeMetrics end-to-end on a hand-built curve + trades.
{
  const curve = [
    { dateId: '20230102', equity: 1000000 },
    { dateId: '20230103', equity: 1010000 },
    { dateId: '20230104', equity: 995000 },
    { dateId: '20230105', equity: 1030000 },
  ];
  const trades = [
    { symbol: 'A', direction: 'BUY', entryDateId: '20230102', exitDateId: '20230104', qty: 10, entryPrice: 100, exitPrice: 110, fees: 50, pnl: 950 },
    { symbol: 'B', direction: 'BUY', entryDateId: '20230103', exitDateId: '20230105', qty: 5, entryPrice: 200, exitPrice: 180, fees: 40, pnl: -1040 },
  ];
  const m = computeMetrics(curve, trades);
  check('metrics totalTrades', m.totalTrades === 2, `got ${m.totalTrades}`);
  check('metrics winRate 50%', approx(m.winRatePct, 50), `got ${m.winRatePct}`);
  check('metrics endEquity', m.endEquity === 1030000, `got ${m.endEquity}`);
  check('metrics totalReturn 3%', approx(m.totalReturnPct, 3, 1e-9), `got ${m.totalReturnPct}`);
  check('metrics profitFactor 950/1040', approx(m.profitFactor, 950 / 1040, 1e-9), `got ${m.profitFactor}`);
  check('metrics expectancy=(950-1040)/2', approx(m.expectancyInr, (950 - 1040) / 2, 1e-9), `got ${m.expectancyInr}`);
  console.log('\n' + formatReport(m) + '\n');
}

// 6. Synthetic generator is deterministic and produces valid OHLC ordering.
{
  const dates = tradingDates('2023-01-01', '2023-02-01');
  check('tradingDates skips weekends (~22-23 days in Jan)', dates.length >= 22 && dates.length <= 24, `got ${dates.length}`);
  const s1 = generateSeries(12345, dates);
  const s2 = generateSeries(12345, dates);
  check('synthetic determinism (same seed => same close)', s1[10].close === s2[10].close, `${s1[10].close} vs ${s2[10].close}`);
  const s3 = generateSeries(99999, dates);
  check('synthetic seed independence (diff seed => diff path)', s1[10].close !== s3[10].close);
  const validOHLC = s1.every((b: { open: number; high: number; low: number; close: number }) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close) && b.low > 0);
  check('synthetic OHLC ordering valid (high>=max, low<=min, low>0)', validOHLC);
  const validVol = s1.every((b: { volume: number }) => b.volume > 0);
  check('synthetic volume positive', validVol);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
