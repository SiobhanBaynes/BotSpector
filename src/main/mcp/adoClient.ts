import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { secrets } from '../secrets'
import { getSetting } from '../db/repo'

/**
 * Manages the connection to the official Azure DevOps MCP server
 * (`npx -y @azure-devops/mcp <org>`), authenticated with a PAT.
 *
 * The MCP tools are exposed to the review agent; a few helpers below discover
 * and call specific tools directly for deterministic, non-agent operations
 * (like listing pull requests).
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

let client: Client | null = null
let transport: StdioClientTransport | null = null
let cachedTools: McpTool[] | null = null
let connectKey = '' // org + pat fingerprint, so we reconnect when settings change
let connecting: Promise<Client> | null = null // in-flight connection (mutex)

function currentKey(org: string, pat: string): string {
  return `${org}::${pat.slice(0, 6)}:${pat.length}`
}

/** Base64 of `email:pat` as required by the ADO MCP server PAT auth. */
function encodePat(pat: string): string {
  return Buffer.from(`pr-reviewer@local:${pat}`, 'utf-8').toString('base64')
}

export async function ensureConnected(): Promise<Client> {
  const org = getSetting('adoOrg')
  const pat = secrets.getAdoPat()
  if (!org) throw new Error('Azure DevOps organization is not set')
  if (!pat) throw new Error('Azure DevOps PAT is not set')

  const key = currentKey(org, pat)
  if (client && key === connectKey) return client

  // If a connection is already being established, reuse it instead of racing.
  if (connecting) return connecting

  connecting = (async () => {
    await disconnect()

    const t = new StdioClientTransport({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: [
        '-y',
        '@azure-devops/mcp',
        org,
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
        PERSONAL_ACCESS_TOKEN: encodePat(pat)
      }
    })

    const c = new Client({ name: 'botspector', version: '0.1.0' }, { capabilities: {} })
    await c.connect(t)
    transport = t
    client = c
    connectKey = key
    cachedTools = null
    return c
  })()

  try {
    return await connecting
  } finally {
    connecting = null
  }
}

export async function disconnect(): Promise<void> {
  try {
    await client?.close()
  } catch {
    // ignore
  }
  client = null
  transport = null
  cachedTools = null
  connectKey = ''
}

function isConnectionError(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('not connected') || m.includes('connection closed') || m.includes('closed')
}

export async function listTools(): Promise<McpTool[]> {
  if (cachedTools) return cachedTools
  const load = async (): Promise<McpTool[]> => {
    const c = await ensureConnected()
    const res = await c.listTools()
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as McpTool['inputSchema']) ?? { type: 'object' }
    }))
  }
  try {
    cachedTools = await load()
  } catch (e) {
    if (!isConnectionError((e as Error).message)) throw e
    await disconnect()
    cachedTools = await load()
  }
  return cachedTools
}

/** Call a tool and return its text content concatenated. */
export async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const invoke = async (): Promise<string> => {
    const c = await ensureConnected()
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
    await disconnect()
    return invoke()
  }
}

/** Find the first tool whose name matches all of the given substrings. */
export async function findTool(...substrings: string[]): Promise<McpTool | null> {
  const tools = await listTools()
  return (
    tools.find((t) => substrings.every((s) => t.name.toLowerCase().includes(s))) ?? null
  )
}

/**
 * Build an argument object for a tool, only including keys the tool actually
 * declares in its input schema (defensive against version differences).
 */
export function buildArgs(
  tool: McpTool,
  values: Record<string, unknown>
): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {}
  const args: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(values)) {
    if (val !== undefined && val !== null && key in props) {
      args[key] = val
    }
  }
  return args
}

/** Extract a JSON value from a tool's text output, tolerating surrounding prose. */
export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // fall through to bracket extraction
  }
  const firstArr = trimmed.indexOf('[')
  const firstObj = trimmed.indexOf('{')
  const start =
    firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstArr, firstObj)
  if (start === -1) return null
  const open = trimmed[start]
  const close = open === '[' ? ']' : '}'
  const end = trimmed.lastIndexOf(close)
  if (end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}
