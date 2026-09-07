import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { constants, existsSync } from 'fs'
import { access, mkdir } from 'fs/promises'
import { createServer } from 'net'
import { homedir } from 'os'
import { basename, delimiter, join, resolve } from 'path'
import { promisify } from 'util'
import type {
  ChatMessage,
  OpenCodeChangedFile,
  OpenCodeStatus,
  PostedComment,
  PullRequest
} from '../shared/types'
import * as repo from './db/repo'

const execFileAsync = promisify(execFile)
const OPEN_CODE_SETTING = 'openCodeExecutablePath'
const SERVER_START_TIMEOUT_MS = 8_000
const API_TIMEOUT_MS = 10_000

interface OpenCodeApiMessage {
  info: {
    id: string
    role: 'user' | 'assistant'
    time?: {
      completed?: number
    }
  }
  parts: Array<{
    type: string
    text?: string
    ignored?: boolean
  }>
}

interface OpenCodeSessionSnapshot {
  messages: OpenCodeApiMessage[]
  changedFiles: OpenCodeChangedFile[]
}

export interface CreatedOpenCodeSession {
  sessionId: string
  worktreePath: string
  branchName: string
  baseCommit: string
  seedMessageId: string | null
}

export async function getOpenCodeStatus(): Promise<OpenCodeStatus> {
  const executablePath = repo.getSetting(OPEN_CODE_SETTING).trim()
  if (!executablePath) {
    return {
      configured: false,
      available: false,
      executablePath: null,
      version: null,
      error: null
    }
  }
  return validateOpenCodeExecutable(executablePath)
}

export async function configureOpenCode(executablePath: string): Promise<OpenCodeStatus> {
  const status = await validateOpenCodeExecutable(executablePath)
  if (!status.available || !status.executablePath) {
    throw new Error(status.error ?? 'The selected file is not a working OpenCode executable.')
  }
  repo.setSetting(OPEN_CODE_SETTING, status.executablePath)
  return { ...status, configured: true }
}

export async function detectOpenCode(): Promise<OpenCodeStatus> {
  for (const candidate of openCodeCandidates()) {
    const status = await validateOpenCodeExecutable(candidate)
    if (status.available && status.executablePath) {
      repo.setSetting(OPEN_CODE_SETTING, status.executablePath)
      return { ...status, configured: true }
    }
  }
  return {
    configured: false,
    available: false,
    executablePath: null,
    version: null,
    error: 'OpenCode was not found. Choose its executable manually.'
  }
}

export function clearOpenCodeConfiguration(): OpenCodeStatus {
  repo.setSetting(OPEN_CODE_SETTING, '')
  return {
    configured: false,
    available: false,
    executablePath: null,
    version: null,
    error: null
  }
}

async function validateOpenCodeExecutable(executablePath: string): Promise<OpenCodeStatus> {
  const normalized = resolve(executablePath.trim())
  try {
    await access(normalized, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    const { stdout, stderr } = await execFileAsync(normalized, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    })
    const output = `${stdout}\n${stderr}`.trim()
    const version = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null
    if (!version) throw new Error('The executable did not report an OpenCode version.')
    return {
      configured: repo.getSetting(OPEN_CODE_SETTING).trim() === normalized,
      available: true,
      executablePath: normalized,
      version,
      error: null
    }
  } catch (error) {
    return {
      configured: true,
      available: false,
      executablePath: normalized,
      version: null,
      error: `OpenCode could not be started: ${(error as Error).message}`
    }
  }
}

function openCodeCandidates(): string[] {
  const executableName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((part) => join(part, executableName))
  const common =
    process.platform === 'win32'
      ? [join(homedir(), '.opencode', 'bin', executableName)]
      : [
          join(homedir(), '.opencode', 'bin', executableName),
          `/opt/homebrew/bin/${executableName}`,
          `/usr/local/bin/${executableName}`
        ]
  return Array.from(new Set([...fromPath, ...common])).filter(existsSync)
}

export async function validateRepositoryCheckout(
  checkoutPath: string,
  expectedRepository: string
): Promise<string> {
  const root = (await runGit(checkoutPath, ['rev-parse', '--show-toplevel'])).trim()
  let remote = ''
  try {
    remote = (await runGit(root, ['remote', 'get-url', 'origin'])).trim()
  } catch {
    throw new Error('The local checkout does not have an origin remote.')
  }
  const remoteRepository = repositoryNameFromRemote(remote)
  if (remoteRepository.toLocaleLowerCase() !== expectedRepository.toLocaleLowerCase()) {
    throw new Error(
      `The selected checkout is for "${remoteRepository}", not "${expectedRepository}".`
    )
  }
  return root
}

