import { z } from 'zod'
import { complete, type AgentMessage, type ToolDefinition } from '../copilot/client'
import { callTool, listTools } from '../mcp/adoClient'
import { getPullRequestContext } from '../mcp/adoService'
import { logger } from '../logger'
import { FINDING_BUCKETS } from '../../shared/types'
import type { Finding } from '../../shared/types'
import type { NewFinding } from '../db/repo'

/**
 * The review agent: feeds a PR to the selected Copilot model with the Azure
 * DevOps MCP tools available, and returns structured findings grouped into
 * severity buckets.
 */

// The editable part of the agent instructions (shown/edited in Settings).
export const DEFAULT_REVIEW_INSTRUCTIONS = `You are a meticulous but pragmatic senior code reviewer.
You review Azure DevOps pull requests and report findings.

Rules for your report:
- Group every finding into exactly one bucket: "Blocking", "High", "Medium", "Low", or "Nit".
- Keep technical jargon to a minimum. Explain issues in plain, approachable language.
- Give each finding its own short unique ID like "F-001", "F-002", ...
- Each finding must have a clear, actionable title and a concise description.
- Where possible, include the file path and line number the finding relates to.
- Only report real, substantiated issues. Do not invent problems. An empty list is fine.`

// The fixed output-format contract, always appended so edits can't break parsing.
const OUTPUT_FORMAT_INSTRUCTIONS = `You have tools to read the pull request and its files from Azure DevOps. Use them to
gather the context you need. When you are finished, respond with ONLY a JSON object of
this exact shape (no prose, no markdown fences):
{
  "findings": [
    {
      "id": "F-001",
      "bucket": "High",
      "title": "short title",
      "description": "plain-language explanation and suggested fix",
      "file": "path/to/file or null",
      "line": 123
    }
  ]
}`

function buildSystemPrompt(instructions?: string): string {
  const guidance = (instructions ?? '').trim() || DEFAULT_REVIEW_INSTRUCTIONS
  return `${guidance}\n\n${OUTPUT_FORMAT_INSTRUCTIONS}`
}

const findingSchema = z.object({
  id: z.string().optional(),
  bucket: z.string(),
  title: z.string(),
  description: z.string(),
  file: z.string().nullable().optional(),
  line: z.number().nullable().optional()
})

const reportSchema = z.object({
  findings: z.array(findingSchema)
})

function normalizeBucket(raw: string): (typeof FINDING_BUCKETS)[number] {
  const match = FINDING_BUCKETS.find((b) => b.toLowerCase() === raw.trim().toLowerCase())
  return match ?? 'Medium'
}

async function mcpToolsAsDefinitions(): Promise<ToolDefinition[]> {
  const tools = await listTools()
  return tools.map((t) => ({
    name: t.name,
    description: t.description.slice(0, 1024),
    parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' }
  }))
}

export type ProgressFn = (message: string) => void

const MAX_TOOL_ITERATIONS = 12

export async function reviewPullRequest(
  adoPrId: number,
  model: string,
  instructions?: string,
  onProgress: ProgressFn = () => {}
): Promise<{ findings: NewFinding[]; raw: string }> {
  onProgress('Gathering pull request context…')
  const context = await getPullRequestContext(adoPrId)
  const tools = await mcpToolsAsDefinitions()

  const messages: AgentMessage[] = [
    { role: 'system', content: buildSystemPrompt(instructions) },
    {
      role: 'user',
      content:
        `Review pull request #${adoPrId}. Here is the context already gathered.\n\n` +
        `${context.summary || '(no details fetched; use tools to gather them)'}\n\n` +
        `Use the available Azure DevOps tools to inspect changed files as needed, then ` +
        `produce your JSON findings report.`
    }
  ]

  let finalContent: string | null = null

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    logger.info(`review pr#${adoPrId}: model turn ${i + 1}/${MAX_TOOL_ITERATIONS}`, { model })
    const result = await complete({ model, messages, tools })

    if (result.toolCalls.length > 0) {
      logger.info(`review pr#${adoPrId}: ${result.toolCalls.length} tool call(s)`, {
        tools: result.toolCalls.map((c) => c.name)
      })
      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
      for (const call of result.toolCalls) {
        onProgress(`Reading Azure DevOps: ${call.name}…`)
        let toolResult: string
        const startedAt = Date.now()
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {}
          toolResult = await callTool(call.name, args)
          logger.info(
            `review pr#${adoPrId}: tool ${call.name} ok (${Date.now() - startedAt}ms, ${toolResult.length} chars)`
          )
        } catch (e) {
          toolResult = `Error: ${(e as Error).message}`
          logger.error(`review pr#${adoPrId}: tool ${call.name} failed`, {
            error: (e as Error).message
          })
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: toolResult.slice(0, 12000)
        })
      }
      continue
    }

    finalContent = result.content ?? ''
    logger.info(`review pr#${adoPrId}: model finished after ${i + 1} turn(s)`, {
      contentChars: finalContent.length
    })
    break
  }

  if (finalContent === null) {
    throw new Error('The review did not complete (too many tool calls).')
  }

  onProgress('Compiling findings…')
  const findings = parseFindings(finalContent)
  return { findings, raw: finalContent }
}

