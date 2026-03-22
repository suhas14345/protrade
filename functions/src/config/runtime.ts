export const RUNTIME_CONFIG = {
  TRADING_ENABLED: true,
  PAPER_ONLY: true,
  MAX_DATA_STALENESS_MINUTES: 10000, // ~7 days (handles future tests/holidays)
  MAX_DAILY_NEW_ENTRIES: 5,
  USE_WEEKLY_BIAS: false,
};

export const RISK_LIMITS = {
  maxPerSectorPositions: 3,
  maxSameDirectionInHighVol: 2,
  maxPortfolioHeatR: 4,
};
