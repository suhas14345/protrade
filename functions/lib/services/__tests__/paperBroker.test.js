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
//# sourceMappingURL=paperBroker.test.js.map