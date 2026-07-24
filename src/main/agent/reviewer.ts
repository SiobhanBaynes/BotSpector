import { z } from 'zod'
import { complete, type AgentMessage, type ToolDefinition } from '../copilot/client'
import { callTool, listTools } from '../mcp/adoClient'
import { getPullRequestContext } from '../mcp/adoService'
import { logger } from '../logger'
import { FINDING_BUCKETS } from '../../shared/types'
import type {
  ChatMessage,
  CommentReply,
  Finding,
  PostedComment,
  ResolutionAssessment
} from '../../shared/types'
import type { FindingContribution, NewFinding } from '../db/repo'

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
  ],
  "additions": [
    {
      "id": "F-007",
      "note": "what you'd add to this existing finding"
    }
  ]
}
Put only genuinely NEW issues in "findings". If another agent already reported an
issue (see "Existing findings" in the context), do NOT repeat it as a new finding.
Instead, if you agree with it or have something to add, reference its existing id
in "additions" with a short note. Omit "additions" (or use []) if you have nothing
to add.`

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

const additionSchema = z.object({
  id: z.string(),
  note: z.string().optional()
})

const reportSchema = z.object({
  findings: z.array(findingSchema),
  additions: z.array(additionSchema).optional()
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

// Build a context block listing findings other models already raised on this PR,
// so a new agent avoids duplicating them and can contribute to them instead.
function buildExistingFindingsBlock(existingFindings: Finding[]): string {
  if (existingFindings.length === 0) return ''
  const entries = existingFindings.map((f) => {
    const loc = f.filePath ? ` (${f.filePath}${f.line ? `:${f.line}` : ''})` : ''
    return `- ${f.publicId} [${f.bucket}] raised by ${f.model || 'a prior agent'}${loc}: ${f.title}\n    ${f.description}`
  })
  return (
    `\n\nExisting findings already raised on this PR by other agents. Do NOT repeat any ` +
    `of these as new findings. If you agree with one or have something to add, reference ` +
    `its id in "additions" instead. Only report genuinely new issues in "findings".\n\n` +
    entries.join('\n')
  )
}

export async function reviewPullRequest(
  adoPrId: number,
  model: string,
  instructions?: string,
  onProgress: ProgressFn = () => {},
  priorComments: PostedComment[] = [],
  existingFindings: Finding[] = []
): Promise<{ findings: NewFinding[]; additions: FindingContribution[]; raw: string }> {
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
        `${buildPriorCommentsBlock(priorComments)}` +
        `${buildExistingFindingsBlock(existingFindings)}\n\n` +
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
  let report = tryParseReport(finalContent)
  if (!report) {
    // Some models (notably Claude) wrap their answer in prose or markdown despite
    // the instructions, so the JSON can't be parsed. Ask once for a clean re-emit.
    messages.push({ role: 'assistant', content: finalContent })
    messages.push({
      role: 'user',
      content:
        'Your previous message was not valid JSON. Reply with ONLY the JSON object in the ' +
        'required format — no prose, no explanation, no markdown code fences.'
    })
    const repair = await complete({ model, messages })
    const repaired = repair.content ?? ''
    report = tryParseReport(repaired)
    if (report) finalContent = repaired
  }
  if (!report) throw new Error('The model did not return valid JSON findings.')
  return { findings: report.findings, additions: report.additions, raw: finalContent }
}

/** Parse the model's report, returning null (rather than throwing) on failure. */
function tryParseReport(content: string): {
  findings: NewFinding[]
  additions: FindingContribution[]
} | null {
  const jsonText = extractJsonObject(content)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return null
  }
  const report = reportSchema.safeParse(parsed)
  if (!report.success) return null

  const findings = report.data.findings.map((f, idx) => ({
    publicId: f.id?.trim() || `F-${String(idx + 1).padStart(3, '0')}`,
    bucket: normalizeBucket(f.bucket),
    title: f.title.trim(),
    description: f.description.trim(),
    filePath: f.file?.trim() ? f.file.trim() : null,
    line: typeof f.line === 'number' ? f.line : null
  }))

  const additions = (report.data.additions ?? [])
    .map((a) => ({ publicId: a.id.trim(), note: (a.note ?? '').trim() }))
    .filter((a) => a.publicId)

  return { findings, additions }
}

// Extract the first balanced JSON object from arbitrary model output, tolerating
// surrounding prose and markdown fences and ignoring braces inside strings.
function extractJsonObject(text: string): string {
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  if (start === -1) return s
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
    } else if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return s.slice(start)
}

// ---- single-shot helpers for per-finding actions ----

const CHAT_SYSTEM_PROMPT = `You are a helpful, knowledgeable assistant embedded in a code-review tool.
You answer a reviewer's questions about one specific Azure DevOps pull request.
You are given the PR's context, the current review findings, and any comments
posted in previous reviews. You also have Azure DevOps tools to read the changed
files and other PR details on demand — use them when you need specifics you don't
already have. Be concise, practical, and honest. Use plain language, reference
finding IDs and file paths where helpful, and say when you're unsure.

