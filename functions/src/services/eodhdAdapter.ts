import * as admin from 'firebase-admin';
import { FinancialStatement } from '../models';
import { FundamentalsSource } from './earningsQuality';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

const toNum = (v: unknown): number | undefined => {
  const x = typeof v === 'string' ? parseFloat(v) : (v as number);
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
export function mapEodhdToStatement(symbol: string, data: any): FinancialStatement | null {
  const inc = data?.Financials?.Income_Statement?.quarterly;
  if (!inc || typeof inc !== 'object') return null;
  const dates = Object.keys(inc).sort().reverse();
  if (dates.length === 0) return null;

  const latest = inc[dates[0]];
  const prev = dates[1] ? inc[dates[1]] : undefined;
  if (!latest) return null;

  const sector = String(data?.General?.Sector ?? '');
  const industry = String(data?.General?.Industry ?? '');
  const isFinancial = /financ|bank|insurance|nbfc/i.test(`${sector} ${industry}`);

  const opRev = toNum(latest.totalRevenue);
  const otherIncome = toNum(latest.totalOtherIncomeExpenseNet);
  const totalRevenue = opRev !== undefined ? opRev + (otherIncome ?? 0) : undefined;
  const netProfit = toNum(latest.netIncome);

  const prevOpRev = prev ? toNum(prev.totalRevenue) : undefined;
  const prevNet = prev ? toNum(prev.netIncome) : undefined;
  const prevNetMargin = prevNet !== undefined && prevOpRev ? prevNet / prevOpRev : undefined;

  const stmt: FinancialStatement = {
    symbol,
    period: String(latest.date ?? dates[0]),
    filedAt: String(latest.filing_date ?? latest.date ?? dates[0]),
    isFinancial,
    revenueFromOps: opRev,
    otherIncome,
    totalRevenue,
    exceptionalItems: toNum(latest.nonRecurring) ?? toNum(latest.extraordinaryItems) ?? toNum(latest.discontinuedOperations),
    pbt: toNum(latest.incomeBeforeTax),
    tax: toNum(latest.incomeTaxExpense) ?? toNum(latest.taxProvision),
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
export class EodhdFundamentalsSource implements FundamentalsSource {
  readonly name = 'eodhd';
  constructor(private readonly apiKey: string) {}

  static async fromSettings(): Promise<EodhdFundamentalsSource | null> {
    const snap = await getDb().collection('settings').doc('fundamentals').get();
    const key = (snap.exists ? (snap.data() as { eodhdApiKey?: string })?.eodhdApiKey : undefined) || process.env.EODHD_API_KEY;
    return key ? new EodhdFundamentalsSource(key) : null;
  }

  /** SYMBOL.NS → SYMBOL.NSE; bare NSE symbols (e.g. GOLDBEES) → SYMBOL.NSE. */
  toEodhdSymbol(symbol: string): string {
    const base = symbol.endsWith('.NS') ? symbol.slice(0, -3) : symbol;
    return `${base}.NSE`;
  }

  async fetchLatestStatement(symbol: string): Promise<FinancialStatement | null> {
    try {
      const url = `https://eodhd.com/api/fundamentals/${encodeURIComponent(this.toEodhdSymbol(symbol))}?api_token=${this.apiKey}&fmt=json`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      return mapEodhdToStatement(symbol, data);
    } catch {
      return null;
    }
  }
}
