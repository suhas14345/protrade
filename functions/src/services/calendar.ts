import * as admin from 'firebase-admin';
import { CalendarDay } from '../models';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

/**
 * Service to handle trading-day logic and holiday awareness.
 */
export class CalendarService {
  /**
   * Fetch calendar data for a specific dateId (YYYYMMDD)
   */
  static async getCalendarDay(dateId: string): Promise<CalendarDay | null> {
    const db = getDb();
    const doc = await db.collection('calendar').doc(dateId).get();
    if (!doc.exists) return null;
    return doc.data() as CalendarDay;
  }

  /**
   * Get the previous trading day ID relative to the given dateId.
   * Leverages the indexed calendar collection for O(1) correctness.
   */
  static async getPrevTradingDateId(dateId: string): Promise<string | null> {
    const day = await this.getCalendarDay(dateId);
    if (day?.prevTradingDateId) return day.prevTradingDateId;

    // Fallback: If calendar not seeded, we might have to scan or use fragile math
    console.warn(`[Calendar] Calendar doc missing for ${dateId}. Fallback to numeric subtraction.`);
    // Simple numeric fallback (fragile for weekends/months)
    const d = new Date(`${dateId.slice(0, 4)}-${dateId.slice(4, 6)}-${dateId.slice(6, 8)}`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0].replace(/-/g, '');
  }

  /**
   * Helper to check if a day is a trading day.
   */
  static async isTradingDay(dateId: string): Promise<boolean> {
    const day = await this.getCalendarDay(dateId);
    if (day) return day.isTradingDay;

    // Fallback: Weekend check
    const d = new Date(`${dateId.slice(0, 4)}-${dateId.slice(4, 6)}-${dateId.slice(6, 8)}`);
    const dayOfWeek = d.getUTCDay();
    return dayOfWeek !== 0 && dayOfWeek !== 6;
  }

  /**
   * Seed the calendar collection for a date range (Utility).
   * Skips weekends by default.
   */
  static async seedCalendar(startDate: string, endDate: string) {
    const db = getDb();
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    let current = new Date(start);
    let lastTradingDateId: string | null = null;
    let index = 0;

    const batch = db.batch();

    while (current <= end) {
      const dateId = current.toISOString().split('T')[0].replace(/-/g, '');
      const dayOfWeek = current.getUTCDay();
      const isTrading = dayOfWeek !== 0 && dayOfWeek !== 6;

      const calDay: CalendarDay = {
        dateId,
        isTradingDay: isTrading,
        tradingIndex: isTrading ? index++ : -1,
        prevTradingDateId: isTrading ? lastTradingDateId || undefined : undefined
      };

      batch.set(db.collection('calendar').doc(dateId), calDay);

      if (isTrading) lastTradingDateId = dateId;
      current.setDate(current.getDate() + 1);

      // Periodically commit batches if range is huge
      // (Simplified here for typical ranges)
    }

    await batch.commit();
    console.log(`[Calendar] Seeded calendar from ${startDate} to ${endDate}`);
  }

  /**
   * Sync the calendar collection from existing index bar data (Source of Truth).
   * Minimizes manual intervention by deriving trading days from barsD/{indexSymbol}/days.
   */
  static async syncFromIndexData(indexSymbol: string = '^NSEI') {
    const db = getDb();
    const barsSnap = await db.collection('barsD').doc(indexSymbol).collection('days')
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .get();

    if (barsSnap.empty) {
      console.warn(`[Calendar] No index bars found for ${indexSymbol}. Cannot sync.`);
      return;
    }

    const tradingDates = barsSnap.docs.map(d => d.id);
    const batch = db.batch();
    
    // 1. Process all known trading days
    for (let i = 0; i < tradingDates.length; i++) {
      const dateId = tradingDates[i];
      const prev = i > 0 ? tradingDates[i - 1] : undefined;
      const next = i < tradingDates.length - 1 ? tradingDates[i + 1] : undefined;

      const calDay: CalendarDay = {
        dateId,
        isTradingDay: true,
        tradingIndex: i,
        prevTradingDateId: prev,
        nextTradingDateId: next
      };

      batch.set(db.collection('calendar').doc(dateId), calDay);

      // 2. Fill gaps between this trading day and the next as non-trading
      if (next) {
        await this.fillNonTradingGaps(dateId, next, batch);
      }
    }

    await batch.commit();
    console.log(`[Calendar] Synced calendar from ${indexSymbol} data (${tradingDates.length} trading days).`);
  }

  /**
   * Private helper to fill gaps between two trading days as isTradingDay: false.
   */
  private static async fillNonTradingGaps(startId: string, endId: string, batch: FirebaseFirestore.WriteBatch) {
    const db = getDb();
    const start = new Date(`${startId.slice(0, 4)}-${startId.slice(4, 6)}-${startId.slice(6, 8)}`);
    const end = new Date(`${endId.slice(0, 4)}-${endId.slice(4, 6)}-${endId.slice(6, 8)}`);
    
    let current = new Date(start);
    current.setDate(current.getDate() + 1);

    while (current < end) {
      const dateId = current.toISOString().split('T')[0].replace(/-/g, '');
      const calDay: CalendarDay = {
        dateId,
        isTradingDay: false,
        tradingIndex: -1
      };
      batch.set(db.collection('calendar').doc(dateId), calDay);
      current.setDate(current.getDate() + 1);
    }
  }

  /**
   * Incremental Update: Mark today as a trading day after a successful run. (Gap B)
   */
  static async upsertToday(dateId: string) {
    const db = getDb();
    const prevTradingDateId = await this.getPrevTradingDateId(dateId);
    
    // Get max trading index to increment by scanning recent docs (Avoids composite index requirement)
    const latestDaysSnap = await db.collection('calendar')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
      .limit(10) // Should find at least one trading day within last 10 calendar days
      .get();
    
    let nextIndex = 0;
    if (!latestDaysSnap.empty) {
      const tradingDays = latestDaysSnap.docs
        .map((d: any) => d.data() as CalendarDay)
        .filter((d: any) => d.isTradingDay && d.dateId < dateId)
        .sort((a, b) => b.tradingIndex - a.tradingIndex);
      
      if (tradingDays.length > 0) {
        nextIndex = tradingDays[0].tradingIndex + 1;
      }
    }

    const calDay: CalendarDay = {
      dateId,
      isTradingDay: true,
      tradingIndex: nextIndex,
      prevTradingDateId: prevTradingDateId || undefined
    };

    await db.collection('calendar').doc(dateId).set(calDay, { merge: true });
    
    // Also update the PREVIOUS day's nextTradingDateId if it exists
    if (prevTradingDateId) {
      await db.collection('calendar').doc(prevTradingDateId).update({ nextTradingDateId: dateId });
    }
  }

  /**
   * Seed Future Holidays (Gap C)
   * Mark a list of dates as non-trading days.
   */
  static async seedFutureHolidays(holidayDates: string[]) {
    const db = getDb();
    const batch = db.batch();
    for (const dateId of holidayDates) {
      const calDay: CalendarDay = {
        dateId,
        isTradingDay: false,
        tradingIndex: -1
      };
      batch.set(db.collection('calendar').doc(dateId), calDay, { merge: true });
    }
    await batch.commit();
    console.log(`[Calendar] Seeded ${holidayDates.length} future holidays.`);
  }
}
