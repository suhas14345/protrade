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
  const db = getDb();
  const entry: LogEntry = {
    level,
    message,
    context,
    metadata,
    timestamp: Timestamp.now()
  };

  try {
    // Write to a persistent logs collection
    // Use UTC date for partitioning (consistent with Dashboard)
    const dateId = new Date().toISOString().split('T')[0].replace(/-/g, '');
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