function repositoryNameFromRemote(remote: string): string {
  const withoutSuffix = remote.replace(/[\\/]+$/, '').replace(/\.git$/i, '')
  const name =
    withoutSuffix
      .split(/[\\/:]/)
      .filter(Boolean)
      .at(-1) ?? ''
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

export async function createOpenCodeSession(input: {
  executablePath: string
  checkoutPath: string
  worktreesRoot: string
  pullRequest: PullRequest
  seed: string
}): Promise<CreatedOpenCodeSession> {
  const { executablePath, checkoutPath, worktreesRoot, pullRequest, seed } = input
  if (!pullRequest.headCommit) throw new Error('Refresh the PR before opening it in OpenCode.')

  const suffix = randomUUID().slice(0, 8)
  const shortCommit = pullRequest.headCommit.slice(0, 8)
  const safeRepository = basename(checkoutPath).replace(/[^a-zA-Z0-9._-]/g, '-')
  const parent = join(worktreesRoot, safeRepository)
  const worktreePath = join(parent, `pr-${pullRequest.adoPrId}-${shortCommit}-${suffix}`)
  const branchName = `botspector/pr-${pullRequest.adoPrId}-${shortCommit}-${suffix}`
  await mkdir(parent, { recursive: true })

  try {
    await runGit(checkoutPath, ['cat-file', '-e', `${pullRequest.headCommit}^{commit}`])
  } catch {
    if (!pullRequest.sourceBranch) {
      throw new Error('The PR commit is not available locally and its source branch is unknown.')
    }
    await runGit(checkoutPath, ['fetch', 'origin', pullRequest.sourceBranch])
    await runGit(checkoutPath, ['cat-file', '-e', `${pullRequest.headCommit}^{commit}`])
  }

  await runGit(checkoutPath, [
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    pullRequest.headCommit
  ])

  try {
    const server = await startOpenCodeServer(executablePath)
    try {
      const session = await openCodeRequest<{ id: string }>(
        server.baseUrl,
        server.authorization,
        worktreePath,
        '/session',
        {
          method: 'POST',
          body: JSON.stringify({ title: `BotSpector PR #${pullRequest.adoPrId}` })
        }
      )
      const seeded = await openCodeRequest<unknown>(
        server.baseUrl,
        server.authorization,
        worktreePath,
        `/session/${encodeURIComponent(session.id)}/message`,
        {
          method: 'POST',
          body: JSON.stringify({
            noReply: true,
            parts: [{ type: 'text', text: seed }]
          })
        }
      )
      return {
        sessionId: session.id,
        worktreePath,
        branchName,
        baseCommit: pullRequest.headCommit,
        seedMessageId: readMessageId(seeded)
      }
    } finally {
      server.close()
    }
  } catch (error) {
    await removeFailedWorktree(checkoutPath, worktreePath, branchName)
    throw error
  }
}

async function removeFailedWorktree(
  checkoutPath: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  try {
    await runGit(checkoutPath, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    // Preserve the original session-creation error.
  }
  try {
    await runGit(checkoutPath, ['branch', '-D', branchName])
  } catch {
    // The failed worktree creation may not have created the branch.
  }
}

function readMessageId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { id?: unknown; info?: { id?: unknown } }
  if (typeof record.id === 'string') return record.id
  return typeof record.info?.id === 'string' ? record.info.id : null
}

export async function launchOpenCodeTui(
  executablePath: string,
  worktreePath: string,
  sessionId: string
): Promise<void> {
  const args = [worktreePath, '--session', sessionId]
  if (process.platform === 'darwin') {
    const command = [executablePath, ...args].map(posixQuote).join(' ')
    await execFileAsync('/usr/bin/osascript', [
      '-e',
      `tell application "Terminal" to do script ${JSON.stringify(command)}`,
      '-e',
      'tell application "Terminal" to activate'
    ])
    return
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', 'OpenCode', executablePath, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    return
  }

  const terminal = [
    '/usr/bin/x-terminal-emulator',
    '/usr/bin/gnome-terminal',
    '/usr/bin/konsole'
  ].find(existsSync)
  if (!terminal) throw new Error('No supported terminal application was found.')
  const terminalArgs = terminal.endsWith('gnome-terminal')
    ? ['--', executablePath, ...args]
    : ['-e', executablePath, ...args]
  const child = spawn(terminal, terminalArgs, { detached: true, stdio: 'ignore' })
  child.unref()
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export async function readOpenCodeSession(
  executablePath: string,
  worktreePath: string,
  sessionId: string
): Promise<OpenCodeSessionSnapshot> {
  const server = await startOpenCodeServer(executablePath)
  try {
    const [messages, diffs] = await Promise.all([
      openCodeRequest<OpenCodeApiMessage[]>(
        server.baseUrl,
        server.authorization,
        worktreePath,
        `/session/${encodeURIComponent(sessionId)}/message`
      ),
      openCodeRequest<Array<{ file: string; additions: number; deletions: number }>>(
        server.baseUrl,
        server.authorization,
        worktreePath,
        `/session/${encodeURIComponent(sessionId)}/diff`
      )
    ])
    return {
      messages,
      changedFiles: diffs.map((diff) => ({
        path: diff.file,
        additions: diff.additions,
        deletions: diff.deletions
      }))
    }
  } finally {
    server.close()
  }
}

export function messagesAfterOpenCodeAnchor(
  messages: OpenCodeApiMessage[],
  seedMessageId: string | null,
  lastSyncedMessageId: string | null
): { messages: ChatMessage[]; lastMessageId: string | null; inProgress: boolean } {
  const anchor = lastSyncedMessageId ?? seedMessageId
  const anchorIndex = anchor ? messages.findIndex((message) => message.info.id === anchor) : -1
  if (lastSyncedMessageId && anchorIndex < 0) {
    throw new Error('OpenCode no longer returned the last synced message; nothing was imported.')
  }
  const candidates = messages.slice(anchorIndex + 1)
  const imported: ChatMessage[] = []
  let lastMessageId = anchor
  let inProgress = false
  for (const message of candidates) {
    if (message.info.role === 'assistant' && !message.info.time?.completed) {
      inProgress = true
      break
    }
    lastMessageId = message.info.id
    if (message.info.id === seedMessageId) continue
    const content = message.parts
      .filter((part) => part.type === 'text' && !part.ignored && part.text?.trim())
      .map((part) => part.text?.trim() ?? '')
      .join('\n\n')
    if (content) imported.push({ role: message.info.role, content, source: 'opencode' })
  }
  return {
    messages: imported,
    lastMessageId,
    inProgress
  }
}

export function buildOpenCodeSeed(input: {
  pullRequest: PullRequest
  pullRequestContext: string
  findingsSummary: string
  priorComments: PostedComment[]
  history: ChatMessage[]
}): string {
  const { pullRequest, pullRequestContext, findingsSummary, priorComments, history } = input
  const comments = priorComments
    .map((comment) => `- ${comment.findingTitle ?? 'PR comment'}: ${comment.commentText}`)
    .join('\n')
  const conversation = history
    .slice(-40)
    .map((message) => `${message.role === 'user' ? 'User' : 'BotSpector'}: ${message.content}`)
    .join('\n\n')
    .slice(-20_000)

  return `You are continuing a pull-request review from BotSpector in an isolated Git worktree.

Pull request: #${pullRequest.adoPrId} ${pullRequest.title}
Source: ${pullRequest.sourceBranch}
Target: ${pullRequest.targetBranch}
Head commit: ${pullRequest.headCommit}

PR context:
${pullRequestContext || '(no PR context was available)'}

Current review findings:
${findingsSummary || '(none)'}

Previously posted review comments:
${comments || '(none)'}

BotSpector conversation so far:
${conversation || '(no chat yet)'}

Continue from this context. Inspect the local code before editing, make only the changes the user asks for, and run relevant checks. When finished, summarize what changed, tests run, and any unresolved review findings so BotSpector can sync the visible conversation back.`
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024
    })
    return stdout
  } catch (error) {
    const failure = error as Error & { stderr?: string }
    throw new Error(failure.stderr?.trim() || failure.message)
  }
}

