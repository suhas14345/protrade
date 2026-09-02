// Firestore Document Models for ProTrade V2.1

export interface CalendarDay {
  dateId: string; // YYYYMMDD
  isTradingDay: boolean;
  tradingIndex: number; // Monotonic integer for trading days
  prevTradingDateId?: string;
  nextTradingDateId?: string;
}

export interface Job {
  runDate: string; // YYYY-MM-DD
  universeId?: string; // operational default: midsmall400
  type: 'EOD_RUN' | 'OPEN_SIM_RUN' | 'DEEP_SYNC';
  stage: 'FETCH' | 'FEATURES' | 'REGIME' | 'CORR' | 'SIGNALS' | 'RISK' | 'ORDERS' | 'DONE';
  status: 'RUNNING' | 'FINALIZING' | 'FAILED' | 'DONE';
  counts: {
    total: number;
    done: number;
    failed: number;
  };
  startedAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
  marketState?: 'TREND' | 'RANGE' | 'HIGH_VOL' | 'TRANSITION' | 'BEAR';
  errorMessage?: string;
  dataSource?: 'KITE' | 'YAHOO';
  versionHash: string;
}

export interface UniverseMember {
  symbol: string;
  sector?: string;
  liquidityBucket?: 'A' | 'B' | 'C';
  instrumentToken?: string;
}

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: FirebaseFirestore.Timestamp;
  dateId?: string; // e.g. "20260319"
}

export interface Features {
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi14?: number;
  atr14?: number;
  atrp?: number;
  atrpMa100?: number;
  atrPct?: number; // legacy alias for atrp
  bbMid?: number;
  bbLower?: number;
  bbUpper?: number;
  // V2.4: Rolling 20-day high/low for breadth computation
  high20?: number;
  low20?: number;
  trendState?: 'UP' | 'DOWN' | 'RANGE';
  swing?: {
    lastSwingHigh: number;
    lastSwingLow: number;
  };
  srZones?: Array<{
    low: number;
    high: number;
    strength: number;
  }>;
  returns?: {
    ret1d: number;
    ret5d: number;
    ret20d: number;
    ret60d: number; // V2.2: used for RS ranking
  };
  barsCount?: number;
  volSma20?: number;
  liquidity?: {
    medVol20: number;
    medTradedValue20: number;
    bucket: 'A' | 'B' | 'C';
  };
  // V2.2: RS ranking, VDU, gap risk
  rsScore?: number;           // 0-99, filled by RS ranking pass after all features done
  vduActive?: boolean;        // Volume Dry-Up flag: institutional patience on pullback
  gapRiskScore?: number;      // 0-100 percentile: how gappy this stock is historically
  // SEPA (Minervini) fields — only populated when SEPA_CONFIG.SEPA_ONLY is true.
  sma50?: number;
  sma150?: number;
  sma200?: number;
  sma10?: number;             // VCP/IndiaPulse trend filter requirement
  vcpRange40?: number;        // VCP base range (max/min over 40d)
  vcpRange20?: number;        // VCP secondary range
  vcpRange10?: number;
  trend40Up?: boolean;
  trend20Up?: boolean;
  trend10Up?: boolean;        // VCP final pinch range
  sma200Rising?: boolean;     // 200-SMA higher than it was SMA200_SLOPE_LOOKBACK bars ago
  sma50Rising?: boolean;      // 50-SMA rising (IndiaPulse trend template)
  sma150Rising?: boolean;     // 150-SMA rising (IndiaPulse trend template)
  high252?: number;           // 52-week high of close
  low252?: number;            // 52-week low of close
  pctAboveLow252?: number;    // fraction above the 52-week low (IndiaPulse requires >= 0.30)
  athHigh?: number;           // true all-time high (running max of daily HIGH across all stored history)
  ret126?: number;            // 126-day momentum (close/close[-126] - 1)
  rsRank126?: number;         // cross-sectional rank by ret126 (1 = strongest), set by RS pass
  // VCP pivot / trigger fields (IndiaPulse-style)
  vcpPivot?: number;          // pivot = prior 50-session high (excludes the current bar)
  vcpStructuralLow?: number;  // final-contraction low (min low over last 10 sessions) — invalidation ref
  vcpDistToPivotPct?: number; // (close - pivot)/pivot: negative = below pivot, positive = above
  atrCompressing?: boolean;   // 14d ATR now < 14d ATR ~20 sessions ago
  vol10?: number;             // 10-day average volume
  vol50?: number;             // 50-day average volume
  volDryUpRatio?: number;     // vol10 / vol50 (< 1 = dry-up)
  vcpVolumeDryUp?: boolean;   // final pre-breakout contraction is materially quieter than its base
  vcpFinalVolume10?: number;  // avg volume in the 10 sessions immediately before the signal bar
  vcpBaseVolume40?: number;   // avg volume in the preceding 40-session base
  vcpVolumeRatio?: number;    // vcpFinalVolume10 / vcpBaseVolume40
  patterns?: string[];
  computedAt: FirebaseFirestore.Timestamp;
}

