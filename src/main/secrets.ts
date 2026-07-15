import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'

/**
 * Encrypted-at-rest secret storage using Electron's safeStorage (OS keychain
 * backed). Secrets are never written to the SQLite database in plaintext.
 */

interface SecretStoreShape {
  [key: string]: string // base64 of encrypted buffer
}

const SECRET_KEYS = {
  adoPat: 'adoPat',
  githubToken: 'githubToken'
} as const

function secretsPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'secrets.json')
}

function readStore(): SecretStoreShape {
  const p = secretsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SecretStoreShape
  } catch {
    return {}
  }
}

function writeStore(store: SecretStoreShape): void {
  writeFileSync(secretsPath(), JSON.stringify(store), { mode: 0o600 })
}

function setSecret(key: string, value: string | null): void {
  const store = readStore()
  if (value === null || value === '') {
    delete store[key]
  } else if (safeStorage.isEncryptionAvailable()) {
    store[key] = safeStorage.encryptString(value).toString('base64')
  } else {
    // Fallback: base64 (not secure, but keeps app functional on unsupported OS).
    store[key] = Buffer.from(value, 'utf-8').toString('base64')
  }
  writeStore(store)
}

function getSecret(key: string): string | null {
  const store = readStore()
  const raw = store[key]
  if (!raw) return null
  const buf = Buffer.from(raw, 'base64')
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf)
    }
    return buf.toString('utf-8')
  } catch {
    return null
  }
}

export const secrets = {
  setAdoPat: (pat: string | null) => setSecret(SECRET_KEYS.adoPat, pat),
  getAdoPat: () => getSecret(SECRET_KEYS.adoPat),
  setGithubToken: (token: string | null) => setSecret(SECRET_KEYS.githubToken, token),
  getGithubToken: () => getSecret(SECRET_KEYS.githubToken)
}
