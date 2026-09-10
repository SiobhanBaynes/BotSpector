import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { constants, existsSync } from 'fs'
import { access, mkdir, readFile } from 'fs/promises'
import { createServer } from 'net'
import { homedir } from 'os'
import { basename, delimiter, join, resolve, sep } from 'path'
import { promisify } from 'util'
import type {
  ChatMessage,
  Finding,
  OpenCodeChangedFile,
  OpenCodeCommitPreview,
  OpenCodeCommitResult,
  OpenCodeStatus,
  PostedComment,
  PullRequest,
  RepositoryProfile
} from '../shared/types'
import * as repo from './db/repo'

const execFileAsync = promisify(execFile)
const OPEN_CODE_SETTING = 'openCodeExecutablePath'
const SERVER_START_TIMEOUT_MS = 8_000
const API_TIMEOUT_MS = 10_000
export const RESOLUTION_COMMENT_MAX_LENGTH = 200
const INTERNAL_FINDING_NUMBER = /\bF-\d+\b/i

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

export interface OpenCodeFileVersion {
  path: string
  before: string
  after: string
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
  expectedRepository: Pick<RepositoryProfile, 'adoOrg' | 'adoProject' | 'adoRepo'>
): Promise<string> {
  const root = (await runGit(checkoutPath, ['rev-parse', '--show-toplevel'])).trim()
  let fetchRemotes: string[]
  let pushRemotes: string[]
  try {
    ;[fetchRemotes, pushRemotes] = await Promise.all([
      readOriginUrls(root, false),
      readOriginUrls(root, true)
    ])
  } catch {
    throw new Error('The local checkout does not have an origin remote.')
  }
  for (const remote of fetchRemotes) {
    assertAzureDevOpsRemote(remote, expectedRepository, 'fetch URL')
  }
  for (const remote of pushRemotes) {
    assertAzureDevOpsRemote(remote, expectedRepository, 'push destination')
  }
  return root
}

async function readOriginUrls(root: string, push: boolean): Promise<string[]> {
  const output = await runGit(root, [
    'remote',
    'get-url',
    ...(push ? ['--push'] : []),
    '--all',
    'origin'
  ])
  const urls = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (urls.length === 0) throw new Error('Origin has no configured URL.')
  return urls
}