export interface Regime {
  marketState: 'TREND' | 'RANGE' | 'HIGH_VOL' | 'TRANSITION' | 'BEAR';
  tradeAllowed: boolean;
  riskMultiplier: number;
  maxNewPositions: number;
  minSignalScore: number;
  notes?: string;
  reason?: string;
  metrics?: {
    close: number;
    ema200: number;
    ema200Slope: number;
    ema20?: number;
  };
  breadth?: {
    pctAboveEMA50: number;
    pctAboveEMA200: number;
    newHighs20: number;
    newLows20: number;
    universeMedianRet20d?: number; // V2.2: used for RS score computation
    universeMedianRet60d?: number; // V2.2: used for RS score computation
  };
  persistenceDays?: number;
  regimeConfirmed?: boolean;
  rawState?: 'TREND' | 'RANGE' | 'HIGH_VOL' | 'TRANSITION' | 'BEAR'; // raw computed regime pre-hysteresis; drives confirmation counting
}

export interface Signal {
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy: 'PullbackEOD' | 'BreakoutCloseEOD' | 'ShortBounceEOD' | 'MeanReversionEOD' | 'BearBounceEOD' | 'RSLeaderEOD' | 'SepaBreakoutEOD' | 'MetalsRotation' | 'ATHPullbackEOD';
  score: number;
  entryPlan: {
    type: 'NEXT_OPEN' | 'LIMIT';
    // LIMIT entries: buy only if the next session trades into [limitLo, limitHi].
    limitLo?: number;
    limitHi?: number;
  };
  indicativeStopPrice: number;
  indicativeTargets: number[];
  indicativeRr: number;
  // Final values populated at Execution/Fill (Gap 4)
  stopPrice?: number;
  targets?: number[];
  rr?: number;
  checklist: Record<string, boolean>;
  reasons: Record<string, any>;
  status: 'NEW' | 'APPROVED' | 'REJECTED' | 'ORDERED' | 'IN_TRADE' | 'DONE' | 'REJECTED_BY_RISK' | 'CANCELLED';
  riskApproval?: {
    status: 'APPROVED' | 'REJECTED';
    sizedQty: number;
    riskAmount: number;
    reason?: string;
  };
  execution?: {
    status: 'ORDERED' | 'FILLED' | 'CANCELLED';
    orderId?: string;
    fillId?: string;
    entryPrice?: number;
    entryDateId?: string;
  };
  monitor?: {
    r1?: number;
    r3?: number;
    r5?: number;
    mfeR?: number;
    maeR?: number;
    hitStop?: boolean;
    hitTarget?: boolean;
  };
  features?: Features; // Attached features for EOD logic

  // v1.1 ATR-based Rules for Execution
  atrRef?: number;
  stopAtrMult?: number;
  targetAtrMult?: number;

  // V2.3: ADV check result
  advCheck?: {
    medVol20: number;
    maxQtyByAdv: number;
    capped: boolean;
  };
  // V2.3: Gap stress estimate
  gapStress?: {
    worstCaseLossInr: number;
    worstCaseLossR: number;
  };
}

