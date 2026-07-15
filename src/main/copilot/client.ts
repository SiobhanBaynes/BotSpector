import { getCopilotToken } from './auth'
import { logger } from '../logger'
import type { CopilotModel } from '../../shared/types'

/**
 * Client over the GitHub Copilot model endpoints.
 *
 * Copilot exposes two chat surfaces:
 *   - /chat/completions  (OpenAI Chat Completions shape) — most models
 *   - /responses         (OpenAI Responses shape)        — newer models
 *     (e.g. GPT-5.x "Sol"/"Terra") that reject /chat/completions.
 *
 * We expose a single normalized `complete()` that picks the right endpoint per
 * model (trying chat first, falling back to responses on
 * `unsupported_api_for_model`) and returns a normalized result. Works for both
 * GPT and Claude models.
 */

const API_BASE = 'https://api.githubcopilot.com'
const EDITOR_VERSION = 'vscode/1.95.0'
const INTEGRATION_ID = 'vscode-chat'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CompletionResult {
  content: string | null
  toolCalls: ToolCall[]
}

export interface CompleteOptions {
  model: string
  messages: AgentMessage[]
  tools?: ToolDefinition[]
  temperature?: number
}

// Remember which endpoint a model needs so we don't re-probe every call.
type Endpoint = 'chat' | 'responses'
const modelEndpoint = new Map<string, Endpoint>()

async function copilotHeaders(): Promise<Record<string, string>> {
  const token = await getCopilotToken()
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Editor-Version': EDITOR_VERSION,
    'Copilot-Integration-Id': INTEGRATION_ID,
    'User-Agent': 'BotSpector/0.1.0'
  }
}

function isUnsupportedApiError(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('unsupported_api_for_model') ||
    m.includes('not accessible via the /chat/completions') ||
    m.includes('unsupported_api')
  )
}

export async function complete(opts: CompleteOptions): Promise<CompletionResult> {
  const known = modelEndpoint.get(opts.model)
  if (known === 'responses') return callResponses(opts)
  if (known === 'chat') return callChat(opts)

  // Unknown model: try chat first, fall back to responses on API-mismatch.
  try {
    const result = await callChat(opts)
    modelEndpoint.set(opts.model, 'chat')
    logger.info(`copilot: model ${opts.model} uses /chat/completions`)
    return result
  } catch (e) {
    const msg = (e as Error).message
    if (isUnsupportedApiError(msg)) {
      logger.info(`copilot: model ${opts.model} falling back to /responses`)
      const result = await callResponses(opts)
      modelEndpoint.set(opts.model, 'responses')
      return result
    }
    logger.error(`copilot: completion failed for ${opts.model}`, { error: msg })
    throw e
  }
}

// ---- /chat/completions ----

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string | null
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
    }
  }>
}

async function callChat(opts: CompleteOptions): Promise<CompletionResult> {
  const messages = opts.messages.map((m) => {
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content ?? '',
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments }
              }))
            }
          : {})
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content }
    }
    return { role: m.role, content: m.content }
  })

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.1
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }))
    body.tool_choice = 'auto'
  }

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: await copilotHeaders(),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Copilot chat failed (${res.status}): ${text.slice(0, 500)}`)
  }
  const data = (await res.json()) as ChatCompletionResponse
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error('Copilot returned no choices')
  return {
    content: msg.content ?? null,
    toolCalls: (msg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    }))
  }
}

// ---- /responses ----

interface ResponsesResponse {
  output_text?: string
  output?: Array<{
    type: string
    role?: string
    content?: Array<{ type: string; text?: string }>
    id?: string
    call_id?: string
    name?: string
    arguments?: string
  }>
}

async function callResponses(opts: CompleteOptions): Promise<CompletionResult> {
  const input: unknown[] = []
  for (const m of opts.messages) {
    if (m.role === 'system' || m.role === 'user') {
      input.push({ role: m.role, content: [{ type: 'input_text', text: m.content }] })
    } else if (m.role === 'assistant') {
      if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        })
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
    }
  }

  const body: Record<string, unknown> = { model: opts.model, input, stream: false }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
    body.tool_choice = 'auto'
  }

  const res = await fetch(`${API_BASE}/responses`, {
    method: 'POST',
    headers: await copilotHeaders(),
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Copilot responses failed (${res.status}): ${text.slice(0, 500)}`)
  }
  const data = (await res.json()) as ResponsesResponse

  const toolCalls: ToolCall[] = []
  const textParts: string[] = []
  for (const item of data.output ?? []) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        arguments: item.arguments ?? '{}'
      })
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && c.text) textParts.push(c.text)
      }
    }
  }
  const content = textParts.length > 0 ? textParts.join('') : data.output_text ?? null
  return { content, toolCalls }
}

interface ModelsResponse {
  data: Array<{
    id: string
    name?: string
    vendor?: string
    model_picker_enabled?: boolean
    capabilities?: {
      type?: string
      supports?: { tool_calls?: boolean }
    }
  }>
}

/** List models, filtered to selectable, chat-capable latest Claude + GPT models. */
export async function listModels(): Promise<CopilotModel[]> {
  const res = await fetch(`${API_BASE}/models`, {
    method: 'GET',
    headers: await copilotHeaders()
  })
  if (!res.ok) {
    throw new Error(`Failed to list Copilot models (${res.status})`)
  }
  const data = (await res.json()) as ModelsResponse
  const seen = new Set<string>()
  const models: CopilotModel[] = []
  for (const m of data.data ?? []) {
    const id = m.id ?? ''
    if (!id || seen.has(id)) continue

    // Only chat-capable models exposed in the picker are usable here.
    const isChat = (m.capabilities?.type ?? 'chat') === 'chat'
    const pickerEnabled = m.model_picker_enabled !== false
    if (!isChat || !pickerEnabled) continue

    const vendor = (m.vendor ?? '').toLowerCase()
    const lid = id.toLowerCase()
    const isClaude = vendor.includes('anthropic') || lid.includes('claude')
    const isGpt =
      vendor.includes('openai') || lid.includes('gpt') || /^o\d/.test(lid)
    if (!isClaude && !isGpt) continue

    seen.add(id)
    models.push({
      id,
      name: m.name ?? id,
      vendor: isClaude ? 'Anthropic' : 'OpenAI'
    })
  }
  return models
}
