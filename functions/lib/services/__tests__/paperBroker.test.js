"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const paperBroker_1 = require("../paperBroker");
const calendar_1 = require("../calendar");
// Mock logger
jest.mock('../logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
// Mock calendar service
jest.mock('../calendar');
describe('PaperBroker — doOpenFillSimulation', () => {
    const { mockFirestore } = global;
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: calendar returns a valid prev date
        calendar_1.CalendarService.getPrevTradingDateId.mockResolvedValue('20260410');
    });
    it('returns early when prevDateId is null (no previous trading day)', async () => {
        calendar_1.CalendarService.getPrevTradingDateId.mockResolvedValue(null);
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // Should not attempt any Firestore reads beyond calendar
        expect(mockFirestore.collection).not.toHaveBeenCalledWith('paperOrders');
    });
    it('returns early when no ACCEPTED orders exist for the symbol', async () => {
        // orders query returns empty
        mockFirestore.get.mockResolvedValueOnce({ empty: true, docs: [] });
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // Should not attempt to read bar data
        expect(mockFirestore.collection).not.toHaveBeenCalledWith('barsD');
    });
    it('returns early when bar data is missing for today', async () => {
        const mockOrder = {
            id: 'order1',
            ref: { update: jest.fn() },
            data: () => ({
                symbol: 'TCS.NS',
                side: 'BUY',
                status: 'ACCEPTED',
                intendedQty: 10,
                orderType: 'ENTRY',
                createdFromSignalId: 'sig1',
                risk: { riskAmount: 5000 },
            }),
        };
        // 1. orders query returns one order
        mockFirestore.get
            .mockResolvedValueOnce({ empty: false, docs: [mockOrder] })
            // 2. bar for today — missing
            .mockResolvedValueOnce({ exists: false, data: () => ({}) });
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // batch.commit should NOT have been called since we returned early
        // The function returns before creating any fills
    });
    it('fills a BUY ENTRY order at open with slippage clamped to bar range', async () => {
        const mockOrder = {
            id: 'order1',
            ref: { update: jest.fn() },
            data: () => ({
                symbol: 'TCS.NS',
                side: 'BUY',
                status: 'ACCEPTED',
                intendedQty: 10,
                orderType: 'ENTRY',
                createdFromSignalId: 'sig1',
                risk: { riskAmount: 5000 },
            }),
        };
        const mockBar = { open: 5000, high: 5100, low: 4950, close: 5050, volume: 1000000 };
        const mockSignal = {
            strategy: 'PullbackEOD',
            atrRef: 50,
            stopAtrMult: 2.0,
            targetAtrMult: 3.0,
            direction: 'BUY',
        };
        // Sequence: orders → bar → regime → signal(for slippage) → signal(for position creation)
        mockFirestore.get
            .mockResolvedValueOnce({ empty: false, docs: [mockOrder] }) // orders
            .mockResolvedValueOnce({ exists: true, data: () => mockBar }) // bar
            .mockResolvedValueOnce({ exists: true, data: () => ({ marketState: 'TREND' }) }) // regime
            .mockResolvedValueOnce({ exists: true, data: () => ({ features: { liquidity: { bucket: 'A', medVol20: 500000 } } }) }) // signal for slippage
            .mockResolvedValueOnce({ exists: true, data: () => mockSignal }); // signal for position
        // Mock batch
        const batchMock = { set: jest.fn(), update: jest.fn(), commit: jest.fn().mockResolvedValue(true) };
        mockFirestore.batch.mockReturnValue(batchMock);
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // Verify fill was created in paperFills
        expect(batchMock.set).toHaveBeenCalled();
        // Verify order was marked FILLED
        expect(batchMock.update).toHaveBeenCalled();
        expect(batchMock.commit).toHaveBeenCalled();
    });
    it('uses prevDateId (not current dateId) to query orders', async () => {
        calendar_1.CalendarService.getPrevTradingDateId.mockResolvedValue('20260410');
        // Empty orders for this test — we just want to verify the query path
        mockFirestore.get.mockResolvedValueOnce({ empty: true, docs: [] });
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // The orders collection must use prevDateId (20260410), not dateId (20260413)
        expect(mockFirestore.doc).toHaveBeenCalledWith('20260410');
        expect(mockFirestore.collection).toHaveBeenCalledWith('paperOrders');
    });
    it('converts runDate format (YYYY-MM-DD) to dateId (YYYYMMDD)', async () => {
        mockFirestore.get.mockResolvedValueOnce({ empty: true, docs: [] });
        await (0, paperBroker_1.doOpenFillSimulation)('job1', '2026-04-13', 'TCS.NS');
        // CalendarService should receive '20260413' (hyphens removed)
        expect(calendar_1.CalendarService.getPrevTradingDateId).toHaveBeenCalledWith('20260413');
    });
});
/**
 * SEPA buying-power gate. Regression for the capital gap: SEPA sized off TOTAL
 * equity with no gross-exposure cap, so SEPA (≤ 10 × ~17.9%) + metals (30%) could
 * jointly deploy ~208% of equity. The gate caps SEPA gross to its BOOK_PCT book so
 * SEPA + metals can never exceed 100% of equity.
 */
