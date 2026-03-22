"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkSafety = checkSafety;
const runtime_1 = require("../config/runtime");
function checkSafety(lastBar) {
    if (!runtime_1.RUNTIME_CONFIG.TRADING_ENABLED) {
        throw new Error('TRADING_DISABLED: Kill switch is active.');
    }
    if (lastBar) {
        const now = Date.now();
        const barTime = lastBar.timestamp.toMillis();
        const stalenessMinutes = (now - barTime) / (1000 * 60);
        if (stalenessMinutes > runtime_1.RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES) {
            throw new Error(`DATA_STALE: Last bar is ${stalenessMinutes.toFixed(0)} minutes old (threshold: ${runtime_1.RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES}).`);
        }
    }
}
//# sourceMappingURL=safety.js.map