function decodeRemotePart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function azureDevOpsRepositoryFromRemote(
  remote: string
): Pick<RepositoryProfile, 'adoOrg' | 'adoProject' | 'adoRepo'> | null {
  const scpMatch = remote
    .trim()
    .match(
      /^(?:[^@]+@)?(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i
    )
  if (scpMatch) {
    return {
      adoOrg: decodeRemotePart(scpMatch[1]),
      adoProject: decodeRemotePart(scpMatch[2]),
      adoRepo: decodeRemotePart(scpMatch[3]).replace(/\.git$/i, '')
    }
  }

  let url: URL
  try {
    url = new URL(remote.trim())
  } catch {
    return null
  }
  const host = url.hostname.toLocaleLowerCase()
  const parts = url.pathname.split('/').filter(Boolean).map(decodeRemotePart)

  if (
    url.protocol === 'ssh:' &&
    (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com')
  ) {
    if (parts.length !== 4 || parts[0].toLocaleLowerCase() !== 'v3') return null
    return { adoOrg: parts[1], adoProject: parts[2], adoRepo: parts[3].replace(/\.git$/i, '') }
  }
  if (url.protocol !== 'https:') return null
  if (host === 'dev.azure.com') {
    if (parts.length !== 4 || parts[2].toLocaleLowerCase() !== '_git') return null
    return { adoOrg: parts[0], adoProject: parts[1], adoRepo: parts[3].replace(/\.git$/i, '') }
  }
  if (host.endsWith('.visualstudio.com')) {
    const org = decodeRemotePart(host.slice(0, -'.visualstudio.com'.length))
    const offset = parts[0]?.toLocaleLowerCase() === 'defaultcollection' ? 1 : 0
    if (parts.length !== offset + 3 || parts[offset + 1].toLocaleLowerCase() !== '_git') {
      return null
    }
    return {
      adoOrg: org,
      adoProject: parts[offset],
      adoRepo: parts[offset + 2].replace(/\.git$/i, '')
    }
  }
  return null
}

function assertAzureDevOpsRemote(
  remote: string,
  expected: Pick<RepositoryProfile, 'adoOrg' | 'adoProject' | 'adoRepo'>,
  label: string
): void {
  const actual = azureDevOpsRepositoryFromRemote(remote)
  const expectedLabel = `${expected.adoOrg}/${expected.adoProject}/${expected.adoRepo}`
  if (!actual) {
    throw new Error(
      `The selected checkout origin ${label} is not an Azure DevOps repository URL for "${expectedLabel}".`
    )
  }
  const matches =
    actual.adoOrg.toLocaleLowerCase() === expected.adoOrg.trim().toLocaleLowerCase() &&
    actual.adoProject.toLocaleLowerCase() === expected.adoProject.trim().toLocaleLowerCase() &&
    actual.adoRepo.toLocaleLowerCase() === expected.adoRepo.trim().toLocaleLowerCase()
  if (!matches) {
    throw new Error(
      `The selected checkout origin ${label} is for "${actual.adoOrg}/${actual.adoProject}/${actual.adoRepo}", not "${expectedLabel}".`
    )
  }
}

export async function createOpenCodeSession(input: {
  executablePath: string
  checkoutPath: string
  worktreesRoot: string
  pullRequest: PullRequest
  seed: string
  finding?: Pick<Finding, 'publicId'>
}): Promise<CreatedOpenCodeSession> {
  const { executablePath, checkoutPath, worktreesRoot, pullRequest, seed, finding } = input
  if (!pullRequest.headCommit) throw new Error('Refresh the PR before opening it in OpenCode.')

  const suffix = randomUUID().slice(0, 8)
  const shortCommit = pullRequest.headCommit.slice(0, 8)
  const safeRepository = basename(checkoutPath).replace(/[^a-zA-Z0-9._-]/g, '-')
  const findingSlug = finding?.publicId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  const scope = findingSlug ? `-${findingSlug}` : ''
  const parent = join(worktreesRoot, safeRepository)
  const worktreePath = join(parent, `pr-${pullRequest.adoPrId}${scope}-${shortCommit}-${suffix}`)
  const branchName = `botspector/pr-${pullRequest.adoPrId}${scope}-${shortCommit}-${suffix}`
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
          body: JSON.stringify({
            title: `BotSpector PR #${pullRequest.adoPrId}${finding ? ` - ${finding.publicId}` : ''}`
          })
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
    const child = spawn(
      'cmd.exe',
      windowsOpenCodeLaunchArgs(executablePath, worktreePath, sessionId),
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }
    )
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

export function windowsOpenCodeLaunchArgs(
  executablePath: string,
  worktreePath: string,
  sessionId: string
): string[] {
  return ['/d', '/c', 'start', '', executablePath, worktreePath, '--session', sessionId]
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

export async function readOpenCodeWorktreeFiles(
  worktreePath: string,
  baseCommit: string,
  primaryPath: string | null
): Promise<OpenCodeFileVersion[]> {
  const primary = primaryPath?.replace(/^\/+/, '') ?? null
  const paths = (await readOpenCodeChangedPaths(worktreePath, baseCommit))
    .sort((left, right) => {
      if (left === primary) return -1
      if (right === primary) return 1
      return left.localeCompare(right)
    })
    .slice(0, 20)
  const root = resolve(worktreePath)
  const files: OpenCodeFileVersion[] = []
  for (const path of paths) {
    const absolutePath = resolve(root, path)
    if (!absolutePath.startsWith(`${root}${sep}`)) continue
    const [before, after] = await Promise.all([
      runGit(worktreePath, ['show', `${baseCommit}:${path}`]).catch(() => ''),
      readFile(absolutePath, 'utf8').catch(() => '')
    ])
    files.push({ path, before, after })
  }
  return files
}

export async function getOpenCodeCommitPreview(input: {
  worktreePath: string
  branchName: string
  baseCommit: string
  lastPushedCommit?: string | null
  knownPrHeadCommit?: string | null
  sourceBranch: string
  findingPublicId: string
  findingTitle: string
}): Promise<OpenCodeCommitPreview> {
  const comparisonCommit = await resolvePublishBase(input)
  const targetBranch = await validatePublishContext({ ...input, baseCommit: comparisonCommit })
  const [files, status, commitsAhead, headCommit] = await Promise.all([
    readOpenCodeChangedPaths(input.worktreePath, comparisonCommit),
    runGit(input.worktreePath, ['status', '--porcelain=v1', '-z']),
    runGit(input.worktreePath, ['rev-list', '--count', `${comparisonCommit}..HEAD`]),
    runGit(input.worktreePath, ['rev-parse', 'HEAD'])
  ])
  const suggestedMessage = `Fix: ${input.findingTitle}`.replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    targetBranch,
    files,
    hasUncommittedChanges: status.length > 0,
    commitsAhead: Number.parseInt(commitsAhead.trim(), 10) || 0,
    suggestedMessage,
    snapshotId: await createWorktreeSnapshot(input.worktreePath, files, status, headCommit.trim())
  }
}

export async function commitOpenCodeToPullRequest(
  input: {
    worktreePath: string
    branchName: string
    baseCommit: string
    lastPushedCommit?: string | null
    knownPrHeadCommit?: string | null
    sourceBranch: string
    findingPublicId: string
    findingTitle: string
  },
  commitMessage: string,
  expectedSnapshotId: string
): Promise<OpenCodeCommitResult> {
  const preview = await getOpenCodeCommitPreview(input)
  const publishBase = await resolvePublishBase(input)
  if (preview.snapshotId !== expectedSnapshotId) {
    throw new Error(
      'The OpenCode worktree changed after the preview. Review the latest files first.'
    )
  }
  if (preview.files.length === 0) {
    throw new Error('There are no changes in this OpenCode worktree to send to the PR.')
  }

  let createdCommit = false
  if (preview.hasUncommittedChanges) {
    if (typeof commitMessage !== 'string') throw new Error('Enter a valid commit message.')
    const message = commitMessage.trim()
    if (!message) throw new Error('Enter a commit message before sending this fix to the PR.')
    if (message.length > 200) throw new Error('Keep the commit message to 200 characters or fewer.')
    if (containsInternalFindingNumber(message, input.findingPublicId)) {
      throw new Error('Remove the internal finding number from the commit message.')
    }
    await runGit(input.worktreePath, ['add', '--all'])
    await runGit(input.worktreePath, ['commit', '-m', message])
    createdCommit = true
  }

  const commitMessages = await runGit(input.worktreePath, [
    'log',
    '--format=%B',
    `${publishBase}..HEAD`
  ])
  if (containsInternalFindingNumber(commitMessages, input.findingPublicId)) {
    throw new Error(
      'An unpublished commit contains an internal finding number. Amend it in OpenCode before pushing.'
    )
  }

  await runGit(input.worktreePath, [
    'fetch',
    '--no-tags',
    'origin',
    `refs/heads/${preview.targetBranch}`
  ])
  const remoteCommit = (await runGit(input.worktreePath, ['rev-parse', 'FETCH_HEAD'])).trim()
  const remoteAlreadyIncluded = await gitIsAncestor(input.worktreePath, remoteCommit, 'HEAD')
  if (!remoteAlreadyIncluded) {
    try {
      await runGit(input.worktreePath, [
        'rebase',
        '--onto',
        remoteCommit,
        publishBase,
        input.branchName
      ])
    } catch (error) {
      await runGit(input.worktreePath, ['rebase', '--abort']).catch(() => undefined)
      throw new Error(
        `The PR branch changed and this fix could not be rebased automatically. Reopen OpenCode, rebase the source branch, and resolve the conflicts before trying again. ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  try {
    await runGit(input.worktreePath, ['push', 'origin', `HEAD:refs/heads/${preview.targetBranch}`])
  } catch (error) {
    throw new Error(
      `The PR branch could not be updated; no force push was attempted. ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return {
    targetBranch: preview.targetBranch,
    commit: (await runGit(input.worktreePath, ['rev-parse', 'HEAD'])).trim(),
    createdCommit
  }
}

async function readOpenCodeChangedPaths(
  worktreePath: string,
  baseCommit: string
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runGit(worktreePath, ['diff', '--name-only', '-z', baseCommit, '--']),
    runGit(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'])
  ])
  return Array.from(
    new Set(
      `${tracked}${untracked}`
        .split('\0')
        .map((path) => path.replace(/^\/+/, ''))
        .filter(Boolean)
    )
  ).sort((left, right) => left.localeCompare(right))
}

async function resolvePublishBase(input: {
  worktreePath: string
  baseCommit: string
  lastPushedCommit?: string | null
  knownPrHeadCommit?: string | null
}): Promise<string> {
  if (input.lastPushedCommit) return input.lastPushedCommit
  if (
    input.knownPrHeadCommit &&
    (await gitIsAncestor(input.worktreePath, input.knownPrHeadCommit, 'HEAD'))
  ) {
    return input.knownPrHeadCommit
  }
  return input.baseCommit
}

async function validatePublishContext(input: {
  worktreePath: string
  branchName: string
  baseCommit?: string
  sourceBranch: string
}): Promise<string> {
  const currentBranch = (await runGit(input.worktreePath, ['branch', '--show-current'])).trim()
  if (currentBranch !== input.branchName) {
    throw new Error(
      `This worktree is on ${currentBranch || 'a detached HEAD'}, not its expected ${input.branchName} branch.`
    )
  }
  if (input.baseCommit && !(await gitIsAncestor(input.worktreePath, input.baseCommit, 'HEAD'))) {
    throw new Error('This worktree no longer descends from the PR commit it was created from.')
  }
  const targetBranch = input.sourceBranch.replace(/^refs\/heads\//, '').trim()
  if (!targetBranch) throw new Error('The pull request source branch is unknown.')
  try {
    await runGit(input.worktreePath, ['check-ref-format', `refs/heads/${targetBranch}`])
  } catch {
    throw new Error(`The pull request source branch is invalid: ${input.sourceBranch}`)
  }
  return targetBranch
}

async function createWorktreeSnapshot(
  worktreePath: string,
  files: string[],
  status: string,
  headCommit: string
): Promise<string> {
  const fileHashes = await Promise.all(
    files.map(async (path) => {
      const hash = await runGit(worktreePath, ['hash-object', '--no-filters', '--', path]).catch(
        () => '<deleted>'
      )
      return `${path}\0${hash.trim()}`
    })
  )
  return createHash('sha256')
    .update(headCommit)
    .update('\0')
    .update(status)
    .update('\0')
    .update(fileHashes.join('\0'))
    .digest('hex')
}

async function gitIsAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
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
    const content = visibleOpenCodeMessageText(message)
    if (content) imported.push({ role: message.info.role, content, source: 'opencode' })
  }
  return {
    messages: imported,
    lastMessageId,
    inProgress
  }
}

export function openCodeResolutionComment(
  messages: OpenCodeApiMessage[],
  seedMessageId: string | null,
  findingPublicId?: string
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message.info.id === seedMessageId ||
      message.info.role !== 'assistant' ||
      !message.info.time?.completed
    ) {
      continue
    }
    const content = visibleOpenCodeMessageText(message)
    if (content) return resolutionCommentFromText(content, findingPublicId)
  }
  return null
}

export function resolutionCommentFromText(
  content: string,
  findingPublicId?: string
): string | null {
  const marker =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Suggested\s+)?(?:Azure DevOps\s+)?Resolution comment:(?:\*\*)?\s*/i
  const match = marker.exec(content)
  let comment = (match ? content.slice(match.index + match[0].length) : content)
    .replace(/\b(?:BotSpector\s+)?finding\s+F-\d+\b/gi, 'this issue')
    .replace(/\bF-\d+\b/gi, 'this issue')
    .replace(/\s+/g, ' ')
    .trim()
  if (findingPublicId) {
    const escapedId = findingPublicId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    comment = comment
      .replace(
        new RegExp(`\\b(?:BotSpector\\s+)?finding\\s+${escapedId}(?=$|[^A-Za-z0-9])`, 'gi'),
        'this issue'
      )
      .replace(new RegExp(`(^|[^A-Za-z0-9])${escapedId}(?=$|[^A-Za-z0-9])`, 'gi'), '$1this issue')
  }
  comment = comment.replace(/^[-*]\s+/, '').trim()
  const firstSentence = comment.match(/^.*?(?:[.!?](?=\s|$)|$)/)?.[0]?.trim()
  if (firstSentence) comment = firstSentence
  if (!comment) return null
  if (comment.length <= RESOLUTION_COMMENT_MAX_LENGTH) return comment
  const shortened = comment.slice(0, RESOLUTION_COMMENT_MAX_LENGTH - 3)
  const wordBoundary = shortened.lastIndexOf(' ')
  return `${shortened.slice(0, wordBoundary > 0 ? wordBoundary : shortened.length)}...`
}

