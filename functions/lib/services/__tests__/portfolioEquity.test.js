"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const portfolioEquity_1 = require("../portfolioEquity");
/**
 * Unit tests for the single realised-P&L formula used by the paperBroker exit
 * path. These pin the arithmetic (long/short, partial exits, entry-fee proration)
 * and independently verify the double-entry identity the backtest auditor relies
 * on: realisedPnl(closed) + unrealised(open) == net cash flow + open market value.
 */
describe('computeExitPnl', () => {
    it('long full exit: gross gain minus both fees', () => {
        const { realizedPnl, entryFeeShare } = (0, portfolioEquity_1.computeExitPnl)({
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
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
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
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
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
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
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
        const { realizedPnl, entryFeeShare } = (0, portfolioEquity_1.computeExitPnl)({
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
        const first = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'BUY', avgEntryPrice: 100, exitPrice: 130,
            exitQty: 60, entryQty: 100, entryFee: 50, exitFee: 6,
        });
        const second = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'BUY', avgEntryPrice: 100, exitPrice: 140,
            exitQty: 40, entryQty: 100, entryFee: 50, exitFee: 4,
        });
        // Entry fee shares must sum to the full entry fee.
        expect(first.entryFeeShare + second.entryFeeShare).toBeCloseTo(50, 10);
        // Total realised = gross - all fees = (130-100)*60 + (140-100)*40 - 6 - 4 - 50
        expect(first.realizedPnl + second.realizedPnl).toBeCloseTo(1800 + 1600 - 60, 10);
    });
    it('guards against a zero entryQty (no divide-by-zero)', () => {
        const { realizedPnl, entryFeeShare } = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'BUY', avgEntryPrice: 100, exitPrice: 110,
            exitQty: 10, entryQty: 0, entryFee: 20, exitFee: 5,
        });
        expect(entryFeeShare).toBe(0);
        expect(realizedPnl).toBeCloseTo(95, 10);
    });
    it('satisfies the double-entry identity: realised == net cash flow (long round trip)', () => {
        const entryPrice = 100, qty = 25, entryFee = 7, exitPrice = 118, exitFee = 9;
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'BUY', avgEntryPrice: entryPrice, exitPrice,
            exitQty: qty, entryQty: qty, entryFee, exitFee,
        });
        // Independent cash-flow reconstruction: buy = cash out, sell = cash in, minus fees.
        const cashFlow = (-entryPrice * qty - entryFee) + (exitPrice * qty - exitFee);
        expect(realizedPnl).toBeCloseTo(cashFlow, 10);
    });
    it('satisfies the double-entry identity for a short round trip', () => {
        const entryPrice = 250, qty = 12, entryFee = 6, exitPrice = 230, exitFee = 5;
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'SELL', avgEntryPrice: entryPrice, exitPrice,
            exitQty: qty, entryQty: qty, entryFee, exitFee,
        });
        // Short: entry is a SELL (cash in), exit is a BUY (cash out), minus fees.
        const cashFlow = (entryPrice * qty - entryFee) + (-exitPrice * qty - exitFee);
        expect(realizedPnl).toBeCloseTo(cashFlow, 10);
    });
});
//# sourceMappingURL=portfolioEquity.test.js.map