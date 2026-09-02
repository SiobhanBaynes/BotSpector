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
  legacyAdoPat: 'adoPat',
  legacyAdoPatMigrationBlocked: 'adoPatMigrationBlocked',
  githubToken: 'githubToken'
} as const

const SECURE_STORAGE_ERROR =
  'Secure credential storage is unavailable. Configure an OS-backed keychain and restart BotSpector.'

function isSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function assertSecureStorageAvailable(): void {
  if (!isSecureStorageAvailable()) throw new Error(SECURE_STORAGE_ERROR)
}

function adoPatKey(profileId: string): string {
  return `adoPat:${profileId}`
}

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
  } else {
    assertSecureStorageAvailable()
    store[key] = safeStorage.encryptString(value).toString('base64')
  }
  writeStore(store)
}

function getSecret(key: string): string | null {
  const store = readStore()
  const raw = store[key]
  if (!raw || !isSecureStorageAvailable()) return null
  const buf = Buffer.from(raw, 'base64')
  try {
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export const secrets = {
  assertSecureStorageAvailable,
  setAdoPat: (profileId: string, pat: string | null) => setSecret(adoPatKey(profileId), pat),
  getAdoPat: (profileId: string | null) => (profileId ? getSecret(adoPatKey(profileId)) : null),
  migrateLegacyAdoPat: (profileIds: string[]) => {
    if (getSecret(SECRET_KEYS.legacyAdoPatMigrationBlocked)) {
      setSecret(SECRET_KEYS.legacyAdoPat, null)
      return
    }
    const legacyPat = getSecret(SECRET_KEYS.legacyAdoPat)
    if (!legacyPat) return
    const uniqueProfileIds = [...new Set(profileIds)]
    if (uniqueProfileIds.length === 0) return
    if (uniqueProfileIds.length > 1) {
      setSecret(SECRET_KEYS.legacyAdoPatMigrationBlocked, 'true')
      setSecret(SECRET_KEYS.legacyAdoPat, null)
      return
    }
    const profileId = uniqueProfileIds[0]
    if (!getSecret(adoPatKey(profileId))) setSecret(adoPatKey(profileId), legacyPat)
    setSecret(SECRET_KEYS.legacyAdoPat, null)
  },
  setGithubToken: (token: string | null) => setSecret(SECRET_KEYS.githubToken, token),
  getGithubToken: () => getSecret(SECRET_KEYS.githubToken)
}
