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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTelegramConfig = getTelegramConfig;
exports.sendTelegramMessage = sendTelegramMessage;
exports.sendDailyDigest = sendDailyDigest;
const admin = __importStar(require("firebase-admin"));
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("./logger");
const getDb = () => {
    if (admin.apps.length === 0)
        admin.initializeApp();
    return admin.firestore();
};
/** Read the Telegram config from settings/telegram (same pattern as settings/kite). */
async function getTelegramConfig(db) {
    const snap = await db.collection('settings').doc('telegram').get();
    return (snap.exists ? snap.data() : {});
}
/**
 * Send a plain-text message to the configured Telegram chat. No-op if disabled or
 * unconfigured. The bot token is a secret: it is never logged, and Telegram error
 * bodies (which can echo the request URL) are reduced to their description only.
 */
async function sendTelegramMessage(text) {
    var _a, _b;
    const db = getDb();
    const cfg = await getTelegramConfig(db);
    if (!cfg.enabled)
        return { sent: false, reason: 'disabled' };
    if (!cfg.botToken || !cfg.chatId)
        return { sent: false, reason: 'not_configured' };
    try {
        await axios_1.default.post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, { chat_id: cfg.chatId, text, disable_web_page_preview: true }, { timeout: 10000 });
        return { sent: true };
    }
    catch (e) {
        const desc = ((_b = (_a = e === null || e === void 0 ? void 0 : e.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.description) || e.message || 'unknown error';
        await logger_1.logger.warn(`[Telegram] send failed: ${desc}`, 'Telegram');
        return { sent: false, reason: desc };
    }
}
/** Build and send the daily EOD digest (active trades, day's activity, total P&L). */
async function sendDailyDigest(dateInput) {
    const { buildDailySnapshot, formatSnapshotText } = await Promise.resolve().then(() => __importStar(require('./snapshot')));
    const snap = await buildDailySnapshot(dateInput);
    return sendTelegramMessage(formatSnapshotText(snap));
}
//# sourceMappingURL=telegram.js.map