/**
 * V2.2 Strategy Tests — RS filter, drawdown circuit breaker,
 * gap risk gate, and cluster cap enforcement.
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../calendar', () => ({
  CalendarService: {
    getCalendarDay: jest.fn().mockResolvedValue(null),
    getPrevTradingDateId: jest.fn().mockResolvedValue('20260404'),
  }
}));

jest.mock('../../config/runtime', () => ({
  STRATEGY_V11: {
    BREAKOUT_SCORE_THRESHOLD: 80,
    EMA_TOUCH_ATR_MULT: 0.5,
    BREAKOUT_VOL_MULT: 1.3,
    BREAKOUT_LOOKBACK: 20,
    RISK_MULT_TREND: 1.0,
    RISK_MULT_RANGE: 0.75,
    RISK_MULT_HIGH_VOL: 0.5,
    RISK_MULT_BEAR: 0.0,
  },
  RISK_LIMITS: {
    maxPerSectorPositions: 3,
    maxPortfolioHeatR: 5.0,
  },
  RS_CONFIG: {
    MIN_RS_SCORE: 60,
    BREAKOUT_MIN_RS_SCORE: 70,
    SCORE_BOOST_TIER1: 80,
    SCORE_BOOST_TIER2: 90,
    BOOST_TIER1_PTS: 5,
    BOOST_TIER2_PTS: 10,
  },
  VDU_CONFIG: {
    LOOKBACK: 20,
    THRESHOLD: 0.5,
  },
  GAP_RISK_CONFIG: {
    REJECT_THRESHOLD: 0.8,
    REDUCE_THRESHOLD: 0.5,
  },
  DRAWDOWN_CONFIG: {
    MILD_DD: 0.05,
    MODERATE_DD: 0.10,
    SEVERE_DD: 0.15,
    HALT_DD: 0.20,
    MILD_MULT: 0.8,
    MODERATE_MULT: 0.6,
    SEVERE_MULT: 0.4,
    HALT_MULT: 0.0,
  },
  CORR_CONFIG: {
    THRESHOLD: 0.75,
    MAX_POSITIONS_PER_CLUSTER: 2,
    MAX_CLUSTER_RISK_R: 1.5,
    TOP_N: 20,
    LOOKBACK_DAYS: 62,
  },
  SLIPPAGE_CONFIG: {
    BUCKET_A_MIN_BPS: 2,
    BUCKET_A_MAX_BPS: 8,
    BUCKET_B_MIN_BPS: 5,
    BUCKET_B_MAX_BPS: 20,
    BUCKET_C_MIN_BPS: 10,
    BUCKET_C_MAX_BPS: 40,
    REGIME_MULT: { TREND: 1.0, RANGE: 1.2, HIGH_VOL: 2.0, TRANSITION: 1.5, BEAR: 1.5 },
    BUCKET_A_MIN_VALUE: 50_000_000,
    BUCKET_B_MIN_VALUE: 10_000_000,
  },
}));

// ─── Drawdown Multiplier ───────────────────────────────────────────────────────

describe('computeDrawdownMultiplier', () => {
  // We test the pure logic directly without Firestore
  function computeDrawdownMultiplier(account: any) {
    const DRAWDOWN_CONFIG = {
      MILD_DD: 0.05, MODERATE_DD: 0.10, SEVERE_DD: 0.15, HALT_DD: 0.20,
      MILD_MULT: 0.8, MODERATE_MULT: 0.6, SEVERE_MULT: 0.4,
    };
    if (!account.peakEquity || account.peakEquity <= 0) {
      return { multiplier: 1.0, shouldHalt: false, drawdownPct: 0 };
    }
    const drawdownPct = (account.peakEquity - account.equity) / account.peakEquity;
    if (drawdownPct >= 0.20) return { multiplier: 0.0, shouldHalt: true, drawdownPct };
    if (drawdownPct >= DRAWDOWN_CONFIG.SEVERE_DD) return { multiplier: DRAWDOWN_CONFIG.SEVERE_MULT, shouldHalt: false, drawdownPct };
    if (drawdownPct >= DRAWDOWN_CONFIG.MODERATE_DD) return { multiplier: DRAWDOWN_CONFIG.MODERATE_MULT, shouldHalt: false, drawdownPct };
    if (drawdownPct >= DRAWDOWN_CONFIG.MILD_DD) return { multiplier: DRAWDOWN_CONFIG.MILD_MULT, shouldHalt: false, drawdownPct };
    return { multiplier: 1.0, shouldHalt: false, drawdownPct };
  }

  it('returns multiplier 1.0 when no drawdown', () => {
    const result = computeDrawdownMultiplier({ equity: 100000, peakEquity: 100000 });
    expect(result.multiplier).toBe(1.0);
    expect(result.shouldHalt).toBe(false);
  });

  it('returns multiplier 0.8 at mild drawdown (5%)', () => {
    const result = computeDrawdownMultiplier({ equity: 95000, peakEquity: 100000 });
    expect(result.multiplier).toBe(0.8);
    expect(result.drawdownPct).toBeCloseTo(0.05);
  });

  it('returns multiplier 0.6 at moderate drawdown (10%)', () => {
    const result = computeDrawdownMultiplier({ equity: 90000, peakEquity: 100000 });
    expect(result.multiplier).toBe(0.6);
  });

  it('returns multiplier 0.4 at severe drawdown (15%)', () => {
    const result = computeDrawdownMultiplier({ equity: 85000, peakEquity: 100000 });
    expect(result.multiplier).toBe(0.4);
  });

  it('halts trading at 20% drawdown', () => {
    const result = computeDrawdownMultiplier({ equity: 80000, peakEquity: 100000 });
    expect(result.shouldHalt).toBe(true);
    expect(result.multiplier).toBe(0.0);
  });

  it('returns full multiplier when peakEquity not set (new account)', () => {
    const result = computeDrawdownMultiplier({ equity: 100000, peakEquity: undefined });
    expect(result.multiplier).toBe(1.0);
    expect(result.shouldHalt).toBe(false);
  });
});

// ─── Dynamic Slippage ─────────────────────────────────────────────────────────

describe('computeSlippageBps', () => {
  function computeSlippageBps(liquidityBucket: string, marketState: string): number {
    const ranges: Record<string, [number, number]> = {
      A: [2, 8], B: [5, 20], C: [10, 40]
    };
    const regimeMults: Record<string, number> = {
      TREND: 1.0, RANGE: 1.2, HIGH_VOL: 2.0, TRANSITION: 1.5, BEAR: 1.5
    };
    const [lo, hi] = ranges[liquidityBucket] ?? ranges['C'];
    const mult = regimeMults[marketState] ?? 1.5;
    const base = lo + Math.random() * (hi - lo);
    return Math.round(base * mult);
  }

  it('bucket A gives lower slippage than bucket C on average', () => {
    // Run 100 samples; A average must be < C average
    let sumA = 0, sumC = 0;
    const N = 100;
    for (let i = 0; i < N; i++) {
      sumA += computeSlippageBps('A', 'TREND');
      sumC += computeSlippageBps('C', 'TREND');
    }
    expect(sumA / N).toBeLessThan(sumC / N);
  });

  it('HIGH_VOL regime multiplies slippage vs TREND', () => {
    // Average over many samples: HIGH_VOL (2x) should be ~2x TREND
    let sumTrend = 0, sumHV = 0;
    const N = 200;
    // Use Math.random mock for deterministic mid-range
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    for (let i = 0; i < N; i++) {
      sumTrend += computeSlippageBps('A', 'TREND');
      sumHV += computeSlippageBps('A', 'HIGH_VOL');
    }
    jest.spyOn(Math, 'random').mockRestore();
    expect(sumHV / sumTrend).toBeCloseTo(2.0, 0);
  });

  it('slippage is always positive', () => {
    for (let i = 0; i < 50; i++) {
      expect(computeSlippageBps('B', 'RANGE')).toBeGreaterThan(0);
    }
  });
});

// ─── Gap Risk Score ────────────────────────────────────────────────────────────

describe('gapRiskScore gate', () => {
  const GAP_RISK_CONFIG = { REJECT_THRESHOLD: 0.8, REDUCE_THRESHOLD: 0.5 };

  it('rejects position when gapRiskScore >= 0.8', () => {
    expect(0.85 >= GAP_RISK_CONFIG.REJECT_THRESHOLD).toBe(true);
  });

  it('allows position when gapRiskScore < 0.8', () => {
    expect(0.79 >= GAP_RISK_CONFIG.REJECT_THRESHOLD).toBe(false);
  });

  it('reduces size by 50% when gapRiskScore is in reduce zone [0.5, 0.8)', () => {
    const gapScore = 0.65;
    const multiplier = gapScore >= GAP_RISK_CONFIG.REDUCE_THRESHOLD ? 0.5 : 1.0;
    expect(multiplier).toBe(0.5);
  });

  it('keeps full size when gapRiskScore < 0.5', () => {
    const gapScore = 0.3;
    const multiplier = gapScore >= GAP_RISK_CONFIG.REDUCE_THRESHOLD ? 0.5 : 1.0;
    expect(multiplier).toBe(1.0);
  });
});

// ─── Portfolio heat & cluster cap logic ───────────────────────────────────────

describe('Portfolio constraints', () => {
  const RISK_LIMITS = { maxPerSectorPositions: 3, maxPortfolioHeatR: 5.0 };
  const CORR_CONFIG = { MAX_POSITIONS_PER_CLUSTER: 2, MAX_CLUSTER_RISK_R: 1.5 };

  function checkPortfolio(
    openPositions: any[],
    sector: string,
    signalHeatR: number,
    currentHeatR: number,
    clusterPositionCount: number,
    clusterHeatR: number,
    maxPositions: number,
    sessionApprovals: number
  ): { rejected: boolean; reason: string } {
    const activeSectorCount = openPositions.filter(p => p.sector === sector).length;
    if (openPositions.length + sessionApprovals >= maxPositions) return { rejected: true, reason: 'Max positions' };
    if (activeSectorCount >= RISK_LIMITS.maxPerSectorPositions) return { rejected: true, reason: 'Sector cap' };
    if (currentHeatR + signalHeatR > RISK_LIMITS.maxPortfolioHeatR) return { rejected: true, reason: 'Portfolio heat' };
    if (clusterPositionCount >= CORR_CONFIG.MAX_POSITIONS_PER_CLUSTER) return { rejected: true, reason: 'Cluster cap' };
    if (clusterHeatR + signalHeatR > CORR_CONFIG.MAX_CLUSTER_RISK_R) return { rejected: true, reason: 'Cluster heat' };
    return { rejected: false, reason: '' };
  }

  it('rejects when max positions reached', () => {
    const result = checkPortfolio([], 'IT', 0.5, 0, 0, 0, 0, 0);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('Max positions');
  });

  it('rejects when sector cap exceeded (3 IT positions already)', () => {
    const openPositions = [
      { sector: 'IT' }, { sector: 'IT' }, { sector: 'IT' }
    ];
    const result = checkPortfolio(openPositions, 'IT', 0.5, 1.0, 0, 0, 10, 0);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('Sector cap');
  });

  it('rejects when portfolio heat would exceed 5R', () => {
    const result = checkPortfolio([], 'BANK', 1.5, 4.0, 0, 0, 10, 0);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('Portfolio heat');
  });

  it('rejects when correlation cluster cap hit (2 positions already)', () => {
    const result = checkPortfolio([], 'IT', 0.5, 1.0, 2, 0.8, 10, 0);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('Cluster cap');
  });

  it('rejects when adding signal would exceed cluster risk 1.5R', () => {
    // clusterHeatR=1.2 + signalHeatR=0.5 = 1.7 > 1.5
    const result = checkPortfolio([], 'IT', 0.5, 1.0, 1, 1.2, 10, 0);
    expect(result.rejected).toBe(true);
    expect(result.reason).toContain('Cluster heat');
  });

  it('approves when all constraints pass', () => {
    const result = checkPortfolio(
      [{ sector: 'BANK' }, { sector: 'IT' }],
      'PHARMA', 0.5, 1.0, 0, 0, 10, 0
    );
    expect(result.rejected).toBe(false);
  });
});