function parseFindings(content: string): NewFinding[] {
  const jsonText = extractJsonObject(content)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new Error('The model did not return valid JSON findings.')
  }
  const report = reportSchema.safeParse(parsed)
  if (!report.success) {
    throw new Error('The model returned findings in an unexpected format.')
  }

  return report.data.findings.map((f, idx) => ({
    publicId: f.id?.trim() || `F-${String(idx + 1).padStart(3, '0')}`,
    bucket: normalizeBucket(f.bucket),
    title: f.title.trim(),
    description: f.description.trim(),
    filePath: f.file?.trim() ? f.file.trim() : null,
    line: typeof f.line === 'number' ? f.line : null
  }))
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return trimmed
  return trimmed.slice(start, end + 1)
}

// ---- single-shot helpers for per-finding actions ----

export async function explainFinding(finding: Finding, model: string): Promise<string> {
  const result = await complete({
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You explain code-review findings to a busy developer in plain language. ' +
          'Be concise (a short paragraph). Avoid jargon. Explain why it matters and how to address it.'
      },
      {
        role: 'user',
        content:
          `Explain this finding in more detail:\n` +
          `Bucket: ${finding.bucket}\nTitle: ${finding.title}\n` +
          `Description: ${finding.description}\n` +
          `File: ${finding.filePath ?? 'n/a'}${finding.line ? `:${finding.line}` : ''}`
      }
    ]
  })
  return (result.content ?? '').trim()
}

export async function explainPullRequest(description: string, model: string): Promise<string> {
  const result = await complete({
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You explain a pull request to a non-expert in plain, approachable language. ' +
          'Summarize what the change does and why, in a short paragraph or a few bullet points. ' +
          'Avoid jargon; if you must use a technical term, briefly define it.'
      },
      {
        role: 'user',
        content: `Explain this pull request description:\n\n${description}`
      }
    ]
  })
  return (result.content ?? '').trim()
}

export async function draftComment(finding: Finding, model: string): Promise<string> {
  const result = await complete({
    model,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You write pull-request review comments. Write a single, polite, constructive ' +
          'comment a reviewer could post directly. Keep jargon to a minimum. Do not include ' +
          'a greeting or sign-off — just the comment body.'
      },
      {
        role: 'user',
        content:
          `Draft a review comment for this finding:\n` +
          `Bucket: ${finding.bucket}\nTitle: ${finding.title}\n` +
          `Description: ${finding.description}\n` +
          `File: ${finding.filePath ?? 'n/a'}${finding.line ? `:${finding.line}` : ''}`
      }
    ]
  })
  return (result.content ?? '').trim()
}

/** Rewrite an existing comment according to a fine-tuning instruction. */
export async function refineComment(
  currentText: string,
  instruction: string,
  model: string
): Promise<string> {
  const result = await complete({
    model,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'You revise a pull-request review comment. Apply the requested change while ' +
          'keeping the original meaning and any specifics (file names, identifiers). ' +
          'Return ONLY the revised comment body — no greeting, sign-off, quotes, or commentary.'
      },
      {
        role: 'user',
        content: `Instruction: ${instruction}\n\nComment to revise:\n${currentText}`
      }
    ]
  })
  return (result.content ?? '').trim()
}