export function containsInternalFindingNumber(content: string, findingPublicId?: string): boolean {
  if (INTERNAL_FINDING_NUMBER.test(content)) return true
  if (!findingPublicId) return false
  const escapedId = findingPublicId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9])${escapedId}(?=$|[^A-Za-z0-9])`, 'i').test(content)
}

function visibleOpenCodeMessageText(message: OpenCodeApiMessage): string {
  return message.parts
    .filter((part) => part.type === 'text' && !part.ignored && part.text?.trim())
    .map((part) => part.text?.trim() ?? '')
    .join('\n\n')
}

export function buildOpenCodeSeed(input: {
  pullRequest: PullRequest
  pullRequestContext: string
  findingsSummary: string
  priorComments: PostedComment[]
  history: ChatMessage[]
  finding?: Finding
}): string {
  const { pullRequest, pullRequestContext, findingsSummary, priorComments, history, finding } =
    input
  const comments = priorComments
    .map((comment) => `- ${comment.findingTitle ?? 'PR comment'}: ${comment.commentText}`)
    .join('\n')
  const scopedHistory = finding
    ? history.filter((message) => message.findingId == null || message.findingId === finding.id)
    : history
  const conversation = scopedHistory
    .slice(-40)
    .map((message) => `${message.role === 'user' ? 'User' : 'BotSpector'}: ${message.content}`)
    .join('\n\n')
    .slice(-20_000)
  const findingReplies = finding?.comment?.replies.length
    ? finding.comment.replies.map((reply) => `${reply.author}: ${reply.text}`).join('\n\n')
    : '(none)'
  const workScope = finding
    ? `Work scope: BotSpector finding ${finding.publicId}
