import { computeEarningsQuality, nullFundamentalsSource } from '../earningsQuality';
import { FinancialStatement } from '../../models';

const base = (over: Partial<FinancialStatement> = {}): FinancialStatement => ({
  symbol: 'TEST.NS',
  period: '2026Q1',
  filedAt: '2026-07-15',
  ...over,
});

describe('computeEarningsQuality', () => {
  it('returns UNKNOWN when no evaluable fields are present', () => {
    const res = computeEarningsQuality(base());
    expect(res.status).toBe('UNKNOWN');
    expect(res.evaluated).toBe(false);
    expect(res.flags).toEqual([]);
  });

  it('returns CLEAN for a healthy, core-driven statement', () => {
    const res = computeEarningsQuality(base({
      revenueFromOps: 1000,
      otherIncome: 20,
      totalRevenue: 1020,
      exceptionalItems: 0,
      pbt: 200,
      tax: 50,
      netProfit: 150,
    }));
    expect(res.status).toBe('CLEAN');
    expect(res.evaluated).toBe(true);
    expect(res.flags).toEqual([]);
  });

  it('flags WATCH when other income dominates PBT', () => {
    const res = computeEarningsQuality(base({
      revenueFromOps: 1000,
      otherIncome: 120,
      totalRevenue: 1120,
      pbt: 200,
      tax: 50,
    }));
    expect(res.status).toBe('WATCH');
    expect(res.flags.map((f) => f.code)).toContain('OTHER_INCOME_DEPENDENCE');
  });

  it('flags WATCH for large exceptional items (either sign)', () => {
    const gain = computeEarningsQuality(base({ exceptionalItems: 80, pbt: 200 }));
    const loss = computeEarningsQuality(base({ exceptionalItems: -80, pbt: 200 }));
    expect(gain.flags.map((f) => f.code)).toContain('EXCEPTIONAL_ITEMS');
    expect(loss.flags.map((f) => f.code)).toContain('EXCEPTIONAL_ITEMS');
  });

  it('flags WATCH when operating revenue is a low share of total', () => {
    const res = computeEarningsQuality(base({
      revenueFromOps: 600,
      totalRevenue: 1000,
      pbt: 100,
    }));
    expect(res.flags.map((f) => f.code)).toContain('LOW_REVENUE_FROM_OPS');
  });

  it('flags WATCH for an abnormally low effective tax rate', () => {
    const res = computeEarningsQuality(base({ pbt: 200, tax: 10 }));
    expect(res.flags.map((f) => f.code)).toContain('LOW_EFFECTIVE_TAX');
  });

  it('flags a margin spike only when revenue did not grow', () => {
    const spikeNoGrowth = computeEarningsQuality(base({
      revenueFromOps: 1010,
      prevRevenueFromOps: 1000,
      netProfit: 300,           // 29.7% margin
      prevNetMargin: 0.15,
    }));
    expect(spikeNoGrowth.flags.map((f) => f.code)).toContain('MARGIN_SPIKE');

    const spikeWithGrowth = computeEarningsQuality(base({
      revenueFromOps: 2000,
      prevRevenueFromOps: 1000, // revenue doubled — margin gain is demand-driven
      netProfit: 600,
      prevNetMargin: 0.15,
    }));
    expect(spikeWithGrowth.flags.map((f) => f.code)).not.toContain('MARGIN_SPIKE');
  });

  it('flags FLAGGED (CRITICAL) for high promoter pledge', () => {
    const res = computeEarningsQuality(base({ promoterPledge: 0.40, pbt: 100, tax: 25 }));
    expect(res.status).toBe('FLAGGED');
    expect(res.flags.map((f) => f.code)).toContain('PROMOTER_PLEDGE_HIGH');
  });

  it('flags FLAGGED (CRITICAL) for a promoter pledge increase', () => {
    const res = computeEarningsQuality(base({ promoterPledge: 0.12, prevPromoterPledge: 0.04 }));
    expect(res.status).toBe('FLAGGED');
    expect(res.flags.map((f) => f.code)).toContain('PROMOTER_PLEDGE_INCREASE');
  });

  it('skips revenue-mix / other-income / tax flags for financials but keeps governance', () => {
    const res = computeEarningsQuality(base({
      isFinancial: true,
      revenueFromOps: 500,
      otherIncome: 400,   // normal for a bank — must NOT flag
      totalRevenue: 900,
      pbt: 300,
      tax: 10,            // low tax — must NOT flag for financials
      promoterPledge: 0.30,
    }));
    const codes = res.flags.map((f) => f.code);
    expect(codes).not.toContain('OTHER_INCOME_DEPENDENCE');
    expect(codes).not.toContain('LOW_REVENUE_FROM_OPS');
    expect(codes).not.toContain('LOW_EFFECTIVE_TAX');
    expect(codes).toContain('PROMOTER_PLEDGE_HIGH');
    expect(res.status).toBe('FLAGGED');
  });

  it('CRITICAL takes precedence over WARN in the aggregate status', () => {
    const res = computeEarningsQuality(base({
      otherIncome: 200,
      pbt: 200,           // other-income WARN
      promoterPledge: 0.50, // pledge CRITICAL
    }));
    expect(res.status).toBe('FLAGGED');
    expect(res.flags.some((f) => f.severity === 'WARN')).toBe(true);
    expect(res.flags.some((f) => f.severity === 'CRITICAL')).toBe(true);
  });
});

describe('nullFundamentalsSource', () => {
  it('is a fail-soft placeholder that yields no statement', async () => {
    expect(nullFundamentalsSource.name).toBe('none');
    await expect(nullFundamentalsSource.fetchLatestStatement('TEST.NS')).resolves.toBeNull();
  });
});
