import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  profileId: 'profile-a',
  pats: {
    'profile-a': 'pat-for-profile-a',
    'profile-b': 'pat-for-profile-b'
  } as Record<string, string>
}))

vi.mock('../../../src/main/db/repo', () => ({
  getCurrentRepositoryProfileId: (): string => state.profileId,
  getSetting: (key: string): string =>
    ({ adoOrg: 'contoso', adoProject: 'BotSpector', adoRepo: 'BotSpector' })[key] ?? ''
}))

vi.mock('../../../src/main/secrets', () => ({
  secrets: { getAdoPat: (profileId: string): string => state.pats[profileId] }
}))

vi.mock('../../../src/main/mcp/adoClient', () => ({
  buildArgs: vi.fn(),
  callTool: vi.fn(),
  findTool: vi.fn(),
  parseJsonFromText: vi.fn()
}))

import { callTool } from '../../../src/main/mcp/adoClient'
import { fetchCurrentUserDisplayName, listPullRequests } from '../../../src/main/mcp/adoService'

describe('Azure DevOps REST profile credentials', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    state.profileId = 'profile-a'
  })

  it('captures the current profile PAT for each concurrent request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ authenticatedUser: { customDisplayName: 'Reviewer' } })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const profileA = fetchCurrentUserDisplayName()
    state.profileId = 'profile-b'
    const profileB = fetchCurrentUserDisplayName()

    await expect(Promise.all([profileA, profileB])).resolves.toEqual(['Reviewer', 'Reviewer'])
    const authorizations = fetchMock.mock.calls.map(
      ([, init]) => (init as RequestInit).headers as Record<string, string>
    )
    expect(authorizations.map((headers) => headers.Authorization)).toEqual([
      `Basic ${Buffer.from(':pat-for-profile-a').toString('base64')}`,
      `Basic ${Buffer.from(':pat-for-profile-b').toString('base64')}`
    ])
  })

  it('surfaces a profile PAT rejection without falling back to MCP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401 }))
    )

    await expect(listPullRequests()).rejects.toThrow(
      "Azure DevOps rejected the PAT for BotSpector/BotSpector (401). Update this repository profile's PAT in Settings"
    )
    expect(callTool).not.toHaveBeenCalled()
  })
})
