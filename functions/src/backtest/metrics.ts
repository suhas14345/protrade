/**
 * Backtest metrics — pure functions, no Firestore/Firebase dependency.
 *
 * These are deliberately self-contained so they can be unit-tested directly and
 * reused by the replay engine. They mirror the annualisation conventions already
 * used in services/aggregateStats.ts (252 trading days, 6.5% risk-free rate).
 */

export const TRADING_DAYS_PER_YEAR = 252;
export const DEFAULT_RISK_FREE_ANNUAL = 0.065;

/** A single closed round-trip trade, reconstructed from fills by the engine. */
export interface ClosedTrade {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryDateId: string;
  exitDateId: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  fees: number;
  /** Net profit-and-loss in account currency (INR), fees included. */
  pnl: number;
  /** Realised return in R-multiples if a risk amount was known, else undefined. */
  rMultiple?: number;
  exitReason?: string;
  /** Originating strategy tag, used for per-strategy P&L attribution. */
  strategy?: string;
}

/** One point on the daily equity curve. */
export interface EquityPoint {
  dateId: string;
  equity: number;
}

export interface BacktestMetrics {
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  volatilityPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  mar: number;
  tradingDays: number;
  years: number;
  totalTrades: number;
  winRatePct: number;
  profitFactor: number;
  expectancyInr: number;
  avgWinInr: number;
  avgLossInr: number;
  grossProfitInr: number;
  grossLossInr: number;
  totalFeesInr: number;
}

/** Daily simple returns from an equity curve. */
export function dailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) out.push(equity[i] / prev - 1);
  }
  return out;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sampleStdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Annualised volatility (%) from daily returns. */
export function annualisedVolatility(returns: number[]): number {
  return sampleStdDev(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
}

/** Annualised Sharpe ratio. */
export function sharpeRatio(returns: number[], riskFreeAnnual = DEFAULT_RISK_FREE_ANNUAL): number {
  if (returns.length < 2) return 0;
  const rfDaily = riskFreeAnnual / TRADING_DAYS_PER_YEAR;
  const sd = sampleStdDev(returns);
  if (sd === 0) return 0;
  return ((mean(returns) - rfDaily) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Annualised Sortino ratio (downside deviation only). */
export function sortinoRatio(returns: number[], riskFreeAnnual = DEFAULT_RISK_FREE_ANNUAL): number {
  if (returns.length < 2) return 0;
  const rfDaily = riskFreeAnnual / TRADING_DAYS_PER_YEAR;
  const downside = returns.filter((r) => r < rfDaily);
  if (downside.length === 0) return 0;
  const dd = Math.sqrt(downside.reduce((a, b) => a + (b - rfDaily) * (b - rfDaily), 0) / returns.length);
  if (dd === 0) return 0;
  return ((mean(returns) - rfDaily) / dd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Peak-to-trough max drawdown as a positive fraction (0..1). */
export function maxDrawdown(equity: number[]): number {
  if (equity.length < 2) return 0;
  let peak = equity[0];
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/** Compound annual growth rate (%) given start/end equity and number of trading days. */
export function cagr(startEquity: number, endEquity: number, tradingDays: number): number {
  if (startEquity <= 0 || endEquity <= 0 || tradingDays <= 0) return 0;
  const years = tradingDays / TRADING_DAYS_PER_YEAR;
  if (years <= 0) return 0;
  return (Math.pow(endEquity / startEquity, 1 / years) - 1) * 100;
}

/** Compute the full metrics bundle from an equity curve and the list of closed trades. */
export function computeMetrics(curve: EquityPoint[], trades: ClosedTrade[]): BacktestMetrics {
  const equity = curve.map((p) => p.equity);
  const startEquity = equity[0] ?? 0;
  const endEquity = equity[equity.length - 1] ?? startEquity;
  const rets = dailyReturns(equity);
  const tradingDays = Math.max(0, curve.length - 1);
  const years = tradingDays / TRADING_DAYS_PER_YEAR;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a + t.pnl, 0); // negative
  const totalFees = trades.reduce((a, t) => a + t.fees, 0);
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);

  const dd = maxDrawdown(equity);
  const cagrPct = cagr(startEquity, endEquity, tradingDays);

  return {
    startEquity,
    endEquity,
    totalReturnPct: startEquity > 0 ? (endEquity / startEquity - 1) * 100 : 0,
    cagrPct,
    volatilityPct: annualisedVolatility(rets),
    sharpe: sharpeRatio(rets),
    sortino: sortinoRatio(rets),
    maxDrawdownPct: dd * 100,
    mar: dd > 0 ? cagrPct / (dd * 100) : 0,
    tradingDays,
    years,
    totalTrades: trades.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : (grossProfit > 0 ? Infinity : 0),
    expectancyInr: trades.length > 0 ? netPnl / trades.length : 0,
    avgWinInr: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossInr: losses.length > 0 ? grossLoss / losses.length : 0,
    grossProfitInr: grossProfit,
    grossLossInr: grossLoss,
    totalFeesInr: totalFees,
  };
}

/** Human-readable one-screen report. */
export function formatReport(m: BacktestMetrics): string {
  const pf = m.profitFactor === Infinity ? 'inf' : m.profitFactor.toFixed(2);
  const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');
  return [
    '================ BACKTEST RESULTS ================',
    `Period:          ${m.tradingDays} trading days (${m.years.toFixed(2)} yr)`,
    `Start equity:    ${inr(m.startEquity)}`,
    `End equity:      ${inr(m.endEquity)}`,
    `Total return:    ${m.totalReturnPct.toFixed(1)}%`,
    `CAGR:            ${m.cagrPct.toFixed(1)}%`,
    `Volatility:      ${m.volatilityPct.toFixed(1)}% (annualised)`,
    `Sharpe:          ${m.sharpe.toFixed(2)}`,
    `Sortino:         ${m.sortino.toFixed(2)}`,
    `Max drawdown:    ${m.maxDrawdownPct.toFixed(1)}%`,
    `MAR (CAGR/MaxDD):${m.mar.toFixed(2)}`,
    '-------------------------------------------------',
    `Trades:          ${m.totalTrades}`,
    `Win rate:        ${m.winRatePct.toFixed(1)}%`,
    `Profit factor:   ${pf}`,
    `Expectancy:      ${inr(m.expectancyInr)} / trade`,
    `Avg win:         ${inr(m.avgWinInr)}`,
    `Avg loss:        ${inr(m.avgLossInr)}`,
    `Gross profit:    ${inr(m.grossProfitInr)}`,
    `Gross loss:      ${inr(m.grossLossInr)}`,
    `Total fees:      ${inr(m.totalFeesInr)}`,
    '=================================================',
  ].join('\n');
}
