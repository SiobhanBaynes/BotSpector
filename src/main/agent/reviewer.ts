import { z } from 'zod'
import { complete, type AgentMessage, type ToolDefinition } from '../copilot/client'
import { callTool, listTools } from '../mcp/adoClient'
import { getPullRequestContext } from '../mcp/adoService'
import { logger } from '../logger'
import { FINDING_BUCKETS } from '../../shared/types'
import type { CommentReply, Finding, PostedComment, ResolutionAssessment } from '../../shared/types'
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
const OUTPUT_FORMAT_INSTRUCTIONS = `You have tools to read the pull request and its files from Azure DevOps. The
changed files are already listed in the provided context — read the specific
ones you need with the file-content tool. Do NOT try to fetch the entire pull
request diff or all changes in one call; work file by file. When you are finished,
respond with ONLY a JSON object of
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

// Tools that return the entire PR at once are excluded: their payloads are
// often >1M chars, get truncated to a useless fragment, and the model then
// re-calls them and burns its whole turn budget. The changed-file list is
// already in the seed context, and the model reads specifics via the
// file-content tool.
const EXCLUDED_TOOLS = [/pull_request_changes/i]

async function mcpToolsAsDefinitions(): Promise<ToolDefinition[]> {
  const tools = await listTools()
  return tools
    .filter((t) => !EXCLUDED_TOOLS.some((re) => re.test(t.name)))
    .map((t) => ({
      name: t.name,
      description: t.description.slice(0, 1024),
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' }
    }))
}

export type ProgressFn = (message: string) => void

const MAX_TOOL_ITERATIONS = 12

// Per-tool-result cap appended to the transcript, so one huge tool response
// can't blow past the model's prompt-token limit across turns.
const MAX_TOOL_RESULT_CHARS = 12000

// Turn an Azure DevOps comment-thread status into a plain-language resolution.
function threadStatusLabel(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'fixed':
      return 'resolved'
    case 'closed':
      return 'closed'
    case 'wontfix':
      return "won't fix"
    case 'bydesign':
      return 'by design'
    case 'active':
    case 'pending':
      return 'still active / unresolved'
    default:
      return 'unknown'
  }
}

// Build a context block describing comments posted in previous reviews so the
// model can avoid re-raising already-resolved issues and factor in discussion.
function buildPriorCommentsBlock(priorComments: PostedComment[]): string {
  if (priorComments.length === 0) return ''
  const entries = priorComments.map((c) => {
    const header = `- [${c.findingPublicId ?? 'prev'} · ${c.bucket ?? 'n/a'}] ${
      c.findingTitle ?? ''
    }`.trim()
    const status = `  Status on Azure DevOps: ${threadStatusLabel(c.threadStatus)}`
    const comment = `  Comment we posted: ${c.commentText}`
    const discussion =
      c.replies.length > 0
        ? '  Discussion:\n' + c.replies.map((r) => `    - ${r.author}: ${r.text}`).join('\n')
        : '  Discussion: (no replies)'
    return [header, status, comment, discussion].join('\n')
  })
  return (
    `\n\nComments from previous reviews of this PR, with their current resolution status ` +
    `and discussion. Take these into account: do NOT re-raise an issue that was already ` +
    `resolved, closed, marked "won't fix", or "by design" unless the code has clearly ` +
    `regressed. If an issue is still active/unresolved and remains valid, you may raise it ` +
    `again. Consider the discussion when deciding.\n\n` +
    entries.join('\n\n')
  )
}

export async function reviewPullRequest(
  adoPrId: number,
  model: string,
  instructions?: string,
  onProgress: ProgressFn = () => {},
  priorComments: PostedComment[] = []
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
        `${context.summary || '(no details fetched; use tools to gather them)'}` +
        `${buildPriorCommentsBlock(priorComments)}\n\n` +
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
          content:
            toolResult.length > MAX_TOOL_RESULT_CHARS
              ? toolResult.slice(0, MAX_TOOL_RESULT_CHARS) +
                `\n\n[…truncated ${toolResult.length - MAX_TOOL_RESULT_CHARS} more characters. ` +
                `Read specific files with the file-content tool instead of fetching everything at once.]`
              : toolResult
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
    // Ran out of tool iterations without a report. Rather than failing the whole
    // review, force a final answer from what was already gathered.
    onProgress('Compiling findings…')
    messages.push({
      role: 'user',
      content:
        'Stop calling tools. Based only on the information already gathered above, ' +
        'produce your final JSON findings report now, in the required format.'
    })
    const finalResult = await complete({ model, messages })
    finalContent = finalResult.content ?? ''
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

export async function assessFindingResolution(
  input: {
    finding: Finding
    commentText: string
    replies: CommentReply[]
    codeText: string
  },
  model: string
): Promise<ResolutionAssessment> {
  const { finding, commentText, replies, codeText } = input
  const conversation = replies.length
    ? replies.map((r) => `${r.author}: ${r.text}`).join('\n\n')
    : '(no replies)'
  const result = await complete({
    model,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content:
          'You judge whether a code-review finding has been resolved. You are given the original ' +
          'finding, the review comment we posted, the author\'s replies, and the current version of ' +
          'the relevant code. Decide whether the finding is now resolved. Respond ONLY with a JSON ' +
          'object of the form {"verdict": "resolved" | "unresolved" | "unclear", "explanation": "<one short paragraph>"}. ' +
          'Use "resolved" only when the current code and/or the reply clearly address the finding. ' +
          'Use "unclear" if the provided information is insufficient to decide.'
      },
      {
        role: 'user',
        content:
          `Finding [${finding.bucket}] ${finding.title}\n` +
          `${finding.description}\n` +
          `File: ${finding.filePath ?? 'n/a'}${finding.line ? `:${finding.line}` : ''}\n\n` +
          `Review comment we posted:\n${commentText}\n\n` +
          `Author replies:\n${conversation}\n\n` +
          `Current code around the finding:\n${codeText || '(unavailable)'}`
      }
    ]
  })
  const raw = extractJsonObject(result.content ?? '')
  try {
    const parsed = JSON.parse(raw) as Partial<ResolutionAssessment>
    const verdict =
      parsed.verdict === 'resolved' || parsed.verdict === 'unresolved'
        ? parsed.verdict
        : 'unclear'
    const explanation = (parsed.explanation ?? '').trim()
    return { verdict, explanation: explanation || 'No explanation provided.' }
  } catch {
    return { verdict: 'unclear', explanation: (result.content ?? '').trim() || 'Could not assess.' }
  }
}

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

export async function explainFileChange(
  path: string,
  diffText: string,
  model: string
): Promise<string> {
  const result = await complete({
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You explain a single file\u2019s code change to a reviewer in plain, approachable ' +
          'language. Summarize what changed and the likely intent and impact, in a short ' +
          'paragraph or a few bullet points. Keep jargon minimal and define any needed terms ' +
          'briefly. Do not restate the diff line by line.'
      },
      {
        role: 'user',
        content: `Explain the change to \`${path}\`:\n\n\`\`\`diff\n${diffText}\n\`\`\``
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
