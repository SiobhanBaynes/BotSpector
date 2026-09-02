import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockClient {
  close: ReturnType<typeof vi.fn>
  transport?: { options: { args: string[]; env: Record<string, string> } }
}

const state = vi.hoisted(() => ({
  org: 'org-a',
  profileId: 'profile-a',
  pats: {
    'profile-a': 'shared-pat',
    'profile-b': 'shared-pat'
  } as Record<string, string>,
  clients: [] as MockClient[]
}))

vi.mock('../../../src/main/db/repo', () => ({
  getCurrentRepositoryProfileId: (): string => state.profileId,
  getSetting: (key: string): string => (key === 'adoOrg' ? state.org : '')
}))

vi.mock('../../../src/main/secrets', () => ({
  secrets: { getAdoPat: (profileId: string): string => state.pats[profileId] }
}))

vi.mock('../../../src/main/fixPath', () => ({
  getNpxCommand: (): string => 'npx'
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(public options: { args: string[]; env: Record<string, string> }) {}
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class implements MockClient {
    close = vi.fn(async () => undefined)
    transport?: { options: { args: string[]; env: Record<string, string> } }

    constructor() {
      state.clients.push(this)
    }

    async connect(transport: {
      options: { args: string[]; env: Record<string, string> }
    }): Promise<void> {
      this.transport = transport
      await Promise.resolve()
    }

    async listTools(): Promise<{ tools: [] }> {
      return { tools: [] }
    }

    async callTool(): Promise<{ content: []; isError: false }> {
      return { content: [], isError: false }
    }
  }
}))

import { disconnect, ensureConnected } from '../../../src/main/mcp/adoClient'

describe('Azure DevOps MCP profile connections', () => {
  beforeEach(async () => {
    await disconnect()
    state.clients.length = 0
    state.org = 'org-a'
    state.profileId = 'profile-a'
    state.pats = {
      'profile-a': 'shared-pat',
      'profile-b': 'shared-pat'
    }
  })

  afterEach(async () => {
    await disconnect()
  })

  it('keeps concurrent organizations on separate live clients', async () => {
    const orgA = ensureConnected()
    state.org = 'org-b'
    const orgB = ensureConnected()

    const [clientA, clientB] = await Promise.all([orgA, orgB])

    expect(clientA).not.toBe(clientB)
    expect(state.clients.map((client) => client.transport?.options.args[2])).toEqual([
      'org-a',
      'org-b'
    ])
    expect(state.clients[0].close).not.toHaveBeenCalled()
    expect(state.clients[1].close).not.toHaveBeenCalled()
  })

  it('reuses the client for another profile in the same organization', async () => {
    const first = await ensureConnected()
    state.profileId = 'profile-b'
    const second = await ensureConnected()

    expect(second).toBe(first)
    expect(state.clients).toHaveLength(1)
  })

  it('keeps different profile PATs on separate clients in the same organization', async () => {
    state.pats['profile-b'] = 'different-pat'

    const profileA = ensureConnected()
    state.profileId = 'profile-b'
    const profileB = ensureConnected()

    const [clientA, clientB] = await Promise.all([profileA, profileB])

    expect(clientA).not.toBe(clientB)
    expect(state.clients).toHaveLength(2)
    expect(
      state.clients.map((client) => client.transport?.options.env.PERSONAL_ACCESS_TOKEN)
    ).toEqual([
      Buffer.from('pr-reviewer@local:shared-pat').toString('base64'),
      Buffer.from('pr-reviewer@local:different-pat').toString('base64')
    ])
  })

  it('closes every cached client before credentials are reused', async () => {
    const profileA = await ensureConnected()
    state.profileId = 'profile-b'
    state.pats['profile-b'] = 'different-pat'
    const profileB = await ensureConnected()

    await disconnect()

    expect(profileA.close).toHaveBeenCalledOnce()
    expect(profileB.close).toHaveBeenCalledOnce()

    const replacement = await ensureConnected()
    expect(replacement).not.toBe(profileB)
    expect(state.clients).toHaveLength(3)
  })
})
