import { RUNTIME_CONFIG } from '../config/runtime';
import { Bar } from '../models';

export function checkSafety(lastBar?: Bar) {
  if (!RUNTIME_CONFIG.TRADING_ENABLED) {
    throw new Error('TRADING_DISABLED: Kill switch is active.');
  }

  if (lastBar) {
    const now = Date.now();
    const barTime = lastBar.timestamp.toMillis();
    const stalenessMinutes = (now - barTime) / (1000 * 60);

    if (stalenessMinutes > RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES) {
      throw new Error(`DATA_STALE: Last bar is ${stalenessMinutes.toFixed(0)} minutes old (threshold: ${RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES}).`);
    }
  }
}
