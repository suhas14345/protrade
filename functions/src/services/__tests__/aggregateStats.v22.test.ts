/**
 * V2.2 AggregateStats Tests — Sharpe, Sortino, Calmar, MaxDrawdown.
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

// ─── Pure math helpers (mirrored from aggregateStats.ts) ──────────────────────

const TRADING_DAYS_PER_YEAR = 252;

function computeSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function computeSortino(dailyReturns: number[], riskFreeRate = 0): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const excess = mean - riskFreeRate / TRADING_DAYS_PER_YEAR;
  const downside = dailyReturns.filter(r => r < riskFreeRate / TRADING_DAYS_PER_YEAR);
  if (downside.length === 0) return excess > 0 ? Infinity : 0;
  const downsideVar = downside.reduce((s, r) => s + (r - riskFreeRate / TRADING_DAYS_PER_YEAR) ** 2, 0) / downside.length;
  const downsideStd = Math.sqrt(downsideVar);
  if (downsideStd === 0) return 0;
  return (excess / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function computeMaxDrawdown(equityCurve: number[]): number {
  if (equityCurve.length < 2) return 0;
  let peak = equityCurve[0];
  let maxDD = 0;
  for (const equity of equityCurve) {
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeCalmar(annualReturn: number, maxDrawdown: number): number {
  if (maxDrawdown === 0) return annualReturn > 0 ? Infinity : 0;
  return annualReturn / maxDrawdown;
}

// ─── Sharpe ───────────────────────────────────────────────────────────────────

describe('computeSharpe', () => {
  it('returns 0 for single return (insufficient data)', () => {
    expect(computeSharpe([0.01])).toBe(0);
  });

  it('returns 0 for zero-variance returns (all same)', () => {
    expect(computeSharpe([0.01, 0.01, 0.01])).toBe(0);
  });

  it('returns positive Sharpe for consistently positive returns', () => {
    const returns = Array(252).fill(0.001); // 0.1% daily
    returns[10] = 0.002; // slight variance
    const sharpe = computeSharpe(returns);
    expect(sharpe).toBeGreaterThan(0);
  });

  it('returns negative Sharpe for consistently negative returns', () => {
    const returns = Array(252).fill(-0.001);
    returns[10] = -0.002;
    const sharpe = computeSharpe(returns);
    expect(sharpe).toBeLessThan(0);
  });

  it('annualizes correctly (sqrt 252 factor)', () => {
    // returns = [0.0, 0.02]: mean=0.01, variance=0.0002 (sample), std=0.01414
    // raw Sharpe = 0.01/0.01414 ≈ 0.7071
    // annualized  = 0.7071 * sqrt(252) ≈ 11.22
    const dailyReturns = [0.0, 0.02];
    const sharpe = computeSharpe(dailyReturns);
    const rawSharpe = 0.01 / Math.sqrt(0.0002);
    expect(sharpe).toBeCloseTo(rawSharpe * Math.sqrt(252), 1);
  });
});

// ─── Sortino ──────────────────────────────────────────────────────────────────

describe('computeSortino', () => {
  it('returns 0 for insufficient data', () => {
    expect(computeSortino([0.01])).toBe(0);
  });

  it('returns Infinity when no downside returns exist', () => {
    const returns = [0.01, 0.02, 0.03]; // all positive
    expect(computeSortino(returns)).toBe(Infinity);
  });

  it('penalises downside more than upside variance — Sortino >= Sharpe for positive mean', () => {
    // Asymmetric: 3 positive days, 1 negative day → positive mean
    const returns = [0.03, 0.02, 0.02, -0.01];
    const sharpe = computeSharpe(returns);
    const sortino = computeSortino(returns);
    // Both should be positive; Sortino uses only downside std which is smaller → higher ratio
    expect(sharpe).toBeGreaterThan(0);
    expect(sortino).toBeGreaterThan(0);
    expect(sortino).toBeGreaterThan(sharpe);
  });
});

// ─── Max Drawdown ─────────────────────────────────────────────────────────────

describe('computeMaxDrawdown', () => {
  it('returns 0 for single equity point', () => {
    expect(computeMaxDrawdown([100000])).toBe(0);
  });

  it('returns 0 for constantly rising equity', () => {
    const equity = [100000, 101000, 102000, 103000];
    expect(computeMaxDrawdown(equity)).toBe(0);
  });

  it('computes correct max drawdown for simple decline', () => {
    // 100k → 80k = 20% drawdown
    const equity = [100000, 105000, 80000, 90000];
    const dd = computeMaxDrawdown(equity);
    expect(dd).toBeCloseTo(0.2381, 2); // (105000-80000)/105000
  });

  it('finds deepest drawdown across multiple peaks', () => {
    const equity = [100, 120, 90, 110, 70, 130];
    const dd = computeMaxDrawdown(equity);
    // Peak 120 → trough 70 = (120-70)/120 = 41.67%
    expect(dd).toBeCloseTo(0.4167, 2);
  });

  it('handles flat equity (no drawdown)', () => {
    const equity = Array(50).fill(100000);
    expect(computeMaxDrawdown(equity)).toBe(0);
  });
});

// ─── Calmar ───────────────────────────────────────────────────────────────────

describe('computeCalmar', () => {
  it('returns Infinity when max drawdown is 0 and returns positive', () => {
    expect(computeCalmar(0.25, 0)).toBe(Infinity);
  });

  it('returns 0 when returns are 0 and drawdown is 0', () => {
    expect(computeCalmar(0, 0)).toBe(0);
  });

  it('computes ratio correctly: 25% return / 10% DD = 2.5', () => {
    expect(computeCalmar(0.25, 0.10)).toBeCloseTo(2.5);
  });

  it('returns negative Calmar for negative annual return', () => {
    expect(computeCalmar(-0.15, 0.20)).toBeLessThan(0);
  });
});

// ─── Equity Curve tracking ────────────────────────────────────────────────────

describe('Equity curve peak tracking', () => {
  function updatePeak(currentEquity: number, peakEquity: number | undefined): number {
    if (!peakEquity || peakEquity <= 0) return currentEquity;
    return Math.max(peakEquity, currentEquity);
  }

  it('initialises peak to current equity if no prior peak', () => {
    expect(updatePeak(100000, undefined)).toBe(100000);
  });

  it('updates peak when new equity exceeds prior peak', () => {
    expect(updatePeak(110000, 100000)).toBe(110000);
  });

  it('keeps prior peak when equity declines', () => {
    expect(updatePeak(90000, 100000)).toBe(100000);
  });
});
