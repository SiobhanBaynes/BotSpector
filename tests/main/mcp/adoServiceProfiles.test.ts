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
import {
  fetchCurrentUserDisplayName,
  listPullRequests,
  replyAndResolvePullRequestThread
} from '../../../src/main/mcp/adoService'

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

  it('posts a reply before resolving its Azure DevOps thread', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(replyAndResolvePullRequestThread(42, 17, 'Fixed in `abc12345`.')).resolves.toEqual(
      { resolved: true, warning: null }
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST')
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('PATCH')
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(
      JSON.stringify({ status: 'fixed' })
    )
  })

  it('reports a posted reply without retrying it when resolving fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 403 })
    vi.stubGlobal('fetch', fetchMock)

    const result = await replyAndResolvePullRequestThread(42, 17, 'Fixed.')

    expect(result.resolved).toBe(false)
    expect(result.warning).toContain('reply was posted')
    expect(result.warning).toContain('(403)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
