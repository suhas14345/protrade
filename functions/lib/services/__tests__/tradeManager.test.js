"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tradeManager_1 = require("../tradeManager");
const barCache_1 = require("../barCache");
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../calendar', () => ({
    CalendarService: {
        getPrevTradingDateId: jest.fn().mockResolvedValue('20260814'),
        getCalendarDay: jest.fn().mockResolvedValue({ tradingIndex: 1 }),
    },
}));
jest.mock('../barCache', () => ({
    getBarOn: jest.fn(),
    getWindowOnOrBefore: jest.fn(),
}));
/**
 * Regression for the critical exit-management bug: doManageTrades used to run at the
 * start of the EOD, BEFORE today's bars were fetched, so getBarOn(today) was null and
 * every position was skipped — no exit ever fired in live. The fix runs it in the
 * finalize step (after all bars are fetched). These tests prove that, WHEN today's
 * bar is present, a broken thesis/stop actually queues a next-open EXIT order.
 */
describe('doManageTrades — exits queue when today\'s bar is present', () => {
    const { mockFirestore } = global;
    function metalsPosition() {
        const ref = { path: 'portfolio/default/positions/GOLDBEES', update: jest.fn().mockResolvedValue(true) };
        return {
            ref,
            data: () => ({
                symbol: 'GOLDBEES', strategy: 'MetalsRotation', direction: 'BUY',
                avgEntryPrice: 100, qty: 500, stopPrice: 75, status: 'OPEN', entryDateId: '20260101',
            }),
        };
    }
    beforeEach(() => {
        jest.clearAllMocks();
        mockFirestore.get.mockReset();
        mockFirestore.get.mockResolvedValue({ exists: false, empty: true, docs: [], data: () => ({}) });
        mockFirestore.set.mockResolvedValue(true);
    });
    it('queues an EXIT_THESIS order when a metals position closes below its 200-SMA', async () => {
        // Positions query → one OPEN metals position.
        mockFirestore.get.mockResolvedValueOnce({ empty: false, docs: [metalsPosition()] });
        // Today's bar exists (the whole point of the fix): close 90, below the 200-SMA (~100).
        barCache_1.getBarOn.mockResolvedValue({ close: 90, high: 92, low: 89 });
        barCache_1.getWindowOnOrBefore.mockResolvedValue(Array.from({ length: 200 }, () => ({ close: 100 })) // sma200 = 100 > close 90 → thesis break
        );
        await (0, tradeManager_1.doManageTrades)('20260817', 'job1');
        // An EXIT order must have been written to paperOrders.
        const exitWrites = mockFirestore.set.mock.calls.filter((c) => c[0] && c[0].orderType === 'EXIT');
        expect(exitWrites.length).toBe(1);
        expect(exitWrites[0][0]).toMatchObject({ symbol: 'GOLDBEES', orderType: 'EXIT', exitType: 'EXIT_THESIS', side: 'SELL' });
    });
    it('does NOT queue an exit while the position is still above its 200-SMA', async () => {
        mockFirestore.get.mockResolvedValueOnce({ empty: false, docs: [metalsPosition()] });
        barCache_1.getBarOn.mockResolvedValue({ close: 110, high: 111, low: 109 }); // above trend + stop
        barCache_1.getWindowOnOrBefore.mockResolvedValue(Array.from({ length: 200 }, () => ({ close: 100 })) // sma200 = 100 < close 110 → hold
        );
        await (0, tradeManager_1.doManageTrades)('20260817', 'job1');
        const exitWrites = mockFirestore.set.mock.calls.filter((c) => c[0] && c[0].orderType === 'EXIT');
        expect(exitWrites.length).toBe(0);
    });
    it('skips management when today\'s bar is missing (mirrors the old-timing guard)', async () => {
        mockFirestore.get.mockResolvedValueOnce({ empty: false, docs: [metalsPosition()] });
        barCache_1.getBarOn.mockResolvedValue(null); // no bar → position skipped, no exit
        await (0, tradeManager_1.doManageTrades)('20260817', 'job1');
        const exitWrites = mockFirestore.set.mock.calls.filter((c) => c[0] && c[0].orderType === 'EXIT');
        expect(exitWrites.length).toBe(0);
    });
});
//# sourceMappingURL=tradeManager.test.js.map