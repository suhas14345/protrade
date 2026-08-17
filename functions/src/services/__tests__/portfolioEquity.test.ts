import { computeExitPnl, markPosition } from '../portfolioEquity';

/**
 * Unit tests for the single realised-P&L formula used by the paperBroker exit
 * path. These pin the arithmetic (long/short, partial exits, entry-fee proration)
 * and independently verify the double-entry identity the backtest auditor relies
 * on: realisedPnl(closed) + unrealised(open) == net cash flow + open market value.
 */
describe('computeExitPnl', () => {
  it('long full exit: gross gain minus both fees', () => {
    const { realizedPnl, entryFeeShare } = computeExitPnl({
      direction: 'BUY',
      avgEntryPrice: 100,
      exitPrice: 110,
      exitQty: 50,
      entryQty: 50,
      entryFee: 20,
      exitFee: 25,
    });
    // (110-100)*50 - 25 - 20 = 500 - 45
    expect(entryFeeShare).toBeCloseTo(20, 10);
    expect(realizedPnl).toBeCloseTo(455, 10);
  });

  it('long full exit at a loss', () => {
    const { realizedPnl } = computeExitPnl({
      direction: 'BUY',
      avgEntryPrice: 100,
      exitPrice: 92,
      exitQty: 10,
      entryQty: 10,
      entryFee: 5,
      exitFee: 4,
    });
    // (92-100)*10 - 4 - 5 = -80 - 9
    expect(realizedPnl).toBeCloseTo(-89, 10);
  });

  it('short full exit: profit when price falls', () => {
    const { realizedPnl } = computeExitPnl({
      direction: 'SELL',
      avgEntryPrice: 200,
      exitPrice: 180,
      exitQty: 30,
      entryQty: 30,
      entryFee: 12,
      exitFee: 10,
    });
    // (200-180)*30 - 10 - 12 = 600 - 22
    expect(realizedPnl).toBeCloseTo(578, 10);
  });

  it('short full exit: loss when price rises', () => {
    const { realizedPnl } = computeExitPnl({
      direction: 'SELL',
      avgEntryPrice: 200,
      exitPrice: 210,
      exitQty: 30,
      entryQty: 30,
      entryFee: 12,
      exitFee: 10,
    });
    // (200-210)*30 - 10 - 12 = -300 - 22
    expect(realizedPnl).toBeCloseTo(-322, 10);
  });

  it('partial exit prorates the entry fee by exited quantity', () => {
    const { realizedPnl, entryFeeShare } = computeExitPnl({
      direction: 'BUY',
      avgEntryPrice: 100,
      exitPrice: 120,
      exitQty: 40, // 40 of 100 shares
      entryQty: 100,
      entryFee: 50,
      exitFee: 8,
    });
    // entryFeeShare = 50 * 40/100 = 20; pnl = (120-100)*40 - 8 - 20 = 800 - 28
    expect(entryFeeShare).toBeCloseTo(20, 10);
    expect(realizedPnl).toBeCloseTo(772, 10);
  });

  it('two partials of a long fully attribute the entry fee exactly once', () => {
    const first = computeExitPnl({
      direction: 'BUY', avgEntryPrice: 100, exitPrice: 130,
      exitQty: 60, entryQty: 100, entryFee: 50, exitFee: 6,
    });
    const second = computeExitPnl({
      direction: 'BUY', avgEntryPrice: 100, exitPrice: 140,
      exitQty: 40, entryQty: 100, entryFee: 50, exitFee: 4,
    });
    // Entry fee shares must sum to the full entry fee.
    expect(first.entryFeeShare + second.entryFeeShare).toBeCloseTo(50, 10);
    // Total realised = gross - all fees = (130-100)*60 + (140-100)*40 - 6 - 4 - 50
    expect(first.realizedPnl + second.realizedPnl).toBeCloseTo(1800 + 1600 - 60, 10);
  });

  it('guards against a zero entryQty (no divide-by-zero)', () => {
    const { realizedPnl, entryFeeShare } = computeExitPnl({
      direction: 'BUY', avgEntryPrice: 100, exitPrice: 110,
      exitQty: 10, entryQty: 0, entryFee: 20, exitFee: 5,
    });
    expect(entryFeeShare).toBe(0);
    expect(realizedPnl).toBeCloseTo(95, 10);
  });

  it('satisfies the double-entry identity: realised == net cash flow (long round trip)', () => {
    const entryPrice = 100, qty = 25, entryFee = 7, exitPrice = 118, exitFee = 9;
    const { realizedPnl } = computeExitPnl({
      direction: 'BUY', avgEntryPrice: entryPrice, exitPrice,
      exitQty: qty, entryQty: qty, entryFee, exitFee,
    });
    // Independent cash-flow reconstruction: buy = cash out, sell = cash in, minus fees.
    const cashFlow = (-entryPrice * qty - entryFee) + (exitPrice * qty - exitFee);
    expect(realizedPnl).toBeCloseTo(cashFlow, 10);
  });

  it('satisfies the double-entry identity for a short round trip', () => {
    const entryPrice = 250, qty = 12, entryFee = 6, exitPrice = 230, exitFee = 5;
    const { realizedPnl } = computeExitPnl({
      direction: 'SELL', avgEntryPrice: entryPrice, exitPrice,
      exitQty: qty, entryQty: qty, entryFee, exitFee,
    });
    // Short: entry is a SELL (cash in), exit is a BUY (cash out), minus fees.
    const cashFlow = (entryPrice * qty - entryFee) + (-exitPrice * qty - exitFee);
    expect(realizedPnl).toBeCloseTo(cashFlow, 10);
  });
});