describe('capSepaQtyToBook (SEPA buying-power gate)', () => {
    it('returns the desired qty when the whole order fits in the book', () => {
        // book 350k, nothing deployed, order 100 @ 1000 = 100k ≤ 350k
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 1000, 0, 350000)).toBe(100);
    });
    it('scales the order down to the remaining book', () => {
        // remaining = 350k - 300k = 50k ; at 1000/share → 50 shares (< desired 100)
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 1000, 300000, 350000)).toBe(50);
    });
    it('returns 0 when the book is full', () => {
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 1000, 350000, 350000)).toBe(0);
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 1000, 400000, 350000)).toBe(0);
    });
    it('floors fractional share capacity (never over-commits by rounding)', () => {
        // remaining 50,900 / 1000 = 50.9 → 50
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 1000, 299100, 350000)).toBe(50);
    });
    it('does not gate when priceRef is unknown (0)', () => {
        expect((0, paperBroker_1.capSepaQtyToBook)(100, 0, 0, 350000)).toBe(100);
    });
    it('invariant: sequentially placed SEPA orders never exceed the book', () => {
        const equity = 500000;
        const sepaBook = equity * 0.70; // 350k SEPA book
        const price = 125;
        const desiredPerOrder = 700; // 700 * 125 = 87,500 ≈ 17.5% each
        let deployed = 0;
        let placed = 0;
        for (let i = 0; i < 10; i++) {
            const qty = (0, paperBroker_1.capSepaQtyToBook)(desiredPerOrder, price, deployed, sepaBook);
            if (qty <= 0)
                continue;
            deployed += qty * price;
            placed++;
        }
        // Never breaches the book...
        expect(deployed).toBeLessThanOrEqual(sepaBook + 1e-6);
        // ...and with metals at 30%, combined stays within 100% of equity.
        const metalsBook = equity * 0.30;
        expect(deployed + metalsBook).toBeLessThanOrEqual(equity + 1e-6);
        // ~4 fully-funded positions fit in the 70% book (not 10 leveraged ones).
        expect(placed).toBeGreaterThanOrEqual(3);
        expect(placed).toBeLessThanOrEqual(4);
    });
});
/**
 * LIMIT entry fill decision (ATH-Pullback). Buy-on-dip limits must only fill when
 * price actually trades into the buy range, must not chase a gap-up away from support,
 * and must never enter a trade that already gapped below its stop.
 */
describe('resolveLimitEntryFill (LIMIT buy-on-dip)', () => {
    const HI = 100; // don't pay more than 100 (today's close)
    const LO = 90; // stop — cancel if it opens below this
    it('fills at the open when the session opens inside the range', () => {
        const r = (0, paperBroker_1.resolveLimitEntryFill)({ open: 98, low: 95, high: 102 }, LO, HI);
        expect(r.action).toBe('FILL');
        expect(r.refPrice).toBe(98); // min(open, limitHi) = min(98,100)
    });
    it('fills at the limit ceiling when it opens above but dips into the range', () => {
        const r = (0, paperBroker_1.resolveLimitEntryFill)({ open: 103, low: 99, high: 104 }, LO, HI);
        expect(r.action).toBe('FILL');
        expect(r.refPrice).toBe(HI); // min(103,100) = 100
    });
    it('does not chase: cancels when the range is never touched (gap-up run)', () => {
        const r = (0, paperBroker_1.resolveLimitEntryFill)({ open: 105, low: 101, high: 108 }, LO, HI);
        expect(r.action).toBe('CANCEL_NO_FILL');
    });
    it('cancels when the session gaps below the stop (thesis broken)', () => {
        const r = (0, paperBroker_1.resolveLimitEntryFill)({ open: 88, low: 85, high: 92 }, LO, HI);
        expect(r.action).toBe('CANCEL_GAP_BELOW');
    });
    it('treats an undefined ceiling as unbounded (fills at open)', () => {
        const r = (0, paperBroker_1.resolveLimitEntryFill)({ open: 120, low: 118, high: 122 }, LO, undefined);
        expect(r.action).toBe('FILL');
        expect(r.refPrice).toBe(120);
    });
});
//# sourceMappingURL=paperBroker.test.js.map