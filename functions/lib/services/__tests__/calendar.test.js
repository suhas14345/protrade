"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const calendar_1 = require("../calendar");
// Mock logger (calendar uses console.warn directly but future-proof)
jest.mock('../logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
describe('CalendarService', () => {
    const { mockFirestore } = global;
    beforeEach(() => {
        jest.clearAllMocks();
    });
    // ── getPrevTradingDateId ──────────────────────────────────────────
    describe('getPrevTradingDateId', () => {
        it('returns stored prevTradingDateId when calendar doc exists', async () => {
            mockFirestore.get.mockResolvedValueOnce({
                exists: true,
                data: () => ({ prevTradingDateId: '20260409' })
            });
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260410');
            expect(result).toBe('20260409');
        });
        it('falls back to Friday when given Monday with no calendar doc', async () => {
            // 2026-04-13 is a Monday
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260413');
            // Should walk back: Sun(12) → skip, Sat(11) → skip, Fri(10) → return
            expect(result).toBe('20260410');
        });
        it('falls back to Friday when given Saturday', async () => {
            // 2026-04-11 is a Saturday
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260411');
            // Sat: walk back → Fri(10)
            expect(result).toBe('20260410');
        });
        it('falls back to Friday when given Sunday', async () => {
            // 2026-04-12 is a Sunday
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260412');
            // Sun: walk back → Sat(11) skip → Fri(10)
            expect(result).toBe('20260410');
        });
        it('returns Thursday for a Friday input with no calendar doc', async () => {
            // 2026-04-10 is a Friday
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260410');
            expect(result).toBe('20260409'); // Thursday
        });
        it('returns null when calendar doc has no prevTradingDateId field', async () => {
            // Doc exists but without the field — triggers fallback
            mockFirestore.get.mockResolvedValueOnce({
                exists: true,
                data: () => ({ isTradingDay: true }) // no prevTradingDateId
            });
            // 2026-04-14 is a Tuesday
            const result = await calendar_1.CalendarService.getPrevTradingDateId('20260414');
            expect(result).toBe('20260413'); // Monday (fallback)
        });
    });
    // ── isTradingDay ──────────────────────────────────────────────────
    describe('isTradingDay', () => {
        it('returns true for a weekday when no calendar doc exists', async () => {
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            // 2026-04-13 is Monday
            const result = await calendar_1.CalendarService.isTradingDay('20260413');
            expect(result).toBe(true);
        });
        it('returns false for Saturday when no calendar doc exists', async () => {
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            // 2026-04-11 is Saturday
            const result = await calendar_1.CalendarService.isTradingDay('20260411');
            expect(result).toBe(false);
        });
        it('returns false for Sunday when no calendar doc exists', async () => {
            mockFirestore.get.mockResolvedValueOnce({ exists: false, data: () => ({}) });
            // 2026-04-12 is Sunday
            const result = await calendar_1.CalendarService.isTradingDay('20260412');
            expect(result).toBe(false);
        });
        it('uses calendar doc when it exists (holiday on weekday)', async () => {
            mockFirestore.get.mockResolvedValueOnce({
                exists: true,
                data: () => ({ isTradingDay: false }) // Holiday
            });
            const result = await calendar_1.CalendarService.isTradingDay('20260414');
            expect(result).toBe(false);
        });
        it('uses calendar doc when it exists (trading day)', async () => {
            mockFirestore.get.mockResolvedValueOnce({
                exists: true,
                data: () => ({ isTradingDay: true })
            });
            const result = await calendar_1.CalendarService.isTradingDay('20260413');
            expect(result).toBe(true);
        });
    });
});
//# sourceMappingURL=calendar.test.js.map