IMPORTANT: When you need to inspect a file or PR detail, call the tool directly in
the same turn. Do NOT reply with only a statement of intent like "I'll check the
Dockerfile" and then stop — either make the tool calls now or give your actual
answer. Only send a plain-text reply once you can genuinely answer the question.`

// A reply that only announces intent to act (and made no tool calls) — we nudge
// the model to actually proceed instead of ending the turn here.
function looksLikeIntentOnly(content: string): boolean {
  const c = content.trim()
  if (c.length > 400) return false
  return /^(sure[,.!]?\s*)?(ok(ay)?[,.!]?\s*)?(i'?ll|i will|let me|let's|first,? i|i'?m going to|i am going to)\b/i.test(
    c
  )
}

/**
 * Free-form chat about a single PR. Seeds the conversation with the PR context,
 * the review findings, and prior comments, then runs the tool-enabled agent loop
 * over the reviewer's message history and returns the assistant's reply.
 */
export async function chatAboutPullRequest(
  input: {
    adoPrId: number
    findingsSummary: string
    priorComments: PostedComment[]
    history: ChatMessage[]
  },
  model: string
): Promise<string> {
  const { adoPrId, findingsSummary, priorComments, history } = input
  const context = await getPullRequestContext(adoPrId)
  const tools = await mcpToolsAsDefinitions()

  const messages: AgentMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    {
      role: 'system',
      content:
        `Context for pull request #${adoPrId}:\n\n` +
        `${context.summary || '(no details fetched; use tools to gather them)'}\n\n` +
        `Current review findings:\n${findingsSummary || '(no review has been run yet)'}` +
        `${buildPriorCommentsBlock(priorComments)}`
    },
    ...history.map((m) => ({ role: m.role, content: m.content }) as AgentMessage)
  ]

  let finalContent: string | null = null
  let nudged = false
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await complete({ model, messages, tools })
    if (result.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
      for (const call of result.toolCalls) {
        let toolResult: string
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {}
          toolResult = await callTool(call.name, args)
        } catch (e) {
          toolResult = `Error: ${(e as Error).message}`
        }
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content:
            toolResult.length > MAX_TOOL_RESULT_CHARS
              ? toolResult.slice(0, MAX_TOOL_RESULT_CHARS) +
                `\n\n[…truncated ${toolResult.length - MAX_TOOL_RESULT_CHARS} more characters.]`
              : toolResult
        })
      }
      continue
    }
    const content = result.content ?? ''
    // The model announced it would use a tool but didn't actually call one and
    // just stopped. Nudge it once to follow through rather than returning the
    // empty promise to the user.
    if (!nudged && looksLikeIntentOnly(content)) {
      nudged = true
      messages.push({ role: 'assistant', content })
      messages.push({
        role: 'user',
        content:
          'Go ahead and do that now: make the tool calls you need, then give me your answer.'
      })
      continue
    }
    finalContent = content
    break
  }

  if (finalContent === null) {
    messages.push({
      role: 'user',
      content: 'Stop calling tools and answer now based on what you already have.'
    })
    const finalResult = await complete({ model, messages })
    finalContent = finalResult.content ?? ''
  }
  return finalContent.trim()
}

const CHAT_FINDING_SYSTEM_PROMPT = `You convert a code-review discussion into a single structured review finding.
Given an assistant message from a pull-request chat (and the PR context), extract
the one concrete issue it describes into a finding.
- Choose exactly one bucket: "Blocking", "High", "Medium", "Low", or "Nit".
- Write a short, actionable title and a concise, plain-language description that
  includes the suggested fix.
- Set "file" to the most relevant changed file path (or null) and "line" to the
  most relevant line number (or null).
Respond with ONLY a JSON object of this exact shape (no prose, no markdown fences):
{"bucket":"High","title":"...","description":"...","file":"path or null","line":123}`

/**
 * Turn an assistant chat message into a single structured finding. Uses the PR
 * context (changed files, etc.) so the model can attribute a file/line, and
 * returns a NewFinding ready to persist.
 */
export async function extractFindingFromChat(
  input: { adoPrId: number; assistantMessage: string; history: ChatMessage[] },
  model: string
): Promise<NewFinding> {
  const { adoPrId, assistantMessage, history } = input
  const context = await getPullRequestContext(adoPrId)

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  const messages: AgentMessage[] = [
    { role: 'system', content: CHAT_FINDING_SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Pull request #${adoPrId} context:\n\n` +
        `${context.summary || '(no details available)'}\n\n` +
        `Recent conversation:\n${recent}\n\n` +
        `Turn the following assistant message into one finding:\n\n${assistantMessage}`
    }
  ]

  const result = await complete({ model, messages })
  let raw = (result.content ?? '').trim()
  // Strip markdown fences if the model added them despite instructions.
  raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Fall back to the first {...} block if there's stray prose around it.
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('Could not turn that message into a finding — no JSON returned.')
    parsed = JSON.parse(match[0])
  }

  const finding = findingSchema.parse(parsed)
  return {
    publicId: '',
    bucket: normalizeBucket(finding.bucket),
    title: finding.title,
    description: finding.description,
    filePath: finding.file ?? null,
    line: finding.line ?? null
  }
}

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
