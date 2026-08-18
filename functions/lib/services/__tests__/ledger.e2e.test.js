"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// ── Wire the REAL ledger functions to an in-memory Firestore ───────────────────
// The admin mock (created in the factory to satisfy jest hoisting) is stashed on
// globalThis so the test can seed/inspect the same store the functions write to.
jest.mock('firebase-admin', () => {
    const { makeFakeAdmin: make } = require('./helpers/fakeFirestore');
    const fake = make();
    globalThis.__fake = fake;
    return fake.admin;
});
// Bars/prices are supplied per step; the closures read barState lazily at call time.
const barState = { bar: null, window: [], latest: null };
jest.mock('../barCache', () => ({
    getBarOn: (..._a) => Promise.resolve(barState.bar),
    getWindowOnOrBefore: (..._a) => Promise.resolve(barState.window),
    getLatestOnOrBefore: (..._a) => Promise.resolve(barState.latest),
    clearBarCache: () => { },
}));
// Calendar: consecutive weekdays → previous trading day is the prior calendar day.
const prevDate = (dateId) => {
    const d = new Date(Date.UTC(+dateId.slice(0, 4), +dateId.slice(4, 6) - 1, +dateId.slice(6, 8)));
    d.setUTCDate(d.getUTCDate() - 1);
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
jest.mock('../calendar', () => ({
    CalendarService: {
        getPrevTradingDateId: jest.fn(async (id) => prevDate(id)),
        getCalendarDay: jest.fn(async () => ({ tradingIndex: 1 })),
        isTradingDay: jest.fn(async () => true),
        upsertToday: jest.fn(async () => { }),
    },
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const paperBroker_1 = require("../paperBroker");
const tradeManager_1 = require("../tradeManager");
const portfolioEquity_1 = require("../portfolioEquity");
const fake = () => globalThis.__fake;
/**
 * End-to-end ledger simulation against a real in-memory Firestore, driving the REAL
 * ledger functions through: BUY order → fill (open) → mark-to-market → regime/trend
 * exit → sell (close) → balances. Every step asserts the ledger identities:
 *   equity      = initialEquity + realizedPnl + openUnrealized
 *   cashBalance = initialEquity + realizedPnl − deployedCost
 *   equity      = cashBalance + deployedCost + openUnrealized
 *   account.openUnrealized = Σ open positions.unrealizedPnl
 *   account.realizedPnl    = Σ trades.realizedPnl
 */
describe('E2E ledger simulation — buy, mark, regime exit, sell', () => {
    const INITIAL = 500000;
    const db = () => fake().db;
    async function openPositions() {
        const s = await db().collection('portfolio').doc('default').collection('positions').where('status', '==', 'OPEN').get();
        return s.docs.map((d) => d.data());
    }
    async function allTrades() {
        const s = await db().collection('portfolio').doc('default').collection('trades').get();
        return s.docs.map((d) => d.data());
    }
    async function account() {
        return (await db().doc('config/account').get()).data();
    }
    async function recomputeAndAssert(dateId) {
        await (0, portfolioEquity_1.recomputeAccountEquity)(db(), dateId);
        const acct = await account();
        const positions = await openPositions();
        const trades = await allTrades();
        const deployed = positions.reduce((a, p) => a + Math.abs(p.avgEntryPrice * p.qty), 0);
        const openUnreal = positions.reduce((a, p) => a + (p.unrealizedPnl || 0), 0);
        const realized = trades.reduce((a, t) => a + (t.realizedPnl || 0), 0);
        // The four ledger identities — each must hold to the paisa.
        expect(acct.equity).toBeCloseTo(acct.initialEquity + acct.realizedPnl + acct.openUnrealized, 4);
        expect(acct.cashBalance).toBeCloseTo(acct.initialEquity + acct.realizedPnl - deployed, 4);
        expect(acct.equity).toBeCloseTo(acct.cashBalance + deployed + acct.openUnrealized, 4);
        expect(acct.openUnrealized).toBeCloseTo(openUnreal, 4);
        expect(acct.realizedPnl).toBeCloseTo(realized, 4);
        return { acct, deployed, openUnreal, realized };
    }
    beforeAll(async () => {
        // Fresh account: only settled cash, no positions.
        await db().doc('config/account').set({
            initialEquity: INITIAL, equity: INITIAL, peakEquity: INITIAL, realizedPnl: 0,
            baseRiskPct: 0.005, maxOpenRiskR: 6, maxPositions: 10, strategyRiskWeights: {},
        });
    });
    it('BUY: doPlaceOrders creates an ACCEPTED entry order from an APPROVED signal', async () => {
        await db().doc('signals/20260105/items/GOLDBEES_20260105_MetalsRotation').set({
            symbol: 'GOLDBEES', direction: 'BUY', strategy: 'MetalsRotation', status: 'APPROVED',
            atrRef: 25, stopAtrMult: 1, targetAtrMult: 1000,
            riskApproval: { status: 'APPROVED', sizedQty: 700, riskAmount: 75000 },
        });
        await (0, paperBroker_1.doPlaceOrders)('20260105');
        const ord = (await db().doc('paperOrders/20260105/items/GOLDBEES_20260105_MetalsRotation').get()).data();
        expect(ord.status).toBe('ACCEPTED');
        expect(ord.orderType).toBe('ENTRY');
        expect(ord.intendedQty).toBe(700);
    });
    it('FILL: next-open fill opens the position and ties up capital', async () => {
        barState.bar = { open: 100, high: 101, low: 99, close: 100 };
        await (0, paperBroker_1.doOpenFillSimulation)('jobFill', '2026-01-06', 'GOLDBEES');
        const pos = (await db().doc('portfolio/default/positions/GOLDBEES').get()).data();
        expect(pos.status).toBe('OPEN');
        expect(pos.qty).toBe(700);
        expect(pos.avgEntryPrice).toBeGreaterThan(0);
        expect(pos.entryFee).toBeGreaterThan(0);
        // Reconcile at the entry-day close (~entry price).
        barState.latest = { close: 100 };
        const { acct, deployed } = await recomputeAndAssert('20260106');
        // Settled cash was reduced by the deployed cost (no realised yet).
        expect(acct.cashBalance).toBeCloseTo(INITIAL - deployed, 4);
        expect(acct.realizedPnl).toBe(0);
    });
    it('MARK: a price rise lifts equity via unrealized, cash unchanged', async () => {
        const before = await account();
        barState.latest = { close: 110 }; // +10 from entry
        const { acct, deployed } = await recomputeAndAssert('20260107');
        expect(acct.openUnrealized).toBeGreaterThan(0);
        expect(acct.equity).toBeGreaterThan(before.equity);
        // Cash (settled) is untouched by a mark — only unrealized/equity move.
        expect(acct.cashBalance).toBeCloseTo(INITIAL - deployed, 4);
    });
    it('REGIME EXIT: trend break queues a next-open EXIT order', async () => {
        barState.bar = { open: 90, high: 91, low: 89, close: 90 }; // today's close 90
        barState.window = Array.from({ length: 200 }, () => ({ close: 100 })); // 200-SMA = 100 > 90 → thesis break
        await (0, tradeManager_1.doManageTrades)('20260108', 'jobMgr');
        const exit = (await db().doc('paperOrders/20260108/items/EXIT_GOLDBEES_20260108_EXIT_THESIS').get()).data();
        expect(exit.orderType).toBe('EXIT');
        expect(exit.status).toBe('ACCEPTED');
        expect(exit.side).toBe('SELL');
        expect(exit.intendedQty).toBe(700);
    });
    it('SELL: exit fills, books realized P&L, and closes the position', async () => {
        barState.bar = { open: 90, high: 91, low: 89, close: 90 };
        await (0, paperBroker_1.doOpenFillSimulation)('jobExit', '2026-01-09', 'GOLDBEES');
        const pos = (await db().doc('portfolio/default/positions/GOLDBEES').get()).data();
        expect(pos.status).toBe('CLOSED');
        const trades = await allTrades();
        expect(trades.length).toBe(1);
        expect(trades[0].realizedPnl).toBeLessThan(0); // sold ~90 vs entry ~100
    });
    it('BALANCES: final ledger reconciles — realized booked, cash returned, no unrealized', async () => {
        const beforeCash = (await account()).cashBalance;
        barState.latest = null; // no open positions to mark
        const { acct, deployed, realized } = await recomputeAndAssert('20260109');
        expect(deployed).toBe(0);
        expect(acct.openUnrealized).toBeCloseTo(0, 6);
        expect(acct.realizedPnl).toBeCloseTo(realized, 6);
        // With nothing deployed, cash == equity == initial + realized.
        expect(acct.equity).toBeCloseTo(INITIAL + realized, 4);
        expect(acct.cashBalance).toBeCloseTo(acct.equity, 6);
        // Selling returned the freed capital to cash (cash rose vs while-held, despite the loss).
        expect(acct.cashBalance).toBeGreaterThan(beforeCash);
    });
});
//# sourceMappingURL=ledger.e2e.test.js.map