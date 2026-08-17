export const RUNTIME_CONFIG = {
  TRADING_ENABLED: true,
  PAPER_ONLY: true,
  MAX_DATA_STALENESS_MINUTES: 300,    // V3: 5 hours — production-safe (rejects stale data)
  MAX_DAILY_NEW_ENTRIES: 5,
  USE_WEEKLY_BIAS: false,
  MODE: 'PAPER_LIVE' as 'LIVE' | 'PAPER_LIVE' | 'BACKFILL' | 'REPLAY',
  EXIT_EXECUTION_MODEL: 'NEXT_OPEN' as 'NEXT_OPEN' | 'EOD_CLOSE',
  KILL_SWITCH: false,                  // V3: Emergency halt — blocks ALL new entries when true
};

// SEPA (Minervini-style) faithful port. When SEPA_ONLY is true the signal engine
// runs the SEPA strategy (alongside the metals sleeve) and the legacy multi-
// strategy equity path is bypassed. This is now the LIVE daily configuration —
// defaults ON. Set env SEPA_ONLY=0 to fall back to the legacy multi-strategy path.
export const SEPA_CONFIG = {
  SEPA_ONLY: process.env.SEPA_ONLY !== '0',
  FEATURE_WINDOW: 260,          // trailing bars needed for SMA150/200 + 52w-high + 200-slope
  RS_TOP: 40,                   // RS leadership: only the top-N by 126d momentum qualify
  RS_LOOKBACK: 126,             // momentum lookback (trading days)
  HI_PROX: 0.15,                // entry must be within 15% of the 52-week high
  HARD_STOP_PCT: 0.07,          // 7% initial hard stop
  LOCK_AT_PCT: 0.15,            // arm the trailing lock once up this much
  TRAIL_PCT: 0.20,              // trail 20% below the highest close once locked
  RISK_PCT: 0.0125,             // risk 1.25% of equity per trade
  MAX_POS: 10,                  // max concurrent SEPA positions (take the strongest leaders)
  SMA200_SLOPE_LOOKBACK: 20,    // bars back used to confirm the 200-SMA is rising
  THROTTLE_HALT_PCT: 0.06,      // equity-curve throttle: no new buys beyond this drawdown-from-peak
  BOOK_PCT: 0.70,               // SEPA capital book: gross deployed capital capped at this fraction of
                                // equity (metals sleeve gets the rest via ALLOC_PCT). Prevents the two
                                // strategies from jointly committing > 100% of equity (implicit leverage).
};

// Metals rotation sleeve — a small, self-contained trend-following ETF strategy
// that runs ALONGSIDE SEPA (not exclusive). It trades only the whitelisted metal
// ETFs (gold/silver), which are deliberately exempt from the equity liquidity/risk
// gates that would otherwise exclude them. Now part of the LIVE daily configuration
// — defaults ON. Set env METALS=0 to disable the sleeve. Sizing is deliberately
// modest (ALLOC_PCT): a blind walk-forward showed the sleeve is a genuine, drawdown-
// aware trend edge but earns single-digit CAGR long-run and trails gold buy&hold —
// the huge in-sample result was the 2024-25 metals regime, not a durable edge.
export const METALS_CONFIG = {
  ENABLED: process.env.METALS !== '0',
  SYMBOLS: ['GOLDBEES', 'SILVERBEES'],  // whitelisted metal ETFs (bare NSE symbols)
  FEATURE_WINDOW: 360,          // trailing bars: 200-SMA + 126d momentum + 21d skip buffer
  SMA_TREND: 200,               // trend gate: only hold while close > this SMA
  MOM_LOOKBACK: 126,            // risk-adjusted momentum lookback (trading days)
  MOM_SKIP: 21,                 // skip the most recent month (avoid 1m mean-reversion)
  MIN_RA_MOM: 0,                // require positive risk-adjusted momentum to enter
  MAX_POS: 2,                   // at most this many metal ETFs held concurrently
  ALLOC_PCT: 0.30,             // sleeve capital budget as a fraction of account equity
  HARD_STOP_PCT: 0.25,          // wide protective floor; the real exit is the trend gate
};

