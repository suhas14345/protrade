import * as admin from 'firebase-admin';
import axios from 'axios';
import { logger } from './logger';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
  enabled?: boolean;
}

/** Read the Telegram config from settings/telegram (same pattern as settings/kite). */
export async function getTelegramConfig(db: FirebaseFirestore.Firestore): Promise<TelegramConfig> {
  const snap = await db.collection('settings').doc('telegram').get();
  return (snap.exists ? snap.data() : {}) as TelegramConfig;
}

/**
 * Send a plain-text message to the configured Telegram chat. No-op if disabled or
 * unconfigured. The bot token is a secret: it is never logged, and Telegram error
 * bodies (which can echo the request URL) are reduced to their description only.
 */
export async function sendTelegramMessage(text: string): Promise<{ sent: boolean; reason?: string }> {
  const db = getDb();
  const cfg = await getTelegramConfig(db);
  if (!cfg.enabled) return { sent: false, reason: 'disabled' };
  if (!cfg.botToken || !cfg.chatId) return { sent: false, reason: 'not_configured' };
  try {
    await axios.post(
      `https://api.telegram.org/bot${cfg.botToken}/sendMessage`,
      { chat_id: cfg.chatId, text, disable_web_page_preview: true },
      { timeout: 10000 },
    );
    return { sent: true };
  } catch (e: any) {
    const desc = e?.response?.data?.description || e.message || 'unknown error';
    await logger.warn(`[Telegram] send failed: ${desc}`, 'Telegram');
    return { sent: false, reason: desc };
  }
}

/** Build and send the daily EOD digest (active trades, day's activity, total P&L). */
export async function sendDailyDigest(dateInput?: string): Promise<{ sent: boolean; reason?: string }> {
  const { buildDailySnapshot, formatSnapshotText } = await import('./snapshot');
  const snap = await buildDailySnapshot(dateInput);
  return sendTelegramMessage(formatSnapshotText(snap));
}
