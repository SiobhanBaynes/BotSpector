import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface MockClient {
  close: ReturnType<typeof vi.fn>
  transport?: { options: { args: string[] } }
}

const state = vi.hoisted(() => ({
  org: 'org-a',
  clients: [] as MockClient[]
}))

vi.mock('../../../src/main/db/repo', () => ({
  getSetting: (key: string): string => (key === 'adoOrg' ? state.org : '')
}))

vi.mock('../../../src/main/secrets', () => ({
  secrets: { getAdoPat: (): string => 'shared-pat' }
}))

vi.mock('../../../src/main/fixPath', () => ({
  getNpxCommand: (): string => 'npx'
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(public options: { args: string[] }) {}
  }
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class implements MockClient {
    close = vi.fn(async () => undefined)
    transport?: { options: { args: string[] } }

    constructor() {
      state.clients.push(this)
    }

    async connect(transport: { options: { args: string[] } }): Promise<void> {
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
    const second = await ensureConnected()

    expect(second).toBe(first)
    expect(state.clients).toHaveLength(1)
  })
})
