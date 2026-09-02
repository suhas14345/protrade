"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EodhdFundamentalsSource = void 0;
exports.mapEodhdToStatement = mapEodhdToStatement;
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
const toNum = (v) => {
    const x = typeof v === 'string' ? parseFloat(v) : v;
    return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
};
/**
 * Pure mapper: EODHD /fundamentals JSON → canonical FinancialStatement (latest quarter).
 * Exported for unit testing against captured EODHD payloads.
 *
 * EODHD approximations (documented, since EODHD's income statement is a US-style layout):
 *  - revenueFromOps ← totalRevenue (net sales / operating revenue).
 *  - otherIncome    ← totalOtherIncomeExpenseNet (closest non-core line).
 *  - totalRevenue   ← revenueFromOps + otherIncome (so the revenue-mix flag is meaningful).
 *  - exceptionalItems ← nonRecurring ?? extraordinaryItems ?? discontinuedOperations.
 *  - promoter pledge is NOT provided by EODHD → governance CRITICAL flags stay dormant.
 */
function mapEodhdToStatement(symbol, data) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    const inc = (_b = (_a = data === null || data === void 0 ? void 0 : data.Financials) === null || _a === void 0 ? void 0 : _a.Income_Statement) === null || _b === void 0 ? void 0 : _b.quarterly;
    if (!inc || typeof inc !== 'object')
        return null;
    const dates = Object.keys(inc).sort().reverse();
    if (dates.length === 0)
        return null;
    const latest = inc[dates[0]];
    const prev = dates[1] ? inc[dates[1]] : undefined;
    if (!latest)
        return null;
    const sector = String((_d = (_c = data === null || data === void 0 ? void 0 : data.General) === null || _c === void 0 ? void 0 : _c.Sector) !== null && _d !== void 0 ? _d : '');
    const industry = String((_f = (_e = data === null || data === void 0 ? void 0 : data.General) === null || _e === void 0 ? void 0 : _e.Industry) !== null && _f !== void 0 ? _f : '');
    const isFinancial = /financ|bank|insurance|nbfc/i.test(`${sector} ${industry}`);
    const opRev = toNum(latest.totalRevenue);
    const otherIncome = toNum(latest.totalOtherIncomeExpenseNet);
    const totalRevenue = opRev !== undefined ? opRev + (otherIncome !== null && otherIncome !== void 0 ? otherIncome : 0) : undefined;
    const netProfit = toNum(latest.netIncome);
    const prevOpRev = prev ? toNum(prev.totalRevenue) : undefined;
    const prevNet = prev ? toNum(prev.netIncome) : undefined;
    const prevNetMargin = prevNet !== undefined && prevOpRev ? prevNet / prevOpRev : undefined;
    const stmt = {
        symbol,
        period: String((_g = latest.date) !== null && _g !== void 0 ? _g : dates[0]),
        filedAt: String((_j = (_h = latest.filing_date) !== null && _h !== void 0 ? _h : latest.date) !== null && _j !== void 0 ? _j : dates[0]),
        isFinancial,
        revenueFromOps: opRev,
        otherIncome,
        totalRevenue,
        exceptionalItems: (_l = (_k = toNum(latest.nonRecurring)) !== null && _k !== void 0 ? _k : toNum(latest.extraordinaryItems)) !== null && _l !== void 0 ? _l : toNum(latest.discontinuedOperations),
        pbt: toNum(latest.incomeBeforeTax),
        tax: (_m = toNum(latest.incomeTaxExpense)) !== null && _m !== void 0 ? _m : toNum(latest.taxProvision),
        netProfit,
        prevNetMargin,
        prevRevenueFromOps: prevOpRev,
    };
    return stmt;
}
/**
 * EODHD fundamentals source. Requires a paid EODHD plan with India coverage (the free/demo
 * token returns 403 for .NSE). Reads the key from settings/fundamentals.eodhdApiKey or the
 * EODHD_API_KEY env. Fail-soft: any error/miss yields null (⇒ UNKNOWN), never a throw.
 */
class EodhdFundamentalsSource {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.name = 'eodhd';
    }
    static async fromSettings() {
        var _a;
        const snap = await getDb().collection('settings').doc('fundamentals').get();
        const key = (snap.exists ? (_a = snap.data()) === null || _a === void 0 ? void 0 : _a.eodhdApiKey : undefined) || process.env.EODHD_API_KEY;
        return key ? new EodhdFundamentalsSource(key) : null;
    }
    /** SYMBOL.NS → SYMBOL.NSE; bare NSE symbols (e.g. GOLDBEES) → SYMBOL.NSE. */
    toEodhdSymbol(symbol) {
        const base = symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol;
        return `${base}.NSE`;
    }
    async fetchLatestStatement(symbol) {
        try {
            const url = `https://eodhd.com/api/fundamentals/${encodeURIComponent(this.toEodhdSymbol(symbol))}?api_token=${this.apiKey}&fmt=json`;
            const res = await fetch(url, { headers: { accept: 'application/json' } });
            if (!res.ok)
                return null;
            const data = await res.json();
            return mapEodhdToStatement(symbol, data);
        }
        catch (_a) {
            return null;
        }
    }
}
exports.EodhdFundamentalsSource = EodhdFundamentalsSource;
//# sourceMappingURL=eodhdAdapter.js.map