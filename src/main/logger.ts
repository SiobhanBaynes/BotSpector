import { app, shell } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Minimal file + console logger. Writes to Electron's logs directory so issues
 * can be diagnosed after the fact.
 */

function logDir(): string {
  const dir = app.getPath('logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

function logFilePath(): string {
  return join(logDir(), 'app.log')
}

function write(level: string, message: string, meta?: unknown): void {
  const metaStr = meta === undefined ? '' : ' ' + safeStringify(meta)
  const line = `${new Date().toISOString()} [${level}] ${message}${metaStr}\n`
  try {
    appendFileSync(logFilePath(), line)
  } catch {
    // ignore file write errors
  }
  // Also surface in the dev terminal — but never let a broken stdout (e.g. the
  // terminal was closed, causing EIO) crash the main process.
  try {
    process.stdout.write(line)
  } catch {
    // ignore console write errors
  }
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logger = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta)
}

export function openLogs(): Promise<string> {
  return shell.openPath(logFilePath())
}

export function getLogFilePath(): string {
  return logFilePath()
}
