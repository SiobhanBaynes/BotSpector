import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'crypto'
import { secrets } from '../secrets'
import { getCurrentRepositoryProfileId, getSetting } from '../db/repo'
import { getNpxCommand } from '../fixPath'
import {
  buildArgs as buildToolArgs,
  parseJsonFromText as parseToolJson,
  type McpTool
} from './toolUtils'

export type { McpTool } from './toolUtils'

/**
 * Manages the connection to the official Azure DevOps MCP server
 * (`npx -y @azure-devops/mcp <org>`), authenticated with a PAT.
 *
 * The MCP tools are exposed to the review agent; a few helpers below discover
 * and call specific tools directly for deterministic, non-agent operations
 * (like listing pull requests).
 */

interface ConnectionState {
  client: Client | null
  cachedTools: McpTool[] | null
  connecting: Promise<Client> | null
}

interface ConnectionConfig {
  key: string
  org: string
  pat: string
}

const connections = new Map<string, ConnectionState>()

function currentKey(org: string, pat: string): string {
  const credentialHash = createHash('sha256').update(pat).digest('hex')
  return `${org}::${credentialHash}`
}

function currentConfig(): ConnectionConfig {
  const org = getSetting('adoOrg')
  const pat = secrets.getAdoPat(getCurrentRepositoryProfileId())
  if (!org) throw new Error('Azure DevOps organization is not set')
  if (!pat) throw new Error('Azure DevOps PAT is not set')
  return { key: currentKey(org, pat), org, pat }
}

function connectionState(key: string): ConnectionState {
  let state = connections.get(key)
  if (!state) {
    state = { client: null, cachedTools: null, connecting: null }
    connections.set(key, state)
  }
  return state
}

/** Base64 of `email:pat` as required by the ADO MCP server PAT auth. */
function encodePat(pat: string): string {
  return Buffer.from(`pr-reviewer@local:${pat}`, 'utf-8').toString('base64')
}

async function ensureConfigConnected(config: ConnectionConfig): Promise<Client> {
  const state = connectionState(config.key)
  if (state.client) return state.client
  if (state.connecting) return state.connecting

  state.connecting = (async () => {
    const t = new StdioClientTransport({
      command: getNpxCommand(),
      args: [
        '-y',
        // Pinned: `npx -y @azure-devops/mcp` is unpinned and auto-upgrades to the
        // latest release. In 2.9.0 the server renamed/consolidated its tools,
        // which broke our deterministic findTool() lookups. Pin to a known-good
        // version and upgrade deliberately. See docs/TOOLSET.md upstream.
        '@azure-devops/mcp@2.8.1',
        config.org,
        '-d',
        'core',
        'repositories',
        'work',
        'work-items',
        'wiki',
        'search',
        'test-plans',
        'pipelines',
        'advanced-security',
        '-a',
        'pat'
      ],
      env: {
        ...process.env,
        PERSONAL_ACCESS_TOKEN: encodePat(config.pat)
      }
    })

    const c = new Client({ name: 'botspector', version: '0.1.0' }, { capabilities: {} })
    await c.connect(t)
    state.client = c
    state.cachedTools = null
    return c
  })()

  try {
    return await state.connecting
  } finally {
    state.connecting = null
  }
}

export async function ensureConnected(): Promise<Client> {
  return ensureConfigConnected(currentConfig())
}

async function disconnectKey(key: string): Promise<void> {
  const state = connections.get(key)
  if (!state) return
  let activeClient = state.client
  if (!activeClient && state.connecting) {
    try {
      activeClient = await state.connecting
    } catch {
      // A failed connection has nothing to close.
    }
  }
  try {
    await activeClient?.close()
  } catch {
    // ignore
  }
  if (connections.get(key) === state) connections.delete(key)
}

export async function disconnect(): Promise<void> {
  await Promise.all(Array.from(connections.keys(), disconnectKey))
}

function isConnectionError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('not connected') || m.includes('connection closed') || m.includes('closed')
}

export async function listTools(): Promise<McpTool[]> {
  const config = currentConfig()
  const initialState = connectionState(config.key)
  if (initialState.cachedTools) return initialState.cachedTools
  const load = async (): Promise<McpTool[]> => {
    const c = await ensureConfigConnected(config)
    const state = connectionState(config.key)
    if (state.cachedTools) return state.cachedTools
    const res = await c.listTools()
    state.cachedTools = res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as McpTool['inputSchema']) ?? { type: 'object' }
    }))
    return state.cachedTools
  }
  try {
    return await load()
  } catch (e) {
    if (!isConnectionError((e as Error).message)) throw e
    await disconnectKey(config.key)
    return load()
  }
}

/** Call a tool and return its text content concatenated. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const config = currentConfig()
  const invoke = async (): Promise<string> => {
    const c = await ensureConfigConnected(config)
    const res = await c.callTool({ name, arguments: args })
    const content = (res.content as Array<{ type: string; text?: string }>) ?? []
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n')
    if (res.isError) {
      throw new Error(`MCP tool ${name} error: ${text.slice(0, 500)}`)
    }
    return text
  }
  try {
    return await invoke()
  } catch (e) {
    // If the transport dropped, reconnect once and retry.
    if (!isConnectionError((e as Error).message)) throw e
    await disconnectKey(config.key)
    return invoke()
  }
}

/** Find the first tool whose name matches all of the given substrings. */
export async function findTool(...substrings: string[]): Promise<McpTool | null> {
  const tools = await listTools()
  return tools.find((t) => substrings.every((s) => t.name.toLowerCase().includes(s))) ?? null
}

export function buildArgs(tool: McpTool, values: Record<string, unknown>): Record<string, unknown> {
  return buildToolArgs(tool, values)
}

export function parseJsonFromText(text: string): unknown {
  return parseToolJson(text)
}
