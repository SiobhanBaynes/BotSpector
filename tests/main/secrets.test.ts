import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const state = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
  storageBackend: 'gnome_libsecret'
}))

vi.mock('electron', () => ({
  app: {
    getPath: (): string => state.userDataDir
  },
  safeStorage: {
    isEncryptionAvailable: (): boolean => state.encryptionAvailable,
    getSelectedStorageBackend: (): string => state.storageBackend,
    encryptString: (value: string): Buffer => Buffer.from(`encrypted:${value}`, 'utf-8'),
    decryptString: (value: Buffer): string => {
      const decrypted = value.toString('utf-8')
      if (!decrypted.startsWith('encrypted:')) throw new Error('Invalid encrypted value')
      return decrypted.slice('encrypted:'.length)
    }
  }
}))

import { secrets } from '../../src/main/secrets'

describe('secret storage', () => {
  beforeEach(() => {
    state.userDataDir = mkdtempSync(join(tmpdir(), 'botspector-secrets-'))
    state.encryptionAvailable = true
    state.storageBackend = 'gnome_libsecret'
  })

  afterEach(() => {
    rmSync(state.userDataDir, { recursive: true, force: true })
  })

  it('isolates encrypted Azure DevOps PATs by repository profile', () => {
    secrets.setAdoPat('profile-a', 'pat-a')
    secrets.setAdoPat('profile-b', 'pat-b')

    expect(secrets.getAdoPat('profile-a')).toBe('pat-a')
    expect(secrets.getAdoPat('profile-b')).toBe('pat-b')
    expect(secrets.getAdoPat(null)).toBeNull()

    const stored = readFileSync(join(state.userDataDir, 'secrets.json'), 'utf-8')
    expect(stored).not.toContain('pat-a')
    expect(stored).not.toContain('pat-b')
    expect(Object.keys(JSON.parse(stored) as object).sort()).toEqual([
      'adoPat:profile-a',
      'adoPat:profile-b'
    ])
  })

  it('does not persist credentials when secure storage is unavailable', () => {
    state.encryptionAvailable = false

    expect(() => secrets.setAdoPat('profile-a', 'pat-a')).toThrow(
      'Secure credential storage is unavailable. Configure an OS-backed keychain and restart BotSpector.'
    )
    expect(existsSync(join(state.userDataDir, 'secrets.json'))).toBe(false)
  })

  it('rejects Electron plaintext storage on Linux', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    state.storageBackend = 'basic_text'

    try {
      expect(() => secrets.assertSecureStorageAvailable()).toThrow(
        'Secure credential storage is unavailable. Configure an OS-backed keychain and restart BotSpector.'
      )
    } finally {
      platform.mockRestore()
    }
  })

  it('copies the legacy global PAT when exactly one profile exists', () => {
    const legacyPat = Buffer.from('encrypted:legacy-pat', 'utf-8').toString('base64')
    writeFileSync(join(state.userDataDir, 'secrets.json'), JSON.stringify({ adoPat: legacyPat }))

    secrets.migrateLegacyAdoPat(['profile-a'])

    expect(secrets.getAdoPat('profile-a')).toBe('legacy-pat')
    const stored = JSON.parse(
      readFileSync(join(state.userDataDir, 'secrets.json'), 'utf-8')
    ) as Record<string, string>
    expect(stored).not.toHaveProperty('adoPat')
  })

  it('permanently blocks an ambiguous legacy PAT from automatic assignment', () => {
    const legacyPat = Buffer.from('encrypted:legacy-pat', 'utf-8').toString('base64')
    writeFileSync(join(state.userDataDir, 'secrets.json'), JSON.stringify({ adoPat: legacyPat }))

    secrets.migrateLegacyAdoPat(['profile-a', 'profile-b'])

    expect(secrets.getAdoPat('profile-a')).toBeNull()
    expect(secrets.getAdoPat('profile-b')).toBeNull()
    const stored = JSON.parse(
      readFileSync(join(state.userDataDir, 'secrets.json'), 'utf-8')
    ) as Record<string, string>
    expect(stored).not.toHaveProperty('adoPat')
    expect(stored).toHaveProperty('adoPatMigrationBlocked')

    secrets.migrateLegacyAdoPat(['profile-a'])

    expect(secrets.getAdoPat('profile-a')).toBeNull()
  })
})
