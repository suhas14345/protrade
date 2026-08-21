import {
  worstSeverity, checkJob, checkFeatureStats, checkSignals, checkOrders,
  checkCrossStrategyDup, checkPositions, checkCapital, checkLedger, Finding,
} from '../signalCritic';

const codes = (fs: Finding[]) => fs.map((f) => f.code);

describe('signalCritic — pure checks', () => {
  describe('worstSeverity', () => {
    it('returns INFO for no findings', () => { expect(worstSeverity([])).toBe('INFO'); });
    it('escalates to the highest severity present', () => {
      expect(worstSeverity([{ code: 'a', severity: 'WARN', message: '' }, { code: 'b', severity: 'CRITICAL', message: '' }])).toBe('CRITICAL');
      expect(worstSeverity([{ code: 'a', severity: 'INFO', message: '' }, { code: 'b', severity: 'WARN', message: '' }])).toBe('WARN');
    });
  });

  describe('checkJob', () => {
    it('flags a missing job as CRITICAL', () => { expect(codes(checkJob(null))).toEqual(['JOB_MISSING']); });
    it('passes a clean DONE job', () => {
      expect(checkJob({ status: 'DONE', counts: { total: 202, done: 202, failed: 0 } })).toEqual([]);
    });
    it('flags failed symbols and non-DONE status', () => {
      const f = checkJob({ status: 'RUNNING', counts: { total: 202, done: 200, failed: 2 } });
      expect(codes(f)).toEqual(expect.arrayContaining(['JOB_NOT_DONE', 'JOB_SYMBOLS_FAILED']));
    });
  });

  describe('checkFeatureStats', () => {
    const base = { total: 200, deepBars: 200, sma200RisingTrue: 30, criticalNaN: 0, rsMissing: 0, athSeeded: 200 };
    it('passes a healthy universe', () => {
      expect(checkFeatureStats(base, true).filter((f) => f.severity !== 'INFO')).toEqual([]);
    });
    it('CRITICAL when index up but sma200Rising false universe-wide (the real bug)', () => {
      expect(codes(checkFeatureStats({ ...base, sma200RisingTrue: 0 }, true))).toContain('TREND_TEMPLATE_IMPOSSIBLE');
    });
    it('does NOT flag zero rising leaders when the index is down', () => {
      expect(codes(checkFeatureStats({ ...base, sma200RisingTrue: 0 }, false))).not.toContain('TREND_TEMPLATE_IMPOSSIBLE');
    });
    it('WARN on shallow history', () => {
      expect(codes(checkFeatureStats({ ...base, deepBars: 100 }, true))).toContain('SHALLOW_HISTORY');
    });
    it('CRITICAL on non-finite features', () => {
      expect(codes(checkFeatureStats({ ...base, criticalNaN: 3 }, true))).toContain('FEATURE_NAN');
    });
    it('CRITICAL when there are no feature docs at all', () => {
      expect(codes(checkFeatureStats({ ...base, total: 0 }, true))).toEqual(['FEATURES_MISSING']);
    });
  });

  describe('checkSignals', () => {
    it('WARN when leaders exist and index up but no equity signals', () => {
      const f = checkSignals([], { indexUp: true, sma200RisingTrue: 12 });
      expect(codes(f)).toContain('NO_EQUITY_SIGNALS');
    });
    it('flags an APPROVED signal with zero qty / bad atrRef', () => {
      const f = checkSignals([{ symbol: 'X', strategy: 'SepaBreakoutEOD', status: 'APPROVED', riskApproval: { sizedQty: 0 }, atrRef: 0 }], { indexUp: true, sma200RisingTrue: 5 });
      expect(codes(f)).toEqual(expect.arrayContaining(['SIGNAL_ZERO_QTY', 'SIGNAL_BAD_ATRREF']));
    });
    it('flags an unknown strategy', () => {
      const f = checkSignals([{ symbol: 'X', strategy: 'BogusEOD', status: 'APPROVED', riskApproval: { sizedQty: 10 }, atrRef: 5 }], { indexUp: true, sma200RisingTrue: 5 });
      expect(codes(f)).toContain('SIGNAL_BAD_STRATEGY');
    });
    it('is quiet for a healthy approved signal', () => {
      const f = checkSignals([{ symbol: 'X', strategy: 'SepaBreakoutEOD', status: 'APPROVED', riskApproval: { sizedQty: 10 }, atrRef: 5 }], { indexUp: true, sma200RisingTrue: 5 });
      expect(f).toEqual([]);
    });
  });

  describe('checkOrders / checkCrossStrategyDup', () => {
    it('flags an orphan order and a missing limit ceiling', () => {
      const f = checkOrders([{ symbol: 'X', createdFromSignalId: 'ghost', intendedQty: 10, intendedEntryRef: 'LIMIT' }], new Set());
      expect(codes(f)).toEqual(expect.arrayContaining(['ORDER_ORPHAN', 'ORDER_LIMIT_NO_CEILING']));
    });
    it('passes a valid limit order that maps to a signal', () => {
      const f = checkOrders([{ symbol: 'X', createdFromSignalId: 'sig1', intendedQty: 10, intendedEntryRef: 'LIMIT', limitHi: 100 }], new Set(['sig1']));
      expect(f).toEqual([]);
    });
    it('CRITICAL when a symbol is ordered by two strategies', () => {
      const f = checkCrossStrategyDup([{ symbol: 'BHEL.NS', strategy: 'SepaBreakoutEOD' }, { symbol: 'BHEL.NS', strategy: 'ATHPullbackEOD' }]);
      expect(codes(f)).toEqual(['DUP_SYMBOL_ORDERS']);
    });
  });

  describe('checkPositions / checkCapital', () => {
    it('flags a duplicate open position and zero qty', () => {
      const f = checkPositions([{ symbol: 'X', qty: 10, avgEntryPrice: 100 }, { symbol: 'X', qty: 0, avgEntryPrice: 100 }]);
      expect(codes(f)).toEqual(expect.arrayContaining(['DUP_OPEN_POSITION', 'POSITION_ZERO_QTY']));
    });
    it('CRITICAL when equity deployed exceeds the book', () => {
      expect(codes(checkCapital(360_000, 500_000, 0.7))).toEqual(['BOOK_OVER_DEPLOYED']);
    });
    it('passes when within the book', () => {
      expect(checkCapital(340_000, 500_000, 0.7)).toEqual([]);
    });
  });

  describe('checkLedger', () => {
    it('passes a balanced ledger to the rupee', () => {
      const f = checkLedger({ equity: 500270, deployed: 75456, unrealized: 270, realizedPnl: 0, initialEquity: 500000, cashBalance: 424544, sumTradesRealized: 0 });
      expect(f).toEqual([]);
    });
    it('CRITICAL when the equity identity breaks', () => {
      const f = checkLedger({ equity: 500540, deployed: 75456, unrealized: 270, realizedPnl: 0, initialEquity: 500000, cashBalance: 424544 });
      expect(codes(f)).toContain('EQUITY_IDENTITY_BREAK');
    });
    it('CRITICAL on negative available cash', () => {
      const f = checkLedger({ equity: 500000, deployed: 600000, unrealized: 0, realizedPnl: 0, initialEquity: 500000, cashBalance: -100000 });
      expect(codes(f)).toContain('NEGATIVE_CASH');
    });
    it('WARN when account.realizedPnl disagrees with Σ trades', () => {
      const f = checkLedger({ equity: 500000, deployed: 0, unrealized: 0, realizedPnl: 100, initialEquity: 500000, cashBalance: 500100, sumTradesRealized: 250 });
      expect(codes(f)).toContain('REALIZED_MISMATCH');
    });
  });
});