/**
 * Per-position mark-to-market. `markPosition` is the SINGLE formula shared by the
 * account roll-up (`computeOpenUnrealized`) and the per-position write-back
 * (`persistOpenPositionMarks`). These tests pin that a position doc's
 * `unrealizedPnl` reconciles to the account to the paisa and that a later close
 * replaces the mark exactly (regression: position docs used to read 0 while the
 * account equity already reflected the mark, so the numbers disagreed).
 */
describe('markPosition', () => {
  const pos = (o: Partial<any>): any => ({ direction: 'BUY', avgEntryPrice: 100, qty: 10, ...o });

  it('long: gross gain minus the unrealised entry-fee share', () => {
    const { unrealizedPnl, unrealizedPnlPct } = markPosition(
      pos({ avgEntryPrice: 100, qty: 50, entryQty: 50, entryFee: 20 }), 110);
    // (110-100)*50 - 20 = 480 ; pct = 480 / (100*50)
    expect(unrealizedPnl).toBeCloseTo(480, 10);
    expect(unrealizedPnlPct).toBeCloseTo(480 / 5000, 12);
  });

  it('short: gain when price falls', () => {
    const { unrealizedPnl } = markPosition(
      pos({ direction: 'SELL', avgEntryPrice: 200, qty: 30, entryQty: 30, entryFee: 12 }), 180);
    // (200-180)*30 - 12 = 588
    expect(unrealizedPnl).toBeCloseTo(588, 10);
  });

  it('prorates the entry fee by remaining qty after a partial exit', () => {
    // qty decremented to 40 of an original 100; only 40/100 of the entry fee is still open.
    const { unrealizedPnl } = markPosition(
      pos({ avgEntryPrice: 100, qty: 40, entryQty: 100, entryFee: 50 }), 120);
    // (120-100)*40 - 50*(40/100) = 800 - 20
    expect(unrealizedPnl).toBeCloseTo(780, 10);
  });

  it('guards divide-by-zero on entry cost (pct = 0)', () => {
    const { unrealizedPnl, unrealizedPnlPct } = markPosition(
      pos({ avgEntryPrice: 0, qty: 0, entryQty: 0, entryFee: 0 }), 100);
    expect(unrealizedPnl).toBe(0);
    expect(unrealizedPnlPct).toBe(0);
  });

  it('equals the realised P&L of an exit at the same close with zero exit fee', () => {
    // Reconciliation guarantee: when a position closes, its realised record must
    // replace exactly the mark. markPosition(close) === computeExitPnl(exit@close, exitFee=0).
    const cases = [
      { direction: 'BUY' as const, avgEntryPrice: 125.97, qty: 599, entryFee: 29.04 },
      { direction: 'SELL' as const, avgEntryPrice: 250, qty: 12, entryFee: 6 },
      { direction: 'BUY' as const, avgEntryPrice: 100, qty: 40, entryFee: 50 },
    ];
    for (const c of cases) {
      const close = 126.47;
      const mark = markPosition(pos({ ...c, entryQty: c.qty }), close).unrealizedPnl;
      const asExit = computeExitPnl({
        direction: c.direction, avgEntryPrice: c.avgEntryPrice, exitPrice: close,
        exitQty: c.qty, entryQty: c.qty, entryFee: c.entryFee, exitFee: 0,
      }).realizedPnl;
      expect(mark).toBeCloseTo(asExit, 10);
    }
  });

  it('per-position marks sum to the account openUnrealized / equity identity', () => {
    // The account roll-up is Σ markPosition over OPEN positions; equity is then
    // initial + realizedToDate + Σ marks. Pin the arithmetic end-to-end.
    const initialEquity = 500_000;
    const realizedToDate = 0;
    const positions = [
      { p: pos({ direction: 'BUY',  avgEntryPrice: 125.97069599999999, qty: 599, entryQty: 599, entryFee: 29.04 }), close: 126.47 },
      { p: pos({ direction: 'SELL', avgEntryPrice: 300, qty: 20, entryQty: 20, entryFee: 15 }), close: 291.5 },
    ];
    const openUnrealized = positions.reduce((s, x) => s + markPosition(x.p, x.close).unrealizedPnl, 0);
    const equity = initialEquity + realizedToDate + openUnrealized;

    // Hand-computed: leg1 = 599*(126.47-125.97069599999999)-29.04 ; leg2 = 20*(300-291.5)-15
    const leg1 = 599 * (126.47 - 125.97069599999999) - 29.04;
    const leg2 = 20 * (300 - 291.5) - 15;
    expect(openUnrealized).toBeCloseTo(leg1 + leg2, 8);
    expect(equity).toBeCloseTo(initialEquity + leg1 + leg2, 8);
  });
});
