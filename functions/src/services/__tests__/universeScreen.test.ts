import { evaluateScreenStats } from '../universeScreen';
import { SCREEN_CONFIG } from '../../config/runtime';

const cfg = SCREEN_CONFIG;

// Build 252 bars: rising series ending near its high, with given latest close + volume.
function series(n: number, start: number, step: number, vol: number) {
  return Array.from({ length: n }, (_, i) => ({ close: start + i * step, volume: vol }));
}

describe('evaluateScreenStats', () => {
  it('passes a liquid, near-high, above-200DMA leader', () => {
    const bars = series(252, 100, 1, 1_000_000); // close ~351, rising → above 200-DMA, at highs
    const s = evaluateScreenStats(bars, cfg);
    expect(s.historyOk).toBe(true);
    expect(s.priceOk).toBe(true);
    expect(s.liquidOk).toBe(true);      // 351 * 1M >> 3Cr
    expect(s.above200).toBe(true);
    expect(s.nearHigh).toBe(true);
    expect(s.eligibleBase).toBe(true);
    expect(s.ret126).toBeGreaterThan(0);
  });

  it('fails on insufficient history', () => {
    const s = evaluateScreenStats(series(150, 100, 1, 1_000_000), cfg);
    expect(s.eligibleBase).toBe(false);
    expect(s.failedGate).toBe('history');
  });

  it('fails on price floor', () => {
    const bars = series(252, 5, 0.01, 100_000_000); // ~₹7.5, below ₹50
    const s = evaluateScreenStats(bars, cfg);
    expect(s.priceOk).toBe(false);
    expect(s.failedGate).toBe('price');
  });

  it('fails on liquidity', () => {
    const bars = series(252, 100, 1, 10); // priced fine but tiny volume
    const s = evaluateScreenStats(bars, cfg);
    expect(s.priceOk).toBe(true);
    expect(s.liquidOk).toBe(false);
    expect(s.failedGate).toBe('liquidity');
  });

  it('fails when far below the 52-week high (downtrend)', () => {
    // rise then fall hard so close is well below 200-DMA and 52w high
    const up = series(200, 100, 2, 1_000_000);         // 100..498
    const down = Array.from({ length: 52 }, (_, i) => ({ close: 498 - i * 6, volume: 1_000_000 })); // crashes
    const s = evaluateScreenStats([...up, ...down], cfg);
    expect(s.eligibleBase).toBe(false);
    expect(['below_200dma', 'far_from_high']).toContain(s.failedGate);
  });
});
