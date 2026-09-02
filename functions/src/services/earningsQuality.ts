import {
  FinancialStatement,
  EarningsQualityFlag,
  EarningsQualityResult,
  EarningsQualityStatus,
} from '../models';
import { EARNINGS_QUALITY_CONFIG } from '../config/runtime';

/**
 * Phase 1a — Minervini earnings-quality red-flag detector.
 *
 * A pure VETO/DOWNGRADE layer (separate from the positive growth scorer): it inspects
 * as-reported filings for accounting/governance irregularities. No consensus estimates
 * are required, so it works on the free XBRL actuals available for NSE names.
 *
 * Design notes:
 *  - Pure and side-effect free (mirrors computeVcpVolumeDryUp) so it is unit-testable and
 *    the data source can be swapped behind FundamentalsSource without touching this logic.
 *  - Sector-aware: banks/NBFCs (isFinancial) legitimately earn most income as interest and
 *    "other income", so the revenue-mix / other-income / tax flags are skipped for them.
 *  - Fail-soft on missing data: returns UNKNOWN (never fabricates a CLEAN) when nothing can
 *    be evaluated — small-cap filings are patchy, so absence of data must not read as safe.
 */
export function computeEarningsQuality(
  stmt: FinancialStatement,
  config = EARNINGS_QUALITY_CONFIG,
): EarningsQualityResult {
  const flags: EarningsQualityFlag[] = [];
  let evaluated = false;

  const isFin = stmt.isFinancial === true;
  const num = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const pbt = num(stmt.pbt);
  const netProfit = num(stmt.netProfit);
  const exceptional = num(stmt.exceptionalItems);
  const otherIncome = num(stmt.otherIncome);
  const totalRevenue = num(stmt.totalRevenue);
  const revenueFromOps = num(stmt.revenueFromOps);
  const tax = num(stmt.tax);

  // --- Exceptional / extraordinary items distort profit (both gains and write-offs) ---
  if (exceptional !== undefined && pbt !== undefined && pbt !== 0) {
    evaluated = true;
    const ratio = Math.abs(exceptional) / Math.abs(pbt);
    if (ratio > config.EXCEPTIONAL_PBT_MAX_PCT) {
      flags.push({
        code: 'EXCEPTIONAL_ITEMS',
        severity: 'WARN',
        value: ratio,
        threshold: config.EXCEPTIONAL_PBT_MAX_PCT,
        message: `Exceptional items are ${(ratio * 100).toFixed(0)}% of PBT`,
      });
    }
  }

  // --- Profit leaning on non-core "other income" rather than sales (skip financials) ---
  if (!isFin && otherIncome !== undefined && pbt !== undefined && pbt > 0) {
    evaluated = true;
    const ratio = otherIncome / pbt;
    if (ratio > config.OTHER_INCOME_PBT_MAX_PCT) {
      flags.push({
        code: 'OTHER_INCOME_DEPENDENCE',
        severity: 'WARN',
        value: ratio,
        threshold: config.OTHER_INCOME_PBT_MAX_PCT,
        message: `Other income is ${(ratio * 100).toFixed(0)}% of PBT`,
      });
    }
  }

  // --- Non-core revenue creep: operating revenue is a small share of total (skip financials) ---
  if (!isFin && revenueFromOps !== undefined && totalRevenue !== undefined && totalRevenue > 0) {
    evaluated = true;
    const share = revenueFromOps / totalRevenue;
    if (share < config.REVENUE_FROM_OPS_MIN_PCT) {
      flags.push({
        code: 'LOW_REVENUE_FROM_OPS',
        severity: 'WARN',
        value: share,
        threshold: config.REVENUE_FROM_OPS_MIN_PCT,
        message: `Only ${(share * 100).toFixed(0)}% of revenue is from operations`,
      });
    }
  }

  // --- Abnormally low effective tax inflating net profit (skip financials) ---
  if (!isFin && tax !== undefined && pbt !== undefined && pbt > 0) {
    evaluated = true;
    const rate = tax / pbt;
    if (rate < config.EFFECTIVE_TAX_MIN_PCT) {
      flags.push({
        code: 'LOW_EFFECTIVE_TAX',
        severity: 'WARN',
        value: rate,
        threshold: config.EFFECTIVE_TAX_MIN_PCT,
        message: `Effective tax rate is ${(rate * 100).toFixed(0)}%`,
      });
    }
  }

  // --- Margin spike not backed by revenue growth (likely a one-off) ---
  const revenueBase = revenueFromOps ?? totalRevenue;
  const netMargin =
    num(stmt.netMargin) ??
    (netProfit !== undefined && revenueBase !== undefined && revenueBase > 0
      ? netProfit / revenueBase
      : undefined);
  const prevNetMargin = num(stmt.prevNetMargin);
  const prevRevenueFromOps = num(stmt.prevRevenueFromOps);
  if (netMargin !== undefined && prevNetMargin !== undefined) {
    const marginDelta = netMargin - prevNetMargin;
    const revGrowth =
      prevRevenueFromOps !== undefined && prevRevenueFromOps > 0 && revenueFromOps !== undefined
        ? revenueFromOps / prevRevenueFromOps - 1
        : undefined;
    const revenueQuiet = revGrowth === undefined || revGrowth < config.MARGIN_SPIKE_MAX_REV_GROWTH;
    if (marginDelta > config.MARGIN_SPIKE_MAX_DELTA && revenueQuiet) {
      evaluated = true;
      flags.push({
        code: 'MARGIN_SPIKE',
        severity: 'WARN',
        value: marginDelta,
        threshold: config.MARGIN_SPIKE_MAX_DELTA,
        message: `Net margin jumped ${(marginDelta * 100).toFixed(0)}pp without matching revenue growth`,
      });
    }
  }

  // --- Governance: promoter share pledge (absolute level and QoQ increase) ---
  const pledge = num(stmt.promoterPledge);
  const prevPledge = num(stmt.prevPromoterPledge);
  if (pledge !== undefined) {
    evaluated = true;
    if (pledge >= config.PLEDGE_ABS_CRITICAL) {
      flags.push({
        code: 'PROMOTER_PLEDGE_HIGH',
        severity: 'CRITICAL',
        value: pledge,
        threshold: config.PLEDGE_ABS_CRITICAL,
        message: `${(pledge * 100).toFixed(0)}% of promoter holding is pledged`,
      });
    }
    if (prevPledge !== undefined) {
      const delta = pledge - prevPledge;
      if (delta > config.PLEDGE_INCREASE_MAX_DELTA) {
        flags.push({
          code: 'PROMOTER_PLEDGE_INCREASE',
          severity: 'CRITICAL',
          value: delta,
          threshold: config.PLEDGE_INCREASE_MAX_DELTA,
          message: `Promoter pledge rose ${(delta * 100).toFixed(0)}pp this period`,
        });
      }
    }
  }

  let status: EarningsQualityStatus;
  if (!evaluated) status = 'UNKNOWN';
  else if (flags.some((f) => f.severity === 'CRITICAL')) status = 'FLAGGED';
  else if (flags.some((f) => f.severity === 'WARN')) status = 'WATCH';
  else status = 'CLEAN';

  return { status, flags, evaluated };
}

/**
 * Source adapter seam: a normalizing provider that maps a raw XBRL/vendor payload into the
 * canonical FinancialStatement. Kept as an interface so BSE/NSE XBRL can be swapped for a
 * paid feed (EODHD/FMP) later without touching computeEarningsQuality.
 */
export interface FundamentalsSource {
  readonly name: string;
  fetchLatestStatement(symbol: string): Promise<FinancialStatement | null>;
}

/**
 * Placeholder source used until a real XBRL/vendor adapter is wired in. Returns null so the
 * detector reports UNKNOWN (fail-soft) rather than fabricating quality data.
 */
export const nullFundamentalsSource: FundamentalsSource = {
  name: 'none',
  async fetchLatestStatement(): Promise<FinancialStatement | null> {
    return null;
  },
};
