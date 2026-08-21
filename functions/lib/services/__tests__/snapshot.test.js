"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const snapshot_1 = require("../snapshot");
const base = {
    dateId: '20260821',
    account: { equity: 501684, cash: 424544, deployed: 75456, realized: 0, unrealized: 270 },
    positions: [],
    activity: { signals: 0, approved: 0, byStrategy: {}, entryOrders: 0, entryFills: 0, exitFills: 0 },
    critic: null,
};
describe('formatSnapshotText', () => {
    it('renders an empty book cleanly', () => {
        const t = (0, snapshot_1.formatSnapshotText)(base);
        expect(t).toContain('ProTrade snapshot — 20260821');
        expect(t).toContain('Active trades: none');
        expect(t).toContain('[critic: n/a]');
        expect(t).toContain('Equity ₹5,01,684');
    });
    it('lists active trades with P&L and stop', () => {
        const s = Object.assign(Object.assign({}, base), { positions: [{ symbol: 'BHEL.NS', strategy: 'SepaBreakoutEOD', qty: 214, entry: 413.5, current: 420, pnl: 1391, pnlPct: 1.6, stop: 384.55 }], critic: { severity: 'INFO', critical: 0, warn: 0 } });
        const t = (0, snapshot_1.formatSnapshotText)(s);
        expect(t).toContain('Active trades (1):');
        expect(t).toContain('BHEL.NS (SepaBreakoutEOD) x214');
        expect(t).toContain('(+1.6%)');
        expect(t).toContain('[INFO]');
    });
    it('summarises the day activity and critic severity', () => {
        const s = Object.assign(Object.assign({}, base), { activity: { signals: 6, approved: 4, byStrategy: { SepaBreakoutEOD: 4, ATHPullbackEOD: 2 }, entryOrders: 4, entryFills: 0, exitFills: 1 }, critic: { severity: 'CRITICAL', critical: 1, warn: 1 } });
        const t = (0, snapshot_1.formatSnapshotText)(s);
        expect(t).toContain('6 signals (4 approved');
        expect(t).toContain('SepaBreakoutEOD:4');
        expect(t).toContain('4 orders, 0 entries / 1 exits filled');
        expect(t).toContain('[CRITICAL 1 crit 1 warn]');
    });
    it('shows an em-dash for missing current/pnl', () => {
        const s = Object.assign(Object.assign({}, base), { positions: [{ symbol: 'X.NS', strategy: 'ATHPullbackEOD', qty: 10, entry: 100, current: null, pnl: null, pnlPct: null, stop: 90 }] });
        const t = (0, snapshot_1.formatSnapshotText)(s);
        expect(t).toContain('X.NS (ATHPullbackEOD) x10 @ ₹100 -> —');
    });
});
//# sourceMappingURL=snapshot.test.js.map