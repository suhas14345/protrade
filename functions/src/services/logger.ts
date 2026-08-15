import * as admin from 'firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

const getDb = () => {
  if (admin.apps.length === 0) admin.initializeApp();
  return admin.firestore();
};

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  metadata?: any;
  timestamp: Timestamp;
}

/**
 * Production Logging Service
 * Captures runtime issues and logs them to Firestore for persistence and dashboard viewing.
 */
export async function log(level: LogLevel, message: string, context?: string, metadata?: any) {
  // Backtest fast-path: the replay engine emits tens of thousands of log lines,
  // and each Firestore log write is an emulator round-trip that dominates runtime.
  // When BACKTEST_SILENCE=1 (only ever set by the backtest runner, never in
  // production), skip all log persistence; still surface ERRORs to the console.
  if (process.env.BACKTEST_SILENCE === '1') {
    if (level === 'ERROR') console.error(`[${context || 'SYSTEM'}] ${message}`, metadata ?? '');
    return;
  }

  const db = getDb();
  
  // Use metadata.dateId for partition if provided (Backfill support)
  // Otherwise default to current UTC date. Sanitize to YYYYMMDD.
  const rawDateId = metadata?.partitionDateId || metadata?.dateId || new Date().toISOString().split('T')[0];
  const dateId = rawDateId.replace(/-/g, '');

  const entry: LogEntry = {
    level,
    message,
    context,
    metadata,
    timestamp: Timestamp.now()
  };

  try {
    // Write to a persistent logs collection
    await db.collection('logs').doc(dateId).collection('entries').add(entry);
    
    // Also log to standard Firebase logger for Google Cloud Logs Explorer
    if (level === 'ERROR') {
      console.error(`[${context || 'SYSTEM'}] ${message}`, metadata);
      await db.collection('system_errors').add({
        ...entry,
        createdAt: Timestamp.now()
      });
      appendToFileLog('ERROR', message, context, metadata);
    } else if (level === 'WARN') {
      console.warn(`[${context || 'SYSTEM'}] ${message}`, metadata);
      appendToFileLog('WARN', message, context, metadata);
    } else {
      console.log(`[${context || 'SYSTEM'}] ${message}`, metadata);
    }
  } catch (err) {
    // Fallback if Firestore fails
    console.error('CRITICAL: Logging service failed', err);
  }
}

function appendToFileLog(level: string, message: string, context?: string, metadata?: any) {
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'runtime_errors.log');
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] [${context || 'SYSTEM'}] ${message} ${metadata ? JSON.stringify(metadata) : ''}\n`;
    fs.appendFileSync(logFile, logLine);
  } catch (err) {
    console.error('Failed to write to local log file:', err);
  }
}

export const logger = {
  info: (msg: string, ctx?: string, meta?: any) => log('INFO', msg, ctx, meta),
  warn: (msg: string, ctx?: string, meta?: any) => log('WARN', msg, ctx, meta),
  error: (msg: string, ctx?: string, meta?: any) => log('ERROR', msg, ctx, meta),
  debug: (msg: string, ctx?: string, meta?: any) => log('DEBUG', msg, ctx, meta)
};
