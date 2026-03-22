export const RUNTIME_CONFIG = {
  TRADING_ENABLED: true,
  PAPER_ONLY: true,
  MAX_DATA_STALENESS_MINUTES: 10000, // ~7 days (handles future tests/holidays)
  MAX_DAILY_NEW_ENTRIES: 5,
  USE_WEEKLY_BIAS: false,
};

export const STRATEGY_V11 = {
  EMA_TOUCH_ATR_MULT: 0.3,
  BREAKOUT_VOL_MULT: 1.2,
  RANGE_TREND_NEUTRAL_MAX: 0.01,
  EARNINGS_BLOCK_DAYS: 2,
  HIGH_VOL_SHORT_TARGET_ATR: 2.0,
  TIME_STOP_DAYS: 5,
  TIME_STOP_PROGRESS_ATR: 1.0,
  PARTIAL_PROFIT_ENABLED: true,
  PARTIAL_PROFIT_ATR: 1.5,
  PARTIAL_PROFIT_FRACTION: 0.33,
};

export const RISK_LIMITS = {
  maxPerSectorPositions: 3,
  maxSameDirectionInHighVol: 2,
  maxPortfolioHeatR: 4,
};
