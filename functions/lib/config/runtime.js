"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RISK_LIMITS = exports.RUNTIME_CONFIG = void 0;
exports.RUNTIME_CONFIG = {
    TRADING_ENABLED: true,
    PAPER_ONLY: true,
    MAX_DATA_STALENESS_MINUTES: 10000, // ~7 days (handles future tests/holidays)
    MAX_DAILY_NEW_ENTRIES: 5,
    USE_WEEKLY_BIAS: false,
};
exports.RISK_LIMITS = {
    maxPerSectorPositions: 3,
    maxSameDirectionInHighVol: 2,
    maxPortfolioHeatR: 4,
};
//# sourceMappingURL=runtime.js.map