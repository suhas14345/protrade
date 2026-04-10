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
exports.EventCalendarService = void 0;
const admin = __importStar(require("firebase-admin"));
const runtime_1 = require("../config/runtime");
const calendar_1 = require("./calendar");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/**
 * V2.3: Event Calendar Service
 * Checks earnings, corporate actions, F&O bans, and index rebalance dates.
 * Returns blocking reasons for entry decisions.
 */
class EventCalendarService {
    /**
     * Check if a symbol is blocked from entry on a given date.
     * Returns { blocked: boolean, reasons: string[] }
     */
    static async checkEntryBlock(symbol, dateId, strategy) {
        const reasons = [];
        const db = getDb();
        // V2.4: Staleness check — warn if earnings collection appears empty/stale
        try {
            const earningsCount = await db.collection('earnings').limit(1).get();
            if (earningsCount.empty) {
                console.warn(`[EventCalendar] WARNING: earnings collection is EMPTY — event blocking may be incomplete`);
            }
        }
        catch ( /* non-blocking check */_a) { /* non-blocking check */ }
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
    static async isEarningsBlocked(db, symbol, dateId, strategy) {
        var _a;
        const earningsSnap = await db.collection('earnings').doc(symbol).get();
        const nextEarningsDateId = (_a = earningsSnap.data()) === null || _a === void 0 ? void 0 : _a.nextEarningsDateId;
        if (!nextEarningsDateId)
            return { blocked: false, reason: '' };
        const [runDay, earningsDay] = await Promise.all([
            calendar_1.CalendarService.getCalendarDay(dateId),
            calendar_1.CalendarService.getCalendarDay(nextEarningsDateId),
        ]);
        if (!runDay || !earningsDay)
            return { blocked: false, reason: '' };
        const diff = earningsDay.tradingIndex - runDay.tradingIndex;
        // Strategy-specific block windows
        const blockDays = strategy === 'MeanReversionEOD'
            ? runtime_1.EVENT_CONFIG.MEAN_REVERSION_EARNINGS_BLOCK_DAYS
            : runtime_1.EVENT_CONFIG.EARNINGS_BLOCK_DAYS;
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
    static async isCorporateActionBlocked(db, symbol, dateId) {
        var _a, _b;
        try {
            const caSnap = await db.collection('corporateActions').doc(symbol).get();
            const nextActionDateId = (_a = caSnap.data()) === null || _a === void 0 ? void 0 : _a.nextActionDateId;
            const actionType = ((_b = caSnap.data()) === null || _b === void 0 ? void 0 : _b.actionType) || 'UNKNOWN';
            if (!nextActionDateId)
                return { blocked: false, reason: '' };
            const [runDay, actionDay] = await Promise.all([
                calendar_1.CalendarService.getCalendarDay(dateId),
                calendar_1.CalendarService.getCalendarDay(nextActionDateId),
            ]);
            if (!runDay || !actionDay)
                return { blocked: false, reason: '' };
            const diff = actionDay.tradingIndex - runDay.tradingIndex;
            if (diff >= 0 && diff <= runtime_1.EVENT_CONFIG.CORPORATE_ACTION_BLOCK_DAYS) {
                return {
                    blocked: true,
                    reason: `Corporate action (${actionType}) in ${diff} trading days`,
                };
            }
        }
        catch (_c) {
            // Collection may not exist yet — non-blocking
        }
        return { blocked: false, reason: '' };
    }
    /**
     * F&O ban check — critical for short strategies.
     * When a stock is in F&O ban, no new derivative positions are allowed.
     */
    static async isFnOBanBlocked(db, symbol, dateId) {
        var _a;
        if (!runtime_1.EVENT_CONFIG.FNO_BAN_BLOCK)
            return { blocked: false, reason: '' };
        try {
            const banSnap = await db.collection('fnoBans').doc(dateId).get();
            const bannedSymbols = ((_a = banSnap.data()) === null || _a === void 0 ? void 0 : _a.symbols) || [];
            if (bannedSymbols.includes(symbol)) {
                return { blocked: true, reason: `Symbol in F&O ban list for ${dateId}` };
            }
        }
        catch (_b) {
            // Collection may not exist yet — non-blocking
        }
        return { blocked: false, reason: '' };
    }
}
exports.EventCalendarService = EventCalendarService;
//# sourceMappingURL=eventCalendar.js.map