export interface PaperOrder {
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'ENTRY' | 'EXIT'; // Gap B2 & B3 alignment
  intendedQty: number;
  intendedEntryRef: 'OPEN' | 'LIMIT';
  // LIMIT entries: fill only if the next session trades into [limitLo, limitHi].
  limitLo?: number;
  limitHi?: number;
  createdFromSignalId: string;
  risk: {
    plannedR: number;
    riskAmount: number;
    stopDistance: number;
  };
  status: 'CREATED' | 'ACCEPTED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  exitType?: PaperFill['fillType']; // Gap B3 alignment
  parentPositionPath?: string;
  jobId?: string;
  createdAt?: FirebaseFirestore.Timestamp;
}

export interface PaperFill {
  orderId: string;
  symbol: string;
  /** Cash direction of this fill: BUY = cash out, SELL = cash in. Enables an
   *  independent cash-flow reconciliation of the ledger. */
  side: 'BUY' | 'SELL';
  fillPrice: number;
  fillQty: number;
  slippageBps: number;
  feeEstimate: number;
  fillType: 'ENTRY' | 'EXIT_STOP' | 'EXIT_TARGET' | 'EXIT_TIME' | 'EXIT_THESIS' | 'PARTIAL_PROFIT';
  timestamp: FirebaseFirestore.Timestamp;
}

export interface PaperPosition {
  symbol: string;
  avgEntryPrice: number;
  qty: number;
  stopPrice: number;
  targets: number[];
  status: 'OPEN' | 'CLOSED';
  unrealizedPnl: number;
  realizedPnl: number;
  openedAt: FirebaseFirestore.Timestamp;
  closedAt?: FirebaseFirestore.Timestamp;
  lastUpdatedAt: FirebaseFirestore.Timestamp;
  entryFillId: string;
  exitFillId?: string;
  exitReason?: PaperFill['fillType'];
  
  // V1.1 Enhanced Tracking
  direction: 'BUY' | 'SELL';
  atrAtEntry?: number;
  partialTaken?: boolean;
  mfeAtr?: number;
  entryDateId?: string;
  riskAmount?: number;
  signalId?: string;
  signalPath?: string;

  // V2.3: Strategy-aware exit profile
  strategy?: string;
  trailingStopActive?: boolean;
  trailingStopPrice?: number;      // Current trailing stop level
  worstCaseGapLoss?: number;       // Estimated loss under gap stress scenario (INR)
  worstCaseGapLossR?: number;      // Same in R-multiple units
  // SEPA trailing state (only used by SepaBreakoutEOD positions)
  sepaHH?: number;                 // highest close observed since entry
  sepaLockActive?: boolean;        // trailing lock armed once gain >= LOCK_AT_PCT

  // V3.1: fee/qty basis needed to attribute entry cost across (partial) exits
  entryFee?: number;               // total fee paid on entry fill
  entryQty?: number;               // original entry quantity (constant; qty decrements on partials)
  exitPrice?: number;              // fill price of the closing exit
  exitDateId?: string;             // dateId of the closing exit

  // Daily mark-to-market (written by persistOpenPositionMarks; reconciles to config/account)
  currentPrice?: number;           // close the position was last marked to
  unrealizedPnlPct?: number;       // unrealizedPnl / entry cost
  markDateId?: string;             // dateId of the last mark-to-market
}

/**
 * V3.1: Immutable, append-only realised round-trip record, written on every exit
 * fill (partial or full) to portfolio/default/trades/{exitFillId}. Unlike the
 * per-symbol position doc (which is overwritten on re-entry), this survives so the
 * complete P&L history — live or backtest — is never lost.
 */
export interface PaperTrade {
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy?: string;
  entryDateId: string;
  exitDateId: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** exit fee + prorated share of the entry fee for this quantity */
  fees: number;
  /** net realised P&L for this exit, fees included */
  realizedPnl: number;
  rMultiple?: number;
  exitReason?: PaperFill['fillType'];
  entryFillId?: string;
  exitFillId: string;
  closedAt: FirebaseFirestore.Timestamp;
}

export interface Trade {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  entryDateId: string;
  exitPrice?: number;
  exitDateId?: string;
  qty: number;
  pnl: number;
  rMultiple: number;
  status: 'OPEN' | 'CLOSED';
  exitReason?: PaperFill['fillType'];
  mfeR: number;
  maeR: number;
}

export interface AccountConfig {
  equity: number;
  baseRiskPct: number;
  maxOpenRiskR: number;
  maxPositions: number;
  strategyRiskWeights: Record<string, number>;
  peakEquity?: number;        // V2.2: for drawdown multiplier computation
  equityEMA25?: number;       // V2.2: 25-day EMA of equity for curve filter
  portfolioRealizedVol?: number; // V2.3: 20-day realized portfolio volatility (annualized)
  initialEquity?: number;     // immutable deposited capital (equity anchor)
  realizedPnl?: number;       // cumulative realised P&L (trades ledger)
  openUnrealized?: number;    // mark-to-market of open positions
  cashBalance?: number;       // settled cash available to deploy = initialEquity + realizedPnl - deployedCost
}

// V2.3: Event calendar entry
export interface EventInfo {
  symbol: string;
  eventType: 'EARNINGS' | 'CORPORATE_ACTION' | 'FNO_BAN' | 'INDEX_REBALANCE';
  eventDateId: string;         // YYYYMMDD
  description?: string;
  blockEntry: boolean;
  blockShort: boolean;
}

// V2.3: Reconciliation record
export interface ReconciliationRecord {
  dateId: string;
  symbol: string;
  expectedSlippageBps: number;
  actualSlippageBps?: number;
  expectedFillPrice: number;
  actualFillPrice?: number;
  discrepancyBps: number;
  status: 'PENDING' | 'MATCHED' | 'DISCREPANT';
}

// Phase 1a: canonical, source-agnostic financial statement fed to the earnings-quality
// detector. A normalizing adapter maps raw XBRL/vendor payloads into this shape so the
// detector stays pure and vendor-swappable. Margins and promoter-pledge are fractions
// of 1 (e.g. 0.18 = 18%), NOT 0–100. Amounts are in a single consistent currency unit.
export interface FinancialStatement {
  symbol: string;
  period: string;              // '2026Q1' | 'FY2026'
  filedAt: string;             // ISO date — stored point-in-time (no look-ahead backfill)
  isFinancial?: boolean;       // banks/NBFCs: revenue/other-income/tax flags are skipped
  revenueFromOps?: number;     // core operating revenue
  otherIncome?: number;        // treasury / non-core income
  totalRevenue?: number;       // revenueFromOps + otherIncome (as reported)
  exceptionalItems?: number;   // signed; both gains and write-offs distort
  pbt?: number;                // profit before tax
  tax?: number;                // total tax expense
  netProfit?: number;          // profit after tax
  netMargin?: number;          // optional precomputed; else derived from netProfit/revenue
  prevNetMargin?: number;      // prior comparable period net margin (for spike detection)
  prevRevenueFromOps?: number; // prior comparable period core revenue (for growth context)
  promoterPledge?: number;     // fraction of promoter holding pledged (0–1)
  prevPromoterPledge?: number; // prior period promoter pledge fraction (0–1)
}

export type EarningsQualityFlagSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type EarningsQualityStatus = 'CLEAN' | 'WATCH' | 'FLAGGED' | 'UNKNOWN';

export interface EarningsQualityFlag {
  code: string;                        // stable machine code, e.g. 'OTHER_INCOME_DEPENDENCE'
  severity: EarningsQualityFlagSeverity;
  value: number;                       // the computed ratio/delta that tripped the flag
  threshold: number;                   // the configured limit it breached
  message: string;                     // human-readable summary for the dashboard badge
}

export interface EarningsQualityResult {
  status: EarningsQualityStatus;       // CLEAN | WATCH (warn) | FLAGGED (critical) | UNKNOWN (no data)
  flags: EarningsQualityFlag[];
  evaluated: boolean;                  // whether at least one check had enough data to run
}

// Phase 1a: persisted per-symbol quality snapshot (point-in-time). Non-gating for now —
// surfaced as a dashboard badge; a later phase promotes CRITICAL flags to a SEPA veto.
export interface FundamentalsQualityDoc {
  symbol: string;
  period: string;
  filedAt: string;
  source: string;                      // adapter name the statement came from
  status: EarningsQualityStatus;
  flags: EarningsQualityFlag[];
  computedAt: FirebaseFirestore.Timestamp;
}