interface RunningOpenCodeServer {
  baseUrl: string
  authorization: string
  close: () => void
}

async function startOpenCodeServer(executablePath: string): Promise<RunningOpenCodeServer> {
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const child = spawn(executablePath, ['serve', '--hostname=127.0.0.1', `--port=${port}`], {
    env: {
      ...process.env,
      OPENCODE_CLIENT: 'botspector',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_SERVER_PASSWORD: password
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  await waitForServer(child, baseUrl, authorization)
  return {
    baseUrl,
    authorization,
    close: () => {
      if (!child.killed) child.kill()
    }
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close((error) => (error ? reject(error) : resolvePort(port)))
    })
  })
}

async function waitForServer(
  child: ChildProcess,
  baseUrl: string,
  authorization: string
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let settled = false
    let output = ''
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timeout)
      if (error) reject(error)
      else resolveReady()
    }
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      finish(
        new Error(`OpenCode server exited with code ${code}.${output ? ` ${output.trim()}` : ''}`)
      )
    })
    const interval = setInterval(() => {
      void fetch(`${baseUrl}/global/health`, {
        headers: { authorization },
        signal: AbortSignal.timeout(1_000)
      })
        .then((response) => {
          if (response.ok) finish()
        })
        .catch(() => {})
    }, 100)
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill()
      finish(new Error(`Timed out starting OpenCode.${output ? ` ${output.trim()}` : ''}`))
    }, SERVER_START_TIMEOUT_MS)
  })
}

async function openCodeRequest<T>(
  baseUrl: string,
  authorization: string,
  directory: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = new URL(path, baseUrl)
  url.searchParams.set('directory', directory)
  const response = await fetch(url, {
    ...init,
    headers: { authorization, 'content-type': 'application/json', ...init?.headers },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(`OpenCode request failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return (await response.json()) as T
}
