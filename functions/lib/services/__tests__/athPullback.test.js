"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const strategy_1 = require("../strategy");
/**
 * ATH-Pullback entry gate. Buys a LEADER (long-term uptrend + RS) that has pulled back
 * 3–15% off its 52-week high into the 50-SMA buy-zone on a healthy RSI. These pin each
 * condition so the strategy can't silently drift into buying breakdowns or extended tops.
 */
describe('athPullbackSetup (ATH-Pullback entry gate)', () => {
    // A textbook leader pulled back to ~+3% of the 50-SMA, ~6% off the 52w high.
    const leader = { sma50: 100, sma150: 95, sma200: 90, high252: 110, rsRank126: 30, rsi14: 50, sma200Rising: true };
    const CLOSE = 103; // dist50 = +3% (in zone), 6.4% below the 52w high, above the 50-SMA
    it('accepts a leader that pulled back into the 50-SMA buy-zone', () => {
        expect((0, strategy_1.athPullbackSetup)(leader, CLOSE)).toBe(true);
    });
    it('rejects a stock still AT the highs (not pulled back)', () => {
        expect((0, strategy_1.athPullbackSetup)(leader, 109)).toBe(false); // <3% off the high
    });
    it('rejects a deep breakdown (>15% off the high / below the 50-SMA)', () => {
        expect((0, strategy_1.athPullbackSetup)(leader, 90)).toBe(false);
    });
    it('rejects when too extended above the 50-SMA (out of the buy-zone)', () => {
        expect((0, strategy_1.athPullbackSetup)(leader, 106.5)).toBe(false); // dist50 ~6.5% > band
    });
    it('rejects an overbought pullback', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { rsi14: 65 }), CLOSE)).toBe(false);
    });
    it('rejects an oversold pullback', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { rsi14: 35 }), CLOSE)).toBe(false);
    });
    it('rejects a non-leader (weak RS rank)', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { rsRank126: 80 }), CLOSE)).toBe(false);
    });
    it('rejects when the 200-SMA is not rising (no long-term uptrend)', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { sma200Rising: false }), CLOSE)).toBe(false);
    });
    it('rejects a broken SMA stack (50 < 150)', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { sma50: 90, sma150: 95 }), CLOSE)).toBe(false);
    });
    it('fails closed on a missing feature', () => {
        expect((0, strategy_1.athPullbackSetup)(Object.assign(Object.assign({}, leader), { rsi14: undefined }), CLOSE)).toBe(false);
    });
});
//# sourceMappingURL=athPullback.test.js.map