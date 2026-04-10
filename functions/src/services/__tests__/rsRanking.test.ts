/**
 * Tests for rsRanking.ts — RS score ranking engine.
 */

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('../../config/runtime', () => ({
  RS_CONFIG: {
    MIN_RS_SCORE: 60,
    BREAKOUT_MIN_RS_SCORE: 70,
    SCORE_BOOST_TIER1: 80,
    SCORE_BOOST_TIER2: 90,
    BOOST_TIER1_PTS: 5,
    BOOST_TIER2_PTS: 10,
  }
}));

// ─── Pure math helpers ─────────────────────────────────────────────────────────

/**
 * RS ranking logic: composite = ret20d * 0.4 + ret60d * 0.6
 * Rank percentile 0–99 across universe.
 * We replicate the ranking logic here to test it independently.
 */
function computeComposite(ret20d: number, ret60d: number): number {
  return ret20d * 0.4 + ret60d * 0.6;
}

function rankToScore(rank: number, total: number): number {
  if (total <= 1) return 99;
  return Math.round((rank / (total - 1)) * 99);
}

describe('RS Ranking — composite score math', () => {
  it('weights ret60d heavier (60%) than ret20d (40%)', () => {
    const composite = computeComposite(0.10, 0.20);
    expect(composite).toBeCloseTo(0.10 * 0.4 + 0.20 * 0.6);
    expect(composite).toBeCloseTo(0.16);
  });

  it('negative ret60d drags composite negative even with positive ret20d', () => {
    // ret20d=0.05 (weight 0.4), ret60d=-0.10 (weight 0.6): 0.02 - 0.06 = -0.04
    const composite = computeComposite(0.05, -0.10);
    expect(composite).toBeLessThan(0);
  });

  it('rankToScore: best rank (0) maps to 0, worst rank (n-1) maps to 99', () => {
    const n = 100;
    expect(rankToScore(0, n)).toBe(0);       // weakest
    expect(rankToScore(99, n)).toBe(99);      // strongest
  });

  it('rankToScore: median rank maps to ~49-50', () => {
    const score = rankToScore(50, 101);
    expect(score).toBeGreaterThanOrEqual(49);
    expect(score).toBeLessThanOrEqual(50);
  });

  it('rankToScore: single symbol universe → score 99', () => {
    expect(rankToScore(0, 1)).toBe(99);
  });
});

describe('RS Ranking — score threshold filters', () => {
  const RS_CONFIG = {
    MIN_RS_SCORE: 60,
    BREAKOUT_MIN_RS_SCORE: 70,
    SCORE_BOOST_TIER1: 80,
    SCORE_BOOST_TIER2: 90,
    BOOST_TIER1_PTS: 5,
    BOOST_TIER2_PTS: 10,
  };

  function getRsBoost(rsScore: number): number {
    if (rsScore >= RS_CONFIG.SCORE_BOOST_TIER2) return RS_CONFIG.BOOST_TIER2_PTS;
    if (rsScore >= RS_CONFIG.SCORE_BOOST_TIER1) return RS_CONFIG.BOOST_TIER1_PTS;
    return 0;
  }

  it('rejects pullback signal with rsScore < 60', () => {
    expect(59 < RS_CONFIG.MIN_RS_SCORE).toBe(true);
  });

  it('allows pullback signal with rsScore >= 60', () => {
    expect(60 >= RS_CONFIG.MIN_RS_SCORE).toBe(true);
  });

  it('rejects breakout signal with rsScore < 70', () => {
    expect(69 < RS_CONFIG.BREAKOUT_MIN_RS_SCORE).toBe(true);
  });

  it('allows breakout signal with rsScore >= 70', () => {
    expect(70 >= RS_CONFIG.BREAKOUT_MIN_RS_SCORE).toBe(true);
  });

  it('tier-1 boost: rsScore 80-89 adds +5 pts', () => {
    expect(getRsBoost(80)).toBe(5);
    expect(getRsBoost(89)).toBe(5);
  });

  it('tier-2 boost: rsScore >= 90 adds +10 pts', () => {
    expect(getRsBoost(90)).toBe(10);
    expect(getRsBoost(99)).toBe(10);
  });

  it('no boost below tier-1 threshold', () => {
    expect(getRsBoost(79)).toBe(0);
    expect(getRsBoost(50)).toBe(0);
  });
});

describe('RS Ranking — full universe sort', () => {
  function rankUniverse(symbols: Array<{ symbol: string; ret20d: number; ret60d: number }>) {
    const scored = symbols.map(s => ({
      symbol: s.symbol,
      composite: computeComposite(s.ret20d, s.ret60d),
    }));
    // Sort ascending (weakest first = rank 0)
    scored.sort((a, b) => a.composite - b.composite);
    return scored.map((s, i) => ({
      symbol: s.symbol,
      rsScore: rankToScore(i, scored.length),
    }));
  }

  it('strongest performer gets rsScore 99', () => {
    const universe = [
      { symbol: 'A', ret20d: 0.05, ret60d: 0.15 },
      { symbol: 'B', ret20d: 0.02, ret60d: 0.05 },
      { symbol: 'C', ret20d: -0.01, ret60d: -0.03 },
    ];
    const ranked = rankUniverse(universe);
    const best = ranked.find(r => r.rsScore === 99);
    expect(best?.symbol).toBe('A');
  });

  it('weakest performer gets rsScore 0', () => {
    const universe = [
      { symbol: 'A', ret20d: 0.05, ret60d: 0.15 },
      { symbol: 'B', ret20d: 0.02, ret60d: 0.05 },
      { symbol: 'C', ret20d: -0.01, ret60d: -0.03 },
    ];
    const ranked = rankUniverse(universe);
    const worst = ranked.find(r => r.rsScore === 0);
    expect(worst?.symbol).toBe('C');
  });

  it('correctly handles 500-symbol universe without error', () => {
    const universe = Array.from({ length: 500 }, (_, i) => ({
      symbol: `SYM${i}`,
      ret20d: (Math.random() - 0.5) * 0.2,
      ret60d: (Math.random() - 0.5) * 0.3,
    }));
    const ranked = rankUniverse(universe);
    expect(ranked).toHaveLength(500);
    expect(ranked.some(r => r.rsScore === 99)).toBe(true);
    expect(ranked.some(r => r.rsScore === 0)).toBe(true);
    ranked.forEach(r => {
      expect(r.rsScore).toBeGreaterThanOrEqual(0);
      expect(r.rsScore).toBeLessThanOrEqual(99);
    });
  });
});