export const STRATEGY_V11 = {
  EMA_TOUCH_ATR_MULT: 0.3,
  BREAKOUT_VOL_MULT: 1.2,
  RANGE_TREND_NEUTRAL_MAX: 0.01,
  EARNINGS_BLOCK_DAYS: 2,
  ENABLE_EARNINGS_BLOCK: true,
  HIGH_VOL_SHORT_TARGET_ATR: 2.0,
  TIME_STOP_DAYS: 5,
  TIME_STOP_PROGRESS_ATR: 1.0,
  PARTIAL_PROFIT_ENABLED: true,
  PARTIAL_PROFIT_ATR: 1.5,
  PARTIAL_PROFIT_FRACTION: 0.33,
};

// V2.2: Correlation cluster caps
export const CORR_CONFIG = {
  LOOKBACK_DAYS: 60,            // Rolling window for Pearson correlation
  THRESHOLD: 0.75,              // Min correlation to classify as same cluster
  TOP_N: 20,                    // Store top-N most correlated peers per symbol
  MAX_POSITIONS_PER_CLUSTER: 2, // Max open positions in a correlated cluster
  MAX_CLUSTER_RISK_R: 1.5,      // Max total risk (in R) across a cluster
};

// V2.2: Relative Strength (RS) rank thresholds
export const RS_CONFIG = {
  MIN_RS_SCORE: 60,           // Reject signals below this RS rank (0-99)
  BREAKOUT_MIN_RS_SCORE: 70,  // Breakouts need stronger relative strength
  BOOST_THRESHOLD: 80,        // Add +5 to signal score at this level
  ELITE_THRESHOLD: 90,        // Add +10 to signal score at this level
  RET20D_WEIGHT: 0.4,         // Weight for 20-day return in composite score
  RET60D_WEIGHT: 0.6,         // Weight for 60-day return in composite score
};

// V2.2: Volume Dry-Up (VDU) detection
export const VDU_CONFIG = {
  LOOKBACK_DAYS: 5,           // Bars to scan for declining volume
  MIN_DECLINE_DAYS: 3,        // Min consecutive lower-volume bars required
  PRICE_ATR_PROXIMITY: 1.5,   // Price must be within N*ATR of EMA20/50
  SCORE_BOOST: 5,             // Signal score boost when VDU active
};

// V2.2: Gap risk scoring
export const GAP_RISK_CONFIG = {
  LOOKBACK_DAYS: 60,          // Historical days to compute gap frequency
  REJECT_THRESHOLD: 80,       // Percentile above which entry is rejected
  REDUCE_THRESHOLD: 60,       // Percentile above which qty is halved
};

// V2.2: Drawdown-based position size multipliers
export const DRAWDOWN_CONFIG = {
  DD_5_PCT: 0.05,   MULT_0_TO_5: 1.00,
  DD_10_PCT: 0.10,  MULT_5_TO_10: 0.75,
  DD_15_PCT: 0.15,  MULT_10_TO_15: 0.50,
  DD_20_PCT: 0.20,  MULT_15_TO_20: 0.25,
  HALT_AT_PCT: 0.20,          // No new entries beyond this drawdown
  EQUITY_EMA_PERIOD: 25,      // Days for equity curve EMA filter
  EQUITY_EMA_MULT: 0.5,       // Size multiplier when equity < equityEMA
};

// V2.2: Dynamic slippage model — f(liquidityBucket, regimeState)
export const SLIPPAGE_CONFIG = {
  BUCKETS: {
    A: { minBps: 2,  maxBps: 8  },
    B: { minBps: 5,  maxBps: 20 },
    C: { minBps: 10, maxBps: 40 },
  } as Record<string, { minBps: number; maxBps: number }>,
  REGIME_MULT: {
    TREND:      1.0,
    RANGE:      1.2,
    HIGH_VOL:   2.0,
    TRANSITION: 1.5,
    BEAR:       1.5,
  } as Record<string, number>,
  FEE_ROUND_TRIP_PCT: 0.15,   // Taxes + brokerage as % of trade value
};

export const RISK_LIMITS = {
  maxPerSectorPositions: 3,
  maxSameDirectionInHighVol: 2,
  maxPortfolioHeatR: 4,
};

