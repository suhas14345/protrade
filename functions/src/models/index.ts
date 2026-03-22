// Firestore Document Models for ProTrade V2.1

export interface Job {
  runDate: string; // YYYY-MM-DD
  universeId?: string; // nifty50, nifty500
  type: 'EOD_RUN' | 'OPEN_SIM_RUN';
  stage: 'FETCH' | 'FEATURES' | 'REGIME' | 'CORR' | 'SIGNALS' | 'RISK' | 'ORDERS' | 'DONE';
  status: 'RUNNING' | 'FAILED' | 'DONE';
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
  };
  barsCount?: number; // Added for dashboard inventory grouping
  liquidity?: {
    medVol20: number;
    medTradedValue20: number;
    bucket: 'A' | 'B' | 'C';
  };
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
  };
}

export interface Signal {
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategy: 'PullbackEOD' | 'BreakoutCloseEOD' | 'ShortBounceEOD' | 'MeanReversionEOD';
  score: number;
  entryPlan: {
    type: 'NEXT_OPEN';
  };
  stopPrice: number;
  targets: number[];
  rr: number;
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
}

export interface PaperOrder {
  symbol: string;
  side: 'BUY';
  orderType: 'NEXT_OPEN';
  intendedQty: number;
  intendedEntryRef: 'OPEN';
  createdFromSignalId: string;
  risk: {
    plannedR: number;
    riskAmount: number;
    stopDistance: number;
  };
  status: 'CREATED' | 'ACCEPTED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
}

export interface PaperFill {
  orderId: string;
  symbol: string;
  fillPrice: number;
  fillQty: number;
  slippageBps: number;
  feeEstimate: number;
  fillType: 'ENTRY' | 'EXIT_STOP' | 'EXIT_TARGET' | 'EXIT_TIME' | 'EXIT_THESIS';
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
}
