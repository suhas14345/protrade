"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CalendarService = void 0;
const admin = __importStar(require("firebase-admin"));
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * Service to handle trading-day logic and holiday awareness.
 */
class CalendarService {
    /**
     * Fetch calendar data for a specific dateId (YYYYMMDD)
     */
    static async getCalendarDay(dateId) {
        const db = getDb();
        const doc = await db.collection('calendar').doc(dateId).get();
        if (!doc.exists)
            return null;
        return doc.data();
    }
    /**
     * Get the previous trading day ID relative to the given dateId.
     * Leverages the indexed calendar collection for O(1) correctness.
     */
    static async getPrevTradingDateId(dateId) {
        const day = await this.getCalendarDay(dateId);
        if (day === null || day === void 0 ? void 0 : day.prevTradingDateId)
            return day.prevTradingDateId;
        // Fallback: walk backwards skipping weekends (max 7 days to handle long weekends + holidays)
        console.warn(`[Calendar] Calendar doc missing for ${dateId}. Fallback to weekend-aware subtraction.`);
        const d = new Date(`${dateId.slice(0, 4)}-${dateId.slice(4, 6)}-${dateId.slice(6, 8)}`);
        for (let i = 0; i < 7; i++) {
            d.setDate(d.getDate() - 1);
            const dow = d.getUTCDay();
            if (dow !== 0 && dow !== 6) {
                return d.toISOString().split('T')[0].replace(/-/g, '');
            }
        }
        return null;
    }
    /**
     * Helper to check if a day is a trading day.
     */
    static async isTradingDay(dateId) {
        const day = await this.getCalendarDay(dateId);
        if (day)
            return day.isTradingDay;
        // Fallback: Weekend check
        const d = new Date(`${dateId.slice(0, 4)}-${dateId.slice(4, 6)}-${dateId.slice(6, 8)}`);
        const dayOfWeek = d.getUTCDay();
        return dayOfWeek !== 0 && dayOfWeek !== 6;
    }
    /**
     * Seed the calendar collection for a date range (Utility).
     * Skips weekends by default.
     */
    static async seedCalendar(startDate, endDate) {
        const db = getDb();
        const start = new Date(startDate);
        const end = new Date(endDate);
        let current = new Date(start);
        let lastTradingDateId = null;
        let index = 0;
        const batch = db.batch();
        while (current <= end) {
            const dateId = current.toISOString().split('T')[0].replace(/-/g, '');
            const dayOfWeek = current.getUTCDay();
            const isTrading = dayOfWeek !== 0 && dayOfWeek !== 6;
            const calDay = {
                dateId,
                isTradingDay: isTrading,
                tradingIndex: isTrading ? index++ : -1,
                prevTradingDateId: isTrading ? lastTradingDateId || undefined : undefined
            };
            batch.set(db.collection('calendar').doc(dateId), calDay);
            if (isTrading)
                lastTradingDateId = dateId;
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
    static async syncFromIndexData(indexSymbol = '^NSEI') {
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
            const calDay = {
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
    static async fillNonTradingGaps(startId, endId, batch) {
        const db = getDb();
        const start = new Date(`${startId.slice(0, 4)}-${startId.slice(4, 6)}-${startId.slice(6, 8)}`);
        const end = new Date(`${endId.slice(0, 4)}-${endId.slice(4, 6)}-${endId.slice(6, 8)}`);
        let current = new Date(start);
        current.setDate(current.getDate() + 1);
        while (current < end) {
            const dateId = current.toISOString().split('T')[0].replace(/-/g, '');
            const calDay = {
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
    static async upsertToday(dateId) {
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
                .map((d) => d.data())
                .filter((d) => d.isTradingDay && d.dateId < dateId)
                .sort((a, b) => b.tradingIndex - a.tradingIndex);
            if (tradingDays.length > 0) {
                nextIndex = tradingDays[0].tradingIndex + 1;
            }
        }
        const calDay = {
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
    static async seedFutureHolidays(holidayDates) {
        const db = getDb();
        const batch = db.batch();
        for (const dateId of holidayDates) {
            const calDay = {
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
exports.CalendarService = CalendarService;
//# sourceMappingURL=calendar.js.map