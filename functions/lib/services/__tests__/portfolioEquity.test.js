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
/**
 * Per-position mark-to-market. `markPosition` is the SINGLE formula shared by the
 * account roll-up (`computeOpenUnrealized`) and the per-position write-back
 * (`persistOpenPositionMarks`). These tests pin that a position doc's
 * `unrealizedPnl` reconciles to the account to the paisa and that a later close
 * replaces the mark exactly (regression: position docs used to read 0 while the
 * account equity already reflected the mark, so the numbers disagreed).
 */
describe('markPosition', () => {
    const pos = (o) => (Object.assign({ direction: 'BUY', avgEntryPrice: 100, qty: 10 }, o));
    it('long: gross gain minus the unrealised entry-fee share', () => {
        const { unrealizedPnl, unrealizedPnlPct } = (0, portfolioEquity_1.markPosition)(pos({ avgEntryPrice: 100, qty: 50, entryQty: 50, entryFee: 20 }), 110);
        // (110-100)*50 - 20 = 480 ; pct = 480 / (100*50)
        expect(unrealizedPnl).toBeCloseTo(480, 10);
        expect(unrealizedPnlPct).toBeCloseTo(480 / 5000, 12);
    });
    it('short: gain when price falls', () => {
        const { unrealizedPnl } = (0, portfolioEquity_1.markPosition)(pos({ direction: 'SELL', avgEntryPrice: 200, qty: 30, entryQty: 30, entryFee: 12 }), 180);
        // (200-180)*30 - 12 = 588
        expect(unrealizedPnl).toBeCloseTo(588, 10);
    });
    it('prorates the entry fee by remaining qty after a partial exit', () => {
        // qty decremented to 40 of an original 100; only 40/100 of the entry fee is still open.
        const { unrealizedPnl } = (0, portfolioEquity_1.markPosition)(pos({ avgEntryPrice: 100, qty: 40, entryQty: 100, entryFee: 50 }), 120);
        // (120-100)*40 - 50*(40/100) = 800 - 20
        expect(unrealizedPnl).toBeCloseTo(780, 10);
    });
    it('guards divide-by-zero on entry cost (pct = 0)', () => {
        const { unrealizedPnl, unrealizedPnlPct } = (0, portfolioEquity_1.markPosition)(pos({ avgEntryPrice: 0, qty: 0, entryQty: 0, entryFee: 0 }), 100);
        expect(unrealizedPnl).toBe(0);
        expect(unrealizedPnlPct).toBe(0);
    });
    it('equals the realised P&L of an exit at the same close with zero exit fee', () => {
        // Reconciliation guarantee: when a position closes, its realised record must
        // replace exactly the mark. markPosition(close) === computeExitPnl(exit@close, exitFee=0).
        const cases = [
            { direction: 'BUY', avgEntryPrice: 125.97, qty: 599, entryFee: 29.04 },
            { direction: 'SELL', avgEntryPrice: 250, qty: 12, entryFee: 6 },
            { direction: 'BUY', avgEntryPrice: 100, qty: 40, entryFee: 50 },
        ];
        for (const c of cases) {
            const close = 126.47;
            const mark = (0, portfolioEquity_1.markPosition)(pos(Object.assign(Object.assign({}, c), { entryQty: c.qty })), close).unrealizedPnl;
            const asExit = (0, portfolioEquity_1.computeExitPnl)({
                direction: c.direction, avgEntryPrice: c.avgEntryPrice, exitPrice: close,
                exitQty: c.qty, entryQty: c.qty, entryFee: c.entryFee, exitFee: 0,
            }).realizedPnl;
            expect(mark).toBeCloseTo(asExit, 10);
        }
    });
    it('per-position marks sum to the account openUnrealized / equity identity', () => {
        // The account roll-up is Σ markPosition over OPEN positions; equity is then
        // initial + realizedToDate + Σ marks. Pin the arithmetic end-to-end.
        const initialEquity = 500000;
        const realizedToDate = 0;
        const positions = [
            { p: pos({ direction: 'BUY', avgEntryPrice: 125.97069599999999, qty: 599, entryQty: 599, entryFee: 29.04 }), close: 126.47 },
            { p: pos({ direction: 'SELL', avgEntryPrice: 300, qty: 20, entryQty: 20, entryFee: 15 }), close: 291.5 },
        ];
        const openUnrealized = positions.reduce((s, x) => s + (0, portfolioEquity_1.markPosition)(x.p, x.close).unrealizedPnl, 0);
        const equity = initialEquity + realizedToDate + openUnrealized;
        // Hand-computed: leg1 = 599*(126.47-125.97069599999999)-29.04 ; leg2 = 20*(300-291.5)-15
        const leg1 = 599 * (126.47 - 125.97069599999999) - 29.04;
        const leg2 = 20 * (300 - 291.5) - 15;
        expect(openUnrealized).toBeCloseTo(leg1 + leg2, 8);
        expect(equity).toBeCloseTo(initialEquity + leg1 + leg2, 8);
    });
});
/**
 * Equity anchor. Regression for a COMPOUNDING drift bug: config/account had no
 * initialEquity, so recomputeAccountEquity fell back to peakEquity (which moves up
 * every run) and re-added open+realised P&L each EOD — equity inflated by ~openUnrealized
 * per run. The anchor must be immutable and NEVER derived from peakEquity/equity.
 */
