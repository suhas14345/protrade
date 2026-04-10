import { RUNTIME_CONFIG } from '../config/runtime';
import { Bar } from '../models';

export function checkSafety(lastBar?: Bar, runDate?: string) {
  if (!RUNTIME_CONFIG.TRADING_ENABLED) {
    throw new Error('TRADING_DISABLED: Kill switch is active.');
  }

  // Only enforce staleness in LIVE modes (Gap 5)
  const isLive = RUNTIME_CONFIG.MODE === 'LIVE' || RUNTIME_CONFIG.MODE === 'PAPER_LIVE';
  if (!isLive) return;

  if (lastBar) {
    let barTime: number;
    if (typeof (lastBar.timestamp as any)?.toMillis === 'function') {
      barTime = (lastBar.timestamp as any).toMillis();
    } else {
      barTime = new Date(lastBar.timestamp as any).getTime();
    }

    if (runDate) {
      // Date-level freshness: bar must be from run date or the trading day before
      // Bar timestamps may use midnight (date-only), so compare dates not times
      const barDate = new Date(barTime).toISOString().split('T')[0]; // YYYY-MM-DD UTC
      const runDateStr = runDate; // YYYY-MM-DD
      // Also compute IST date from bar time (UTC+5:30)
      const barIST = new Date(barTime + 5.5 * 60 * 60 * 1000);
      const barDateIST = barIST.toISOString().split('T')[0];

      // Accept if bar date matches run date (either UTC or IST) or is 1 day before
      const runDt = new Date(runDateStr);
      const prevDay = new Date(runDt); prevDay.setDate(prevDay.getDate() - 1);
      const prevDayStr = prevDay.toISOString().split('T')[0];

      if (barDateIST !== runDateStr && barDate !== runDateStr && barDateIST !== prevDayStr && barDate !== prevDayStr) {
        throw new Error(`DATA_STALE: Last bar date ${barDateIST} does not match run date ${runDateStr} (or previous day).`);
      }
    } else {
      // Real-time mode: use absolute staleness
      const stalenessMinutes = (Date.now() - barTime) / (1000 * 60);
      if (stalenessMinutes > RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES) {
        throw new Error(`DATA_STALE: Last bar is ${stalenessMinutes.toFixed(0)} minutes old (threshold: ${RUNTIME_CONFIG.MAX_DATA_STALENESS_MINUTES}).`);
      }
    }
  }
}