// V2.3: Per-strategy exit profiles (replaces one-size-fits-all exits)
export const EXIT_PROFILES: Record<string, {
  stopAtrMult: number;
  targetAtrMult: number;
  timeStopDays: number;
  useTrailingStop: boolean;
  trailingActivationAtr: number;   // ATR move before trailing kicks in
  trailingStopAtr: number;         // Trail distance in ATR once active
  partialProfitAtr: number;        // MFE in ATR to trigger partial
  partialFraction: number;         // Fraction to exit on partial
}> = {
  PullbackEOD: {
    stopAtrMult: 2.0,
    targetAtrMult: 3.0,
    timeStopDays: 10,
    useTrailingStop: true,
    trailingActivationAtr: 1.0,    // Trail after 1R favorable move
    trailingStopAtr: 1.5,          // Trail at 1.5 ATR behind high
    partialProfitAtr: 2.0,
    partialFraction: 0.33,
  },
  BreakoutCloseEOD: {
    stopAtrMult: 2.0,
    targetAtrMult: 4.0,            // Wider target — let winners run
    timeStopDays: 15,              // Longer hold for trend-following
    useTrailingStop: true,
    trailingActivationAtr: 1.5,    // Trail after 1.5R move
    trailingStopAtr: 2.0,          // Wider trail — don't choke winners
    partialProfitAtr: 2.5,
    partialFraction: 0.33,
  },
  MeanReversionEOD: {
    stopAtrMult: 1.5,              // Tighter stop — thesis is quick revert
    targetAtrMult: 1.5,            // Fast profit-take
    timeStopDays: 3,               // Short hold — if no revert, exit
    useTrailingStop: false,         // No trailing — take profit quickly
    trailingActivationAtr: 0,
    trailingStopAtr: 0,
    partialProfitAtr: 1.0,         // Quick partial at 1 ATR
    partialFraction: 0.5,          // Exit half quickly
  },
  ShortBounceEOD: {
    stopAtrMult: 1.5,              // Tighter stop — squeeze risk
    targetAtrMult: 2.0,            // Moderate target
    timeStopDays: 5,               // Short hold — don't fight reversals
    useTrailingStop: false,
    trailingActivationAtr: 0,
    trailingStopAtr: 0,
    partialProfitAtr: 1.5,
    partialFraction: 0.5,
  },
  // V3.1: Bear market strategies
  BearBounceEOD: {
    stopAtrMult: 1.5,              // Tight stop — counter-trend is risky
    targetAtrMult: 1.5,            // Quick take-profit — don't hold into further decline
    timeStopDays: 3,               // Very short hold — bounce or bail
    useTrailingStop: false,         // No trailing — take profit fast
    trailingActivationAtr: 0,
    trailingStopAtr: 0,
    partialProfitAtr: 1.0,         // Partial at 1 ATR
    partialFraction: 0.5,          // Exit half quickly
  },
  RSLeaderEOD: {
    stopAtrMult: 2.5,              // Wider stop — high conviction, give room
    targetAtrMult: 4.0,            // Wide target — these can run when market turns
    timeStopDays: 15,              // Longer hold — relative strength persists
    useTrailingStop: true,          // Trail — let winners run
    trailingActivationAtr: 1.5,    // Trail after 1.5R move
    trailingStopAtr: 2.0,          // Wide trail — don't choke conviction trades
    partialProfitAtr: 2.5,
    partialFraction: 0.33,
  },
  // SEPA uses percent-based stop/lock/trail handled directly in tradeManager;
  // these ATR fields are unused for SEPA but present so profile lookups never fall
  // back to PullbackEOD. timeStopDays huge + no partial = ride the trailing stop.
  SepaBreakoutEOD: {
    stopAtrMult: 1.0,
    targetAtrMult: 1000,
    timeStopDays: 100000,
    useTrailingStop: false,
    trailingActivationAtr: 0,
    trailingStopAtr: 0,
    partialProfitAtr: 100000,
    partialFraction: 0,
  },
};

// V2.3: Event calendar configuration
export const EVENT_CONFIG = {
  EARNINGS_BLOCK_DAYS: 5,          // Block entries within 5 trading days of earnings (up from 2)
  CORPORATE_ACTION_BLOCK_DAYS: 3,  // Block entries around splits/bonuses/mergers
  FNO_BAN_BLOCK: true,             // Block shorts when symbol is in F&O ban
  MEAN_REVERSION_EARNINGS_BLOCK_DAYS: 10, // Extra caution for mean reversion near earnings
};

// V2.3: ADV (Average Daily Volume) position limits
export const ADV_LIMITS = {
  MAX_ADV_PCT: 0.02,               // Max 2% of 20-day median volume per position
  MIN_ORDER_VALUE_INR: 50_000,     // Minimum ₹50K order value to avoid noise
  MIN_TRADED_VALUE_20D: 5_000_000, // Reject if 20d median traded value < ₹50L
  // V2.4: Absolute position size cap
  MAX_POSITION_VALUE_INR: 20_000_000, // Max ₹2Cr per position regardless of sizing
};

// V2.3: Short strategy controls
export const SHORT_CONFIG = {
  ENABLED: true,                    // V3.1: Enabled for paper signal research (futures plumbing TBD for realistic PnL)
  REQUIRE_BUCKET_A: true,           // Only short high-liquidity names
  MAX_SHORT_POSITIONS: 2,           // Max concurrent shorts
  // V2.4: India-specific shorting instrument path
  INSTRUMENT: 'FUTURES' as const,   // 'FUTURES' = stock futures only (no naked cash shorts)
  REQUIRE_FNO_ELIGIBLE: true,       // Must be in F&O segment
  LOT_SIZE_ENFORCEMENT: true,       // Enforce F&O lot sizes (round down to nearest lot)
};

// V2.3: Portfolio vol-targeting (simplifies multiplier stack)
export const VOL_TARGET_CONFIG = {
  TARGET_ANNUAL_VOL: 0.12,         // 12% target portfolio annualized volatility
  LOOKBACK_DAYS: 20,               // Realized vol lookback
  MIN_POSITION_PCT: 0.005,         // Min 0.5% of equity per position
  MAX_POSITION_PCT: 0.05,          // Max 5% of equity per position
};

// V2.3: Gap stress testing
export const GAP_STRESS_CONFIG = {
  STRESS_GAP_ATR_MULT: 3.0,        // Assume 3x ATR overnight gap in stress test
  MAX_PORTFOLIO_GAP_LOSS_PCT: 0.10, // Max 10% portfolio loss under gap stress
  PER_POSITION_MAX_GAP_LOSS_R: 5.0, // Warn if any position can lose > 5R on gap
};

// V3.0: Orchestration hardening
export const ORCH_CONFIG = {
  MAX_FAILURE_PCT: 0.20,             // Abort job if >20% symbols fail
  FINALIZATION_MAX_RETRIES: 3,       // Max retries before marking job FAILED
  JOB_TIMEOUT_MINUTES: 30,           // Auto-fail stuck jobs after 30 min
  STAGE_BARRIER_ENABLED: true,       // Require all symbols to complete stage before next
  MIN_DATA_COMPLETENESS_PCT: 0.80,   // Need ≥80% universe bars before proceeding to signals
  INDEX_BAR_REQUIRED: true,          // Require index bar present for regime computation
};

// V3.0: Market hours guard
export const MARKET_HOURS = {
  NSE_CLOSE_HOUR: 15,               // NSE closes at 15:30 IST
  NSE_CLOSE_MINUTE: 30,
  EOD_SAFE_HOUR: 15,                // Earliest EOD trigger: 15:45 IST
  EOD_SAFE_MINUTE: 45,
  IST_OFFSET_HOURS: 5.5,            // UTC+5:30
};

// V3.0: Full Indian equity fee breakdown
export const INDIAN_FEE_CONFIG = {
  STT_SELL_PCT: 0.025,              // STT on sell side (delivery)
  STAMP_DUTY_PCT: 0.003,            // State stamp duty (capped)
  EXCHANGE_TXN_PCT: 0.00345,        // NSE transaction charges
  SEBI_TURNOVER_PCT: 0.0001,        // SEBI turnover fee
  GST_PCT: 18,                       // GST on brokerage + exchange charges
  BROKERAGE_FLAT_INR: 20,           // Flat brokerage per order (discount broker)
  BROKERAGE_PCT: 0.03,              // % brokerage if no flat (for reference)
};

