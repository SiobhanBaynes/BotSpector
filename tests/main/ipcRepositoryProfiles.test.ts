import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { IPC } from '../../src/shared/ipc'
import type {
  IpcResult,
  RepositoryProfile,
  RepositoryProfileInput,
  Settings
} from '../../src/shared/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../src/main/db/repo', () => ({
  listRepositoryProfiles: vi.fn(),
  saveRepositoryProfile: vi.fn(),
  getActiveRepositoryProfile: vi.fn(),
  getSetting: vi.fn()
}))
vi.mock('../../src/main/secrets', () => ({
  secrets: {
    migrateLegacyAdoPat: vi.fn(),
    assertSecureStorageAvailable: vi.fn(),
    getAdoPat: vi.fn(),
    setAdoPat: vi.fn()
  }
}))
vi.mock('../../src/main/copilot/auth', () => ({ isSignedIn: vi.fn() }))
vi.mock('../../src/main/copilot/client', () => ({}))
vi.mock('../../src/main/mcp/adoClient', () => ({ disconnect: vi.fn() }))
vi.mock('../../src/main/mcp/adoService', () => ({}))
vi.mock('../../src/main/agent/reviewer', () => ({}))
vi.mock('../../src/main/agent/skills', () => ({}))
vi.mock('../../src/main/agent/skillStore', () => ({}))
vi.mock('../../src/main/logger', () => ({}))
vi.mock('../../src/main/opencode', () => ({}))

import * as repo from '../../src/main/db/repo'
import { secrets } from '../../src/main/secrets'
import { disconnect } from '../../src/main/mcp/adoClient'
import { registerIpcHandlers } from '../../src/main/ipc'

const source: RepositoryProfile = {
  id: 'source',
  nickname: 'Web',
  adoOrg: 'contoso',
  adoProject: 'BotSpector',
  adoRepo: 'web',
  myIdentity: 'Reviewer',
  localCheckoutPath: ''
}
const destination: RepositoryProfile = {
  ...source,
  id: 'destination',
  nickname: 'API',
  adoRepo: 'api'
}
const input: RepositoryProfileInput = {
  nickname: destination.nickname,
  adoOrg: destination.adoOrg,
  adoProject: destination.adoProject,
  adoRepo: destination.adoRepo,
  myIdentity: destination.myIdentity
}

async function saveProfile(
  changes: Partial<RepositoryProfileInput>,
  profileId: string | null = null
): Promise<IpcResult<Settings>> {
  const handler = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === IPC.repositoryProfileSave)?.[1]
  if (!handler) throw new Error('Repository profile save handler was not registered')
  return handler({} as IpcMainInvokeEvent, profileId, { ...input, ...changes })
}

describe('repository profile PAT reuse IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    const pats = new Map<string, string>([[source.id, 'source-test-credential']])
    vi.mocked(secrets.getAdoPat).mockImplementation((id) => pats.get(id ?? '') ?? null)
    vi.mocked(secrets.setAdoPat).mockImplementation((id, pat) => {
      if (pat) pats.set(id, pat)
      else pats.delete(id)
    })
    vi.mocked(repo.listRepositoryProfiles).mockReturnValue([source])
    vi.mocked(repo.getActiveRepositoryProfile).mockReturnValue(source)
    vi.mocked(repo.getSetting).mockReturnValue('')
    vi.mocked(repo.saveRepositoryProfile).mockImplementation(() => {
      vi.mocked(repo.listRepositoryProfiles).mockReturnValue([source, destination])
      return destination
    })
    registerIpcHandlers()
  })

  it('copies a trimmed source selection without exposing or linking the stored PAT', async () => {
    const result = await saveProfile({ patSourceProfileId: ' source ', pat: '  ' })

    expect(result).toMatchObject({
      ok: true,
      data: {
        repositoryProfiles: [
          { id: source.id, hasAdoPat: true },
          { id: destination.id, hasAdoPat: true }
        ]
      }
    })
    expect(secrets.assertSecureStorageAvailable).toHaveBeenCalledOnce()
    expect(secrets.setAdoPat).toHaveBeenCalledExactlyOnceWith(
      destination.id,
      'source-test-credential'
    )
    expect(disconnect).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toContain('source-test-credential')

    secrets.setAdoPat(source.id, 'rotated-test-credential')
    expect(secrets.getAdoPat(destination.id)).toBe('source-test-credential')
  })

  it.each([
    {
      name: 'a conflicting new PAT',
      changes: { patSourceProfileId: source.id, pat: 'new-test-credential' },
      error: 'Choose an existing PAT or enter a new PAT, not both.'
    },
    {
      name: 'a deleted source profile',
      changes: { patSourceProfileId: 'deleted' },
      error: 'The repository profile selected for PAT reuse no longer exists.'
    },
    {
      name: 'a source without a PAT',
      changes: { patSourceProfileId: source.id },
      error: 'The selected repository profile has no available PAT to copy.'
    }
  ])('rejects $name before saving any profile or credential', async ({ changes, error }) => {
    secrets.setAdoPat(source.id, null)
    vi.mocked(secrets.setAdoPat).mockClear()

    await expect(saveProfile(changes)).resolves.toEqual({ ok: false, error })

    expect(repo.saveRepositoryProfile).not.toHaveBeenCalled()
    expect(secrets.setAdoPat).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('rejects PAT reuse when secure credential storage is unavailable', async () => {
    vi.mocked(secrets.assertSecureStorageAvailable).mockImplementation(() => {
      throw new Error('Secure credential storage is unavailable.')
    })
    vi.mocked(secrets.getAdoPat).mockClear()

    await expect(saveProfile({ patSourceProfileId: source.id })).resolves.toEqual({
      ok: false,
      error: 'Secure credential storage is unavailable.'
    })
    expect(secrets.getAdoPat).not.toHaveBeenCalled()
    expect(repo.saveRepositoryProfile).not.toHaveBeenCalled()
    expect(secrets.setAdoPat).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('still saves a new PAT when the source selection is blank', async () => {
    await expect(
      saveProfile({ patSourceProfileId: '  ', pat: ' new-test-credential ' })
    ).resolves.toMatchObject({ ok: true })

    expect(secrets.setAdoPat).toHaveBeenCalledExactlyOnceWith(destination.id, 'new-test-credential')
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('preserves the stored PAT when editing without either credential input', async () => {
    await expect(saveProfile({}, source.id)).resolves.toMatchObject({ ok: true })

    expect(repo.saveRepositoryProfile).toHaveBeenCalledWith(
      source.id,
      expect.objectContaining(input)
    )
    expect(secrets.getAdoPat(source.id)).toBe('source-test-credential')
    expect(secrets.assertSecureStorageAvailable).not.toHaveBeenCalled()
    expect(secrets.setAdoPat).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })
})