Severity: ${finding.bucket}
Title: ${finding.title}
Concern: ${finding.description}
Location: ${finding.filePath ?? '(not file-specific)'}${finding.line ? `:${finding.line}` : ''}
Finding status: ${finding.status}
Review comment: ${finding.comment?.draftText ?? '(not drafted or posted)'}
Author replies: ${findingReplies}

This OpenCode session is durably linked to ${finding.publicId}. Address this finding only, apart from adjacent changes required to implement or test its fix. Do not silently switch to another finding. When finished, state whether the fix is ready in this worktree, list the validation performed, and identify anything still preventing ${finding.publicId} from being resolved.`
    : 'Work scope: the pull request as a whole.'

  return `You are continuing a pull-request review from BotSpector in an isolated Git worktree.

Pull request: #${pullRequest.adoPrId} ${pullRequest.title}
Source: ${pullRequest.sourceBranch}
Target: ${pullRequest.targetBranch}
Head commit: ${pullRequest.headCommit}

${workScope}

PR context:
${pullRequestContext || '(no PR context was available)'}

Current review findings:
${findingsSummary || '(none)'}

Previously posted review comments:
${comments || '(none)'}

BotSpector conversation so far:
${conversation || '(no chat yet)'}

Continue from this context. Inspect the local code before editing, make only the changes the user asks for, and run relevant checks. Leave the result uncommitted and do not push it; the user will explicitly approve publishing from BotSpector. When finished, summarize what changed, tests run, and any unresolved review findings so BotSpector can sync the visible conversation back. End your final response with a \`Resolution comment:\` section containing one accurate sentence of no more than ${RESOLUTION_COMMENT_MAX_LENGTH} characters for the existing Azure DevOps thread. Do not mention BotSpector or internal finding numbers such as ${finding?.publicId ?? 'F-001'} in that comment.`
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
