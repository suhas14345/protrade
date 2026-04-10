import * as admin from 'firebase-admin';
import { EVENT_CONFIG } from '../config/runtime';
import { CalendarService } from './calendar';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * V2.3: Event Calendar Service
 * Checks earnings, corporate actions, F&O bans, and index rebalance dates.
 * Returns blocking reasons for entry decisions.
 */
export class EventCalendarService {
  /**
   * Check if a symbol is blocked from entry on a given date.
   * Returns { blocked: boolean, reasons: string[] }
   */
  static async checkEntryBlock(
    symbol: string,
    dateId: string,
    strategy?: string
  ): Promise<{ blocked: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const db = getDb();

    // V2.4: Staleness check — warn if earnings collection appears empty/stale
    try {
      const earningsCount = await db.collection('earnings').limit(1).get();
      if (earningsCount.empty) {
        console.warn(`[EventCalendar] WARNING: earnings collection is EMPTY — event blocking may be incomplete`);
      }
    } catch { /* non-blocking check */ }

    // 1. Earnings proximity check
    const earningsBlocked = await this.isEarningsBlocked(db, symbol, dateId, strategy);
    if (earningsBlocked.blocked) {
      reasons.push(earningsBlocked.reason);
    }

    // 2. Corporate action check
    const corpActionBlocked = await this.isCorporateActionBlocked(db, symbol, dateId);
    if (corpActionBlocked.blocked) {
      reasons.push(corpActionBlocked.reason);
    }

    // 3. F&O ban check — only blocks short/futures strategies, not cash longs
    if (strategy === 'ShortBounceEOD') {
      const fnoBanBlocked = await this.isFnOBanBlocked(db, symbol, dateId);
      if (fnoBanBlocked.blocked) {
        reasons.push(fnoBanBlocked.reason);
      }
    }

    return {
      blocked: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Extended earnings block — V2.3 uses configurable windows.
   * Mean reversion gets a wider block (EVENT_CONFIG.MEAN_REVERSION_EARNINGS_BLOCK_DAYS).
   */
  static async isEarningsBlocked(
    db: FirebaseFirestore.Firestore,
    symbol: string,
    dateId: string,
    strategy?: string
  ): Promise<{ blocked: boolean; reason: string }> {
    const earningsSnap = await db.collection('earnings').doc(symbol).get();
    const nextEarningsDateId = earningsSnap.data()?.nextEarningsDateId;
    if (!nextEarningsDateId) return { blocked: false, reason: '' };

    const [runDay, earningsDay] = await Promise.all([
      CalendarService.getCalendarDay(dateId),
      CalendarService.getCalendarDay(nextEarningsDateId),
    ]);

    if (!runDay || !earningsDay) return { blocked: false, reason: '' };

    const diff = earningsDay.tradingIndex - runDay.tradingIndex;

    // Strategy-specific block windows
    const blockDays =
      strategy === 'MeanReversionEOD'
        ? EVENT_CONFIG.MEAN_REVERSION_EARNINGS_BLOCK_DAYS
        : EVENT_CONFIG.EARNINGS_BLOCK_DAYS;

    if (diff >= 0 && diff <= blockDays) {
      return {
        blocked: true,
        reason: `Earnings in ${diff} trading days (block window: ${blockDays}d for ${strategy || 'default'})`,
      };
    }

    return { blocked: false, reason: '' };
  }

  /**
   * Corporate action block — splits, bonuses, delistings, mergers.
   * Checks `corporateActions` collection for upcoming events.
   */
  static async isCorporateActionBlocked(
    db: FirebaseFirestore.Firestore,
    symbol: string,
    dateId: string
  ): Promise<{ blocked: boolean; reason: string }> {
    try {
      const caSnap = await db.collection('corporateActions').doc(symbol).get();
      const nextActionDateId = caSnap.data()?.nextActionDateId;
      const actionType = caSnap.data()?.actionType || 'UNKNOWN';
      if (!nextActionDateId) return { blocked: false, reason: '' };

      const [runDay, actionDay] = await Promise.all([
        CalendarService.getCalendarDay(dateId),
        CalendarService.getCalendarDay(nextActionDateId),
      ]);

      if (!runDay || !actionDay) return { blocked: false, reason: '' };

      const diff = actionDay.tradingIndex - runDay.tradingIndex;
      if (diff >= 0 && diff <= EVENT_CONFIG.CORPORATE_ACTION_BLOCK_DAYS) {
        return {
          blocked: true,
          reason: `Corporate action (${actionType}) in ${diff} trading days`,
        };
      }
    } catch {
      // Collection may not exist yet — non-blocking
    }

    return { blocked: false, reason: '' };
  }

  /**
   * F&O ban check — critical for short strategies.
   * When a stock is in F&O ban, no new derivative positions are allowed.
   */
  static async isFnOBanBlocked(
    db: FirebaseFirestore.Firestore,
    symbol: string,
    dateId: string
  ): Promise<{ blocked: boolean; reason: string }> {
    if (!EVENT_CONFIG.FNO_BAN_BLOCK) return { blocked: false, reason: '' };

    try {
      const banSnap = await db.collection('fnoBans').doc(dateId).get();
      const bannedSymbols: string[] = banSnap.data()?.symbols || [];
      if (bannedSymbols.includes(symbol)) {
        return { blocked: true, reason: `Symbol in F&O ban list for ${dateId}` };
      }
    } catch {
      // Collection may not exist yet — non-blocking
    }

    return { blocked: false, reason: '' };
  }
}
