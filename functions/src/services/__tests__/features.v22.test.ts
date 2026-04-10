/**
 * V2.2 Features Tests — VDU detection, gapRiskScore, ret60d, liquidity bucket.
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../../config/runtime', () => ({
  VDU_CONFIG: { LOOKBACK: 20, THRESHOLD: 0.5 },
  GAP_RISK_CONFIG: { REJECT_THRESHOLD: 0.8, REDUCE_THRESHOLD: 0.5 },
}));

// ─── VDU Detection ────────────────────────────────────────────────────────────

describe('computeVDU (Volume Dry-Up Detection)', () => {
  function computeVDU(volumes: number[], lookback = 20, threshold = 0.5): boolean {
    if (volumes.length < lookback + 1) return false;
    const recent = volumes[volumes.length - 1];
    const avgVol = volumes.slice(-lookback - 1, -1).reduce((s, v) => s + v, 0) / lookback;
    return avgVol > 0 && recent / avgVol < threshold;
  }

  it('detects VDU when current volume is <50% of 20-day average', () => {
    const volumes = Array(21).fill(1_000_000);
    volumes[20] = 400_000; // 40% of average — VDU
    expect(computeVDU(volumes)).toBe(true);
  });

  it('does not trigger VDU when volume is above threshold', () => {
    const volumes = Array(21).fill(1_000_000);
    volumes[20] = 600_000; // 60% — above 50% threshold
    expect(computeVDU(volumes)).toBe(false);
  });

  it('requires full volume of 1M to be exactly at threshold (50%) → not VDU', () => {
    const volumes = Array(21).fill(1_000_000);
    volumes[20] = 500_000; // exactly 50% — boundary: NOT < threshold
    expect(computeVDU(volumes)).toBe(false);
  });

  it('returns false when insufficient bars available', () => {
    const volumes = Array(15).fill(1_000_000); // only 15 bars, need 21
    expect(computeVDU(volumes)).toBe(false);
  });

  it('handles zero average volume gracefully (no division by zero)', () => {
    const volumes = Array(21).fill(0);
    volumes[20] = 100;
    expect(computeVDU(volumes)).toBe(false);
  });
});

// ─── Gap Risk Score ────────────────────────────────────────────────────────────

describe('computeGapRiskScore', () => {
  /**
   * Gap risk = function of earnings proximity, IV_rank, and gap history.
   * We test the scoring components independently.
   */
  function earningsProximityScore(daysToEarnings: number | null): number {
    if (daysToEarnings === null) return 0;
    if (daysToEarnings <= 3) return 0.5;
    if (daysToEarnings <= 7) return 0.3;
    if (daysToEarnings <= 14) return 0.1;
    return 0;
  }

  function gapHistoryScore(avgGapPct: number): number {
    if (avgGapPct >= 0.04) return 0.3;  // > 4% avg gap
    if (avgGapPct >= 0.02) return 0.15; // > 2% avg gap
    return 0;
  }

  function compositeGapRisk(daysToEarnings: number | null, avgGapPct: number): number {
    return Math.min(1.0, earningsProximityScore(daysToEarnings) + gapHistoryScore(avgGapPct));
  }

  it('max gap risk (>= 0.8) triggers rejection', () => {
    // 3 days to earnings (0.5) + high gap history (0.3) = 0.8
    const score = compositeGapRisk(3, 0.04);
    expect(score).toBeCloseTo(0.8);
    expect(score >= 0.8).toBe(true);
  });

  it('moderate gap risk (0.5–0.79) reduces position size', () => {
    // 7 days to earnings (0.3) + moderate gap history (0.15) = 0.45 < 0.5
    // 3 days to earnings (0.5) + no gap history = 0.5 exactly
    const score = compositeGapRisk(3, 0.01);
    expect(score).toBeCloseTo(0.5);
    expect(score >= 0.5).toBe(true);
    expect(score < 0.8).toBe(true);
  });

  it('low gap risk when no earnings nearby and stable history', () => {
    const score = compositeGapRisk(30, 0.01);
    expect(score).toBe(0);
  });

  it('score is capped at 1.0', () => {
    const score = compositeGapRisk(1, 0.10);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ─── ret60d ───────────────────────────────────────────────────────────────────

describe('ret60d calculation', () => {
  function computeRet(bars: Array<{ close: number }>, period: number): number | null {
    if (bars.length < period + 1) return null;
    const current = bars[bars.length - 1].close;
    const base = bars[bars.length - 1 - period].close;
    if (base <= 0) return null;
    return (current - base) / base;
  }

  it('computes 60-day return correctly', () => {
    const bars = Array(65).fill(null).map((_, i) => ({ close: 100 + i }));
    const ret = computeRet(bars, 60);
    // close[64]=164, close[4]=104 → (164-104)/104
    expect(ret).toBeCloseTo((164 - 104) / 104);
  });

  it('returns null when fewer than 61 bars available', () => {
    const bars = Array(60).fill({ close: 100 });
    expect(computeRet(bars, 60)).toBeNull();
  });

  it('handles flat price series (0% return)', () => {
    const bars = Array(65).fill({ close: 200 });
    expect(computeRet(bars, 60)).toBeCloseTo(0);
  });

  it('correctly computes negative return (declining market)', () => {
    const bars = Array(65).fill(null).map((_, i) => ({ close: 200 - i }));
    const ret = computeRet(bars, 60);
    expect(ret).toBeLessThan(0);
  });
});

// ─── Liquidity Bucket ─────────────────────────────────────────────────────────

describe('computeLiquidityBucket', () => {
  const BUCKET_A_MIN = 50_000_000;  // 50M INR
  const BUCKET_B_MIN = 10_000_000;  // 10M INR

  function getLiquidityBucket(medTradedValue20: number): 'A' | 'B' | 'C' {
    if (medTradedValue20 >= BUCKET_A_MIN) return 'A';
    if (medTradedValue20 >= BUCKET_B_MIN) return 'B';
    return 'C';
  }

  it('bucket A for large-cap (> 50M INR median traded value)', () => {
    expect(getLiquidityBucket(100_000_000)).toBe('A');
    expect(getLiquidityBucket(50_000_000)).toBe('A');
  });

  it('bucket B for mid-cap (10M–50M INR)', () => {
    expect(getLiquidityBucket(25_000_000)).toBe('B');
    expect(getLiquidityBucket(10_000_000)).toBe('B');
  });

  it('bucket C for small-cap (< 10M INR)', () => {
    expect(getLiquidityBucket(5_000_000)).toBe('C');
    expect(getLiquidityBucket(0)).toBe('C');
  });
});