describe('resolveInitialEquity (immutable equity anchor)', () => {
    it('uses initialEquity when present and does not backfill', () => {
        const r = (0, portfolioEquity_1.resolveInitialEquity)({ initialEquity: 500000, equity: 500270 }, 0, 270);
        expect(r).toEqual({ initial: 500000, backfill: false });
    });
    it('never anchors on peakEquity/equity when initialEquity is present', () => {
        // Even with a wildly inflated equity/peak, the anchor stays the deposited capital.
        const r = (0, portfolioEquity_1.resolveInitialEquity)({ initialEquity: 500000, equity: 999999 }, 0, 270);
        expect(r.initial).toBe(500000);
    });
    it('backfills a stable baseline once when initialEquity is missing', () => {
        // initial = equity - realized - openUnrealized (reconstructs the deposit).
        const r = (0, portfolioEquity_1.resolveInitialEquity)({ equity: 500270 }, 0, 270);
        expect(r.backfill).toBe(true);
        expect(r.initial).toBeCloseTo(500000, 6);
    });
    it('is drift-free across repeated recomputations (the actual bug)', () => {
        const openUnrealized = 270.063096;
        const realized = 0;
        // Seed run: fresh account (no open position yet), initialEquity backfilled to the deposit.
        let account = { equity: 500000 };
        let a = (0, portfolioEquity_1.resolveInitialEquity)(account, realized, 0);
        let equity = a.initial + realized + 0; // 500,000
        account = { initialEquity: a.initial, equity }; // persist the anchor
        expect(a.initial).toBe(500000);
        // A position opens; run the EOD three more times — equity must NOT compound.
        const equities = [];
        for (let i = 0; i < 3; i++) {
            a = (0, portfolioEquity_1.resolveInitialEquity)(account, realized, openUnrealized);
            equity = a.initial + realized + openUnrealized;
            account = { initialEquity: a.initial, equity }; // simulate the write-back
            equities.push(equity);
            expect(a.backfill).toBe(false);
        }
        // Every run yields the same equity — no per-run inflation.
        expect(equities[0]).toBeCloseTo(500000 + openUnrealized, 8);
        expect(equities[1]).toBeCloseTo(equities[0], 10);
        expect(equities[2]).toBeCloseTo(equities[0], 10);
    });
});
/**
 * Buying power / available funds. Trades must strictly use SETTLED CASH
 * (initialEquity + realizedPnl), NEVER equity (which includes unrealised gains that
 * are not cash). And a sale must return its capital + P&L to available cash.
 */
describe('settledCash / availableFunds (strict funds)', () => {
    it('settledCash = initialEquity + realizedPnl (NOT equity)', () => {
        // Equity is inflated by unrealised gains; buying power must ignore them.
        expect((0, portfolioEquity_1.settledCash)({ initialEquity: 500000, realizedPnl: 1234.5, equity: 999999 })).toBeCloseTo(501234.5, 6);
    });
    it('falls back to equity only when initialEquity is missing (legacy doc)', () => {
        expect((0, portfolioEquity_1.settledCash)({ equity: 500270, realizedPnl: 0 })).toBe(500270);
    });
    it('availableFunds = settledCash - deployed cost', () => {
        const deployed = 125.97069599999999 * 599; // GOLDBEES cost basis
        expect((0, portfolioEquity_1.availableFunds)({ initialEquity: 500000, realizedPnl: 0 }, deployed))
            .toBeCloseTo(500000 - deployed, 6);
    });
    it('a sale returns capital + P&L to available cash (sold equity updates cash)', () => {
        const init = 500000;
        const entry = 125.97069599999999, qty = 599, entryFee = 29.04;
        const cost = entry * qty;
        // Before the sale: one open position, cash = settledCash - deployed.
        const cashBefore = (0, portfolioEquity_1.availableFunds)({ initialEquity: init, realizedPnl: 0 }, cost);
        // Sell the whole position at 130 with a 20 exit fee.
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({
            direction: 'BUY', avgEntryPrice: entry, exitPrice: 130, exitQty: qty,
            entryQty: qty, entryFee, exitFee: 20,
        });
        // After the sale: position closed (deployed 0), realised booked into settled cash.
        const cashAfter = (0, portfolioEquity_1.availableFunds)({ initialEquity: init, realizedPnl }, 0);
        // Cash rose by exactly the freed cost basis plus the realised P&L.
        expect(cashAfter - cashBefore).toBeCloseTo(cost + realizedPnl, 6);
        expect(cashAfter).toBeGreaterThan(cashBefore);
    });
    it('reconciliation holds before AND after a sale: equity = cash + deployed + unrealized', () => {
        const init = 500000;
        const entry = 100, qty = 100, entryFee = 20;
        const cost = entry * qty;
        // Open: mark at 110 -> unrealized = (110-100)*100 - 20 = 980.
        const uPnl = (0, portfolioEquity_1.markPosition)({ direction: 'BUY', avgEntryPrice: entry, qty, entryQty: qty, entryFee }, 110).unrealizedPnl;
        const equityOpen = init + 0 + uPnl;
        const cashOpen = equityOpen - cost - uPnl;
        expect(cashOpen + cost + uPnl).toBeCloseTo(equityOpen, 8); // reconciles while open
        expect(cashOpen).toBeCloseTo((0, portfolioEquity_1.availableFunds)({ initialEquity: init, realizedPnl: 0 }, cost), 8);
        // Close at 110, exitFee 0 -> realised replaces the mark exactly.
        const { realizedPnl } = (0, portfolioEquity_1.computeExitPnl)({ direction: 'BUY', avgEntryPrice: entry, exitPrice: 110, exitQty: qty, entryQty: qty, entryFee, exitFee: 0 });
        const equityClosed = init + realizedPnl + 0;
        const cashClosed = equityClosed - 0 - 0;
        expect(cashClosed).toBeCloseTo(equityClosed, 8); // reconciles after close
        expect(realizedPnl).toBeCloseTo(uPnl, 8); // no jump: realised == prior mark
        expect(equityClosed).toBeCloseTo(equityOpen, 8); // equity continuous across the close
    });
});
//# sourceMappingURL=portfolioEquity.test.js.map