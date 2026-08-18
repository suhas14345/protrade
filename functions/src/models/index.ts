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
  universeId?: string; // nifty50, nifty500
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
  sma200Rising?: boolean;     // 200-SMA higher than it was SMA200_SLOPE_LOOKBACK bars ago
  high252?: number;           // 52-week high of close
  ret126?: number;            // 126-day momentum (close/close[-126] - 1)
  rsRank126?: number;         // cross-sectional rank by ret126 (1 = strongest), set by RS pass
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
  strategy: 'PullbackEOD' | 'BreakoutCloseEOD' | 'ShortBounceEOD' | 'MeanReversionEOD' | 'BearBounceEOD' | 'RSLeaderEOD' | 'SepaBreakoutEOD' | 'MetalsRotation';
  score: number;
  entryPlan: {
    type: 'NEXT_OPEN';
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
  intendedEntryRef: 'OPEN';
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