// V3.0: Data validation thresholds
export const DATA_VALIDATION = {
  MAX_OHLC_RATIO: 1.20,             // Reject if high/low > 20% (circuit filter)
  MIN_CLOSE_INR: 1.0,               // Reject penny stocks below ₹1
  VOLUME_ANOMALY_MULT: 50,          // Flag if volume > 50x 20-day median
  ZERO_VOLUME_REJECT_EQUITY: true,  // Reject 0-volume bars for equities (not indices)
  PRICE_JUMP_PCT: 0.20,             // Flag >20% single-day price move as potential corp action
};

// V3.0: Regime hardening
export const REGIME_HARDENING = {
  HYSTERESIS_BARS: 3,                // Require 3 consecutive bars to confirm regime change
  TREND_BREADTH_MIN: 0.55,          // TREND requires pctAboveEMA50 > 55%
  BEAR_BREADTH_MAX: 0.35,           // BEAR requires pctAboveEMA50 < 35%
  PERSISTENCE_CONFIDENCE_DAYS: 5,   // Days in regime before full confidence
};

// V3.0: Per-strategy minimum signal scores
export const STRATEGY_MIN_SCORES: Record<string, number> = {
  PullbackEOD: 55,
  BreakoutCloseEOD: 60,
  MeanReversionEOD: 50,
  ShortBounceEOD: 65,
  BearBounceEOD: 55,
  RSLeaderEOD: 65,
  SepaBreakoutEOD: 0,   // SEPA gate does its own filtering; no score floor
};

// V3.1: Per-strategy RS thresholds (min/max). Replaces one-size-fits-all RS gate in risk approval.
// Shorts want WEAK stocks (low RS). Bear bounces don't filter on RS. Leaders want HIGH RS.
export const RS_STRATEGY_THRESHOLDS: Record<string, { min: number; max: number }> = {
  PullbackEOD:      { min: 60, max: 100 },
  BreakoutCloseEOD: { min: 70, max: 100 },
  MeanReversionEOD: { min: 30, max: 100 },  // Oversold stocks have weaker RS
  ShortBounceEOD:   { min: 0,  max: 50 },   // Only short weak stocks
  BearBounceEOD:    { min: 0,  max: 100 },   // No RS filter — deeply oversold
  RSLeaderEOD:      { min: 80, max: 100 },   // Only the strongest
  SepaBreakoutEOD:  { min: 0,  max: 100 },   // SEPA uses its own 126d rank gate
};

// V3.1: Bear-specific strategy thresholds
export const BEAR_STRATEGY_CONFIG = {
  BEAR_BOUNCE_RSI_MAX: 25,          // RSI must be deeply oversold
  BEAR_BOUNCE_VOL_MULT: 1.5,        // Volume spike confirming capitulation
  BEAR_MR_RSI_MAX: 25,              // Tighter than RANGE MR (30)
  RS_LEADER_MIN_RS: 80,             // Top quintile relative strength
  RS_LEADER_RSI_MIN: 40,            // Not too oversold (confirms strength)
  RS_LEADER_RSI_MAX: 65,            // Not overextended
};

// V3.0: Regime-aware RSI thresholds
export const REGIME_RSI_THRESHOLDS: Record<string, { pullbackMin: number; pullbackMax: number }> = {
  TREND:      { pullbackMin: 38, pullbackMax: 58 },  // Wider — trust the trend
  RANGE:      { pullbackMin: 40, pullbackMax: 55 },  // Default
  HIGH_VOL:   { pullbackMin: 42, pullbackMax: 50 },  // Tighter — less trust in vol
  TRANSITION: { pullbackMin: 45, pullbackMax: 50 },  // Very tight
  BEAR:       { pullbackMin: 45, pullbackMax: 55 },  // Standard
};
export const SECURITY_CONFIG = {
  API_KEY_HEADER: 'x-api-key',       // Header name for API key auth
  REQUIRE_AUTH: false,                // Enable for production (disable for local dev)
  SCHEDULER_USER_AGENT: 'Google-Cloud-Scheduler', // Trusted scheduler UA
};
