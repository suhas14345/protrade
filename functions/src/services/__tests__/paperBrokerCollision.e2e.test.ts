import { makeFakeAdmin } from './helpers/fakeFirestore';

// Regression test for the SEPA+ATH same-symbol same-day collision that broke the
// independent cash-flow reconciliation: two ENTRY orders for one symbol are
// processed in a single per-symbol fill batch; the committed-state guard cannot
// see the position opened earlier in the same (uncommitted) batch, so without the
// batch-local guard the second ENTRY wrote a second BUY fill and OVERWROTE the one
// symbol-keyed position doc — orphaning the first entry's cash. After the fix the
// batch establishes exactly ONE position and exactly ONE entry fill; the loser is
// cancelled with POSITION_ALREADY_OPEN.

jest.mock('firebase-admin', () => {
  const { makeFakeAdmin: make } = require('./helpers/fakeFirestore');
  const fake = make();
  (globalThis as any).__fakeCollision = fake;
  return fake.admin;
});

const barState: { bar: any; window: any[]; latest: any } = { bar: null, window: [], latest: null };
jest.mock('../barCache', () => ({
  getBarOn: (..._a: any[]) => Promise.resolve(barState.bar),
  getWindowOnOrBefore: (..._a: any[]) => Promise.resolve(barState.window),
  getLatestOnOrBefore: (..._a: any[]) => Promise.resolve(barState.latest),
  clearBarCache: () => {},
}));

const prevDate = (dateId: string) => {
  const d = new Date(Date.UTC(+dateId.slice(0, 4), +dateId.slice(4, 6) - 1, +dateId.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
jest.mock('../calendar', () => ({
  CalendarService: {
    getPrevTradingDateId: jest.fn(async (id: string) => prevDate(id)),
    getCalendarDay: jest.fn(async () => ({ tradingIndex: 1 })),
    isTradingDay: jest.fn(async () => true),
    upsertToday: jest.fn(async () => {}),
  },
}));

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { doPlaceOrders, doOpenFillSimulation } from '../paperBroker';

const fake = () => (globalThis as any).__fakeCollision as ReturnType<typeof makeFakeAdmin>;

describe('PaperBroker — SEPA+ATH same-symbol same-day collision', () => {
  const db = () => fake().db as any;

  beforeAll(async () => {
    await db().doc('config/account').set({
      initialEquity: 1_000_000, equity: 1_000_000, peakEquity: 1_000_000, realizedPnl: 0,
      cashBalance: 1_000_000,
      baseRiskPct: 0.005, maxOpenRiskR: 6, maxPositions: 10, strategyRiskWeights: {},
    });

    // Two APPROVED signals for the SAME symbol on the SAME day — one per equity strategy.
    await db().doc('signals/20260105/items/TESTCO_20260105_SepaBreakoutEOD').set({
      symbol: 'TESTCO', direction: 'BUY', strategy: 'SepaBreakoutEOD', status: 'APPROVED',
      atrRef: 7, stopAtrMult: 1, targetAtrMult: 1000,
      features: { rsRank126: 5 },
      riskApproval: { status: 'APPROVED', sizedQty: 100, riskAmount: 10_000 },
    });
    await db().doc('signals/20260105/items/TESTCO_20260105_ATHPullbackEOD').set({
      symbol: 'TESTCO', direction: 'BUY', strategy: 'ATHPullbackEOD', status: 'APPROVED',
      atrRef: 10, stopAtrMult: 1, targetAtrMult: 1000,
      features: { rsRank126: 8 },
      riskApproval: { status: 'APPROVED', sizedQty: 100, riskAmount: 10_000 },
    });
  });

  it('opens exactly ONE position and writes exactly ONE entry fill (no orphaned cash)', async () => {
    await doPlaceOrders('20260105');

    // Both orders should be ACCEPTED entry orders for TESTCO.
    const orders = await db().collection('paperOrders').doc('20260105').collection('items').get();
    const accepted = orders.docs.map((d: any) => d.data()).filter((o: any) => o.status === 'ACCEPTED');
    expect(accepted.length).toBe(2);

    // Fill both in one per-symbol batch.
    barState.bar = { open: 100, high: 101, low: 99, close: 100 };
    await doOpenFillSimulation('jobFill', '2026-01-06', 'TESTCO');

    // Exactly one OPEN position for the symbol.
    const openPos = (await db().collection('portfolio').doc('default').collection('positions')
      .where('status', '==', 'OPEN').get()).docs.map((d: any) => d.data());
    const testco = openPos.filter((p: any) => p.symbol === 'TESTCO');
    expect(testco.length).toBe(1);
    expect(testco[0].qty).toBe(100);

    // Exactly one ENTRY fill was written — the orphaned second buy never happened.
    const fills = (await db().collection('paperFills').doc('20260106').collection('items').get())
      .docs.map((d: any) => d.data());
    const entryFills = fills.filter((f: any) => f.fillType === 'ENTRY' && f.symbol === 'TESTCO');
    expect(entryFills.length).toBe(1);

    // The other order was cancelled with the stacked-entry reason.
    const finalOrders = (await db().collection('paperOrders').doc('20260105').collection('items').get())
      .docs.map((d: any) => d.data());
    const cancelled = finalOrders.filter((o: any) => o.status === 'CANCELLED' && o.rejectReason === 'POSITION_ALREADY_OPEN');
    const filled = finalOrders.filter((o: any) => o.status === 'FILLED');
    expect(cancelled.length).toBe(1);
    expect(filled.length).toBe(1);
  });
});
