"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const eodhdAdapter_1 = require("../eodhdAdapter");
describe('mapEodhdToStatement', () => {
    const payload = {
        General: { Sector: 'Technology', Industry: 'Software' },
        Financials: {
            Income_Statement: {
                quarterly: {
                    '2026-06-30': {
                        date: '2026-06-30',
                        filing_date: '2026-07-31',
                        totalRevenue: '1000000000.00',
                        totalOtherIncomeExpenseNet: '50000000.00',
                        incomeBeforeTax: '200000000.00',
                        incomeTaxExpense: '52000000.00',
                        netIncome: '148000000.00',
                        nonRecurring: null,
                    },
                    '2026-03-31': {
                        date: '2026-03-31',
                        filing_date: '2026-04-30',
                        totalRevenue: '900000000.00',
                        totalOtherIncomeExpenseNet: '40000000.00',
                        incomeBeforeTax: '170000000.00',
                        incomeTaxExpense: '44000000.00',
                        netIncome: '126000000.00',
                    },
                },
            },
        },
    };
    it('maps the latest quarter into a canonical statement', () => {
        const stmt = (0, eodhdAdapter_1.mapEodhdToStatement)('INFY.NS', payload);
        expect(stmt).not.toBeNull();
        expect(stmt.symbol).toBe('INFY.NS');
        expect(stmt.period).toBe('2026-06-30');
        expect(stmt.filedAt).toBe('2026-07-31');
        expect(stmt.revenueFromOps).toBe(1000000000);
        expect(stmt.otherIncome).toBe(50000000);
        expect(stmt.totalRevenue).toBe(1050000000);
        expect(stmt.pbt).toBe(200000000);
        expect(stmt.tax).toBe(52000000);
        expect(stmt.netProfit).toBe(148000000);
        expect(stmt.isFinancial).toBe(false);
        expect(stmt.prevRevenueFromOps).toBe(900000000);
        expect(stmt.prevNetMargin).toBeCloseTo(0.14);
    });
    it('detects financial-sector companies', () => {
        const fin = (0, eodhdAdapter_1.mapEodhdToStatement)('HDFCBANK.NS', Object.assign(Object.assign({}, payload), { General: { Sector: 'Financial Services', Industry: 'Banks' } }));
        expect(fin.isFinancial).toBe(true);
    });
    it('returns null when no income statement is present', () => {
        expect((0, eodhdAdapter_1.mapEodhdToStatement)('X.NS', {})).toBeNull();
        expect((0, eodhdAdapter_1.mapEodhdToStatement)('X.NS', { Financials: { Income_Statement: { quarterly: {} } } })).toBeNull();
    });
    it('tolerates null/missing line items without throwing', () => {
        const sparse = { Financials: { Income_Statement: { quarterly: { '2026-06-30': { date: '2026-06-30', netIncome: null } } } } };
        const stmt = (0, eodhdAdapter_1.mapEodhdToStatement)('X.NS', sparse);
        expect(stmt.period).toBe('2026-06-30');
        expect(stmt.netProfit).toBeUndefined();
    });
});
describe('EodhdFundamentalsSource.toEodhdSymbol', () => {
    const src = new eodhdAdapter_1.EodhdFundamentalsSource('k');
    it('maps NSE .NS symbols to EODHD .NSE', () => {
        expect(src.toEodhdSymbol('INFY.NS')).toBe('INFY.NSE');
        expect(src.toEodhdSymbol('GOLDBEES')).toBe('GOLDBEES.NSE');
    });
});
//# sourceMappingURL=eodhdAdapter.test.js.map