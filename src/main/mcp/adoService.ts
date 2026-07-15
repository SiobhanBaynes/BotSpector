import { buildArgs, callTool, findTool, parseJsonFromText } from './adoClient'
import { getSetting } from '../db/repo'
import { secrets } from '../secrets'
import type { ChangedFile, PullRequest } from '../../shared/types'

/**
 * Higher-level Azure DevOps operations built on the MCP tools. These discover
 * the appropriate tool at runtime so we tolerate tool-name differences across
 * MCP server versions.
 */

type AnyRecord = Record<string, unknown>

function asArray(value: unknown): AnyRecord[] {
  if (Array.isArray(value)) return value as AnyRecord[]
  if (value && typeof value === 'object') {
    const v = value as AnyRecord
    if (Array.isArray(v.value)) return v.value as AnyRecord[]
    if (Array.isArray(v.pullRequests)) return v.pullRequests as AnyRecord[]
  }
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function shortBranch(ref: unknown): string {
  return str(ref).replace('refs/heads/', '')
}

function webUrl(org: string, project: string, repo: string, prId: number): string {
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(
    repo
  )}/pullrequest/${prId}`
}

/**
 * Detect the authenticated user's display name from Azure DevOps connection
 * data (used to mark the current user's own PRs). Uses the PAT over REST.
 */
export async function fetchCurrentUserDisplayName(): Promise<string | null> {
  const org = getSetting('adoOrg')
  const pat = secrets.getAdoPat()
  if (!org || !pat) return null

  const auth = Buffer.from(`:${pat}`, 'utf-8').toString('base64')
  const res = await fetch(`https://dev.azure.com/${org}/_apis/connectionData?api-version=7.1-preview`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`Could not read Azure DevOps identity (${res.status})`)
  }
  const data = (await res.json()) as {
    authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string }
  }
  const user = data.authenticatedUser
  return user?.customDisplayName || user?.providerDisplayName || null
}

/**
 * List the files changed between two commits (base -> head) using the ADO REST
 * diffs API with the PAT. Used for the PR "Files" view.
 */
export async function fetchChangedFiles(
  baseCommit: string,
  headCommit: string
): Promise<ChangedFile[]> {
  const org = getSetting('adoOrg')
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')
  const pat = secrets.getAdoPat()
  if (!org || !repo || !pat) return []

  const auth = Buffer.from(`:${pat}`, 'utf-8').toString('base64')
  const url =
    `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/diffs/commits?baseVersion=${baseCommit}` +
    `&baseVersionType=commit&targetVersion=${headCommit}&targetVersionType=commit` +
    `&$top=2000&api-version=7.1`

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
  })
  if (!res.ok) {
    throw new Error(`Could not load changed files (${res.status})`)
  }
  const data = (await res.json()) as {
    changes?: Array<{
      item?: { path?: string; isFolder?: boolean; gitObjectType?: string }
      changeType?: string
    }>
  }
  const files: ChangedFile[] = []
  const seen = new Set<string>()
  for (const c of data.changes ?? []) {
    const item = c.item ?? {}
    if (item.isFolder || item.gitObjectType === 'tree') continue
    const path = item.path
    if (!path || seen.has(path)) continue
    seen.add(path)
    files.push({ path, changeType: c.changeType ?? 'edit' })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

export async function listPullRequests(): Promise<
  Array<Omit<PullRequest, 'id' | 'reviewStatus' | 'reviewedCommit' | 'postedComments' | 'commentReplies'>>
> {
  const org = getSetting('adoOrg')
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')
  if (!repo) throw new Error('Azure DevOps repository is not set')

  const tool =
    (await findTool('pull_request', 'list')) ??
    (await findTool('pullrequest', 'list')) ??
    (await findTool('list', 'pull'))
  if (!tool) throw new Error('No Azure DevOps MCP tool found for listing pull requests')

  const args = buildArgs(tool, {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    repoName: repo,
    status: 'Active',
    top: 50
  })

  const text = await callTool(tool.name, args)
  const parsed = parseJsonFromText(text)
  const rows = asArray(parsed)

  return rows.map((r) => {
    const prId = Number(r.pullRequestId ?? r.id ?? 0)
    const createdBy = (r.createdBy ?? {}) as AnyRecord
    const repository = (r.repository ?? {}) as AnyRecord
    const repoName = str(repository.name) || repo
    const lastMergeSourceCommit = (r.lastMergeSourceCommit ?? {}) as AnyRecord
    return {
      adoPrId: prId,
      repo: repoName,
      title: str(r.title) || `PR ${prId}`,
      description: str(r.description),
      author: str(createdBy.displayName) || str(createdBy.uniqueName) || 'Unknown',
      status: str(r.status) || 'active',
      url: webUrl(org, project, repoName, prId),
      sourceBranch: shortBranch(r.sourceRefName),
      targetBranch: shortBranch(r.targetRefName),
      headCommit: str(lastMergeSourceCommit.commitId),
      updatedAt: str(r.creationDate) || new Date().toISOString()
    }
  })
}

export interface PrContext {
  summary: string
}

export interface ThreadReply {
  author: string
  text: string
  date: string | null
}

export interface ThreadState {
  id: number
  status: string | null
  commentCount: number
  replies: ThreadReply[]
}

/** Fetch all comment threads for a PR, returning id, status, count, and replies. */
export async function fetchPullRequestThreads(adoPrId: number): Promise<ThreadState[]> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const tool =
    (await findTool('pull_request', 'thread', 'list')) ??
    (await findTool('thread', 'list')) ??
    (await findTool('pull_request', 'thread'))
  if (!tool) return []

  const args = buildArgs(tool, {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    pullRequestId: adoPrId
  })

  const text = await callTool(tool.name, args)
  const parsed = parseJsonFromText(text)
  const rows = asArray(parsed)

  return rows.map((t) => {
    const comments = Array.isArray(t.comments) ? (t.comments as AnyRecord[]) : []
    const realComments = comments.filter((c) => !c.isDeleted)
    // Replies are every comment after the first (ours).
    const replies: ThreadReply[] = realComments.slice(1).map((c) => {
      const author = (c.author ?? {}) as AnyRecord
      return {
        author: str(author.displayName) || str(author.uniqueName) || 'Unknown',
        text: str(c.content),
        date: str(c.publishedDate || c.lastUpdatedDate) || null
      }
    })
    return {
      id: Number(t.id ?? 0),
      status: typeof t.status === 'string' ? t.status : null,
      commentCount: realComments.length,
      replies
    }
  })
}

/**
 * Fetch the text content of a file from the repository, preferring a specific
 * commit (so we show the exact lines that were reviewed), falling back to a
 * branch. Returns the raw file text.
 */
export async function fetchFileContent(
  filePath: string,
  opts: { commit?: string; branch?: string }
): Promise<string | null> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const tool =
    (await findTool('file', 'content')) ??
    (await findTool('get', 'file')) ??
    (await findTool('file', 'get'))
  if (!tool) return null

  const path = filePath.startsWith('/') ? filePath : `/${filePath}`
  const values: AnyRecord = {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    repoName: repo,
    path,
    filePath: path,
    fileName: path
  }
  if (opts.commit) {
    values.commitId = opts.commit
    values.version = opts.commit
    values.versionValue = opts.commit
    values.versionType = 'Commit'
  } else if (opts.branch) {
    values.branch = opts.branch
    values.version = opts.branch
    values.versionValue = opts.branch
    values.versionType = 'Branch'
  }

  const args = buildArgs(tool, values)
  const text = await callTool(tool.name, args)
  // MCP returns the file content as text; some servers wrap it as { content }.
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') && trimmed.includes('"content"')) {
    const parsed = parseJsonFromText(text) as AnyRecord | null
    if (parsed && typeof parsed.content === 'string') return parsed.content
  }
  return text
}

/**
 * Create a comment thread on the pull request in Azure DevOps. If a file path
 * (and optional line) is given, the comment is attached to that file; otherwise
 * it becomes a general PR discussion comment. Returns the created thread id.
 */
export async function postPullRequestComment(
  adoPrId: number,
  content: string,
  filePath?: string | null,
  line?: number | null
): Promise<number | null> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const tool =
    (await findTool('pull_request', 'thread', 'create')) ??
    (await findTool('create', 'pull_request', 'thread')) ??
    (await findTool('pull_request', 'comment', 'create')) ??
    (await findTool('create', 'thread')) ??
    (await findTool('thread', 'create'))
  if (!tool) {
    throw new Error('No Azure DevOps MCP tool available to create a PR comment thread')
  }

  const baseValues: AnyRecord = {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    pullRequestId: adoPrId,
    content,
    comment: content,
    commentContent: content
  }

  // Attempt to anchor the comment to the file/line. Azure DevOps requires both
  // line and column offsets for the thread context.
  const attempts: AnyRecord[] = []
  if (filePath && line && line > 0) {
    attempts.push({
      ...baseValues,
      filePath,
      rightFileStartLine: line,
      rightFileStartOffset: 1,
      rightFileEndLine: line,
      rightFileEndOffset: 1
    })
  }
  // Fallback: a general (non-anchored) PR discussion comment always works.
  attempts.push(baseValues)

  let lastError: Error | null = null
  for (const values of attempts) {
    try {
      const args = buildArgs(tool, values)
      const text = await callTool(tool.name, args)
      const parsed = parseJsonFromText(text) as AnyRecord | null
      const threadId = parsed?.id ?? parsed?.threadId
      return typeof threadId === 'number' ? threadId : null
    } catch (e) {
      lastError = e as Error
    }
  }
  throw lastError ?? new Error('Failed to create PR comment thread')
}

/**
 * Fetch the full PR description via the "get pull request" tool. The list tool
 * often omits the description, so we retrieve it on demand.
 */
export async function fetchPullRequestDescription(adoPrId: number): Promise<string | null> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const getTool =
    (await findTool('pull_request', 'get')) ??
    (await findTool('get', 'pull_request')) ??
    (await findTool('pullrequest', 'get'))
  if (!getTool) return null

  const args = buildArgs(getTool, {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    pullRequestId: adoPrId
  })

  const text = await callTool(getTool.name, args)
  const parsed = parseJsonFromText(text)
  if (!parsed) return null

  let obj: AnyRecord | undefined
  if (Array.isArray(parsed)) obj = parsed[0] as AnyRecord
  else if (parsed && typeof parsed === 'object') {
    const p = parsed as AnyRecord
    if (Array.isArray(p.value)) obj = p.value[0] as AnyRecord
    else obj = p
  }
  const desc = obj?.description
  return typeof desc === 'string' ? desc : null
}

/**
 * Fetch the current head commit (last source commit) of a PR, used to detect
 * whether new commits have been pushed since the last review.
 */
export async function fetchPullRequestHeadCommit(adoPrId: number): Promise<string | null> {
  const details = await fetchPullRequestMergeCommits(adoPrId)
  return details?.source ?? null
}

/** Fetch the source (head) and target (base) merge commits of a PR. */
export async function fetchPullRequestMergeCommits(
  adoPrId: number
): Promise<{ source: string | null; target: string | null } | null> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const getTool =
    (await findTool('pull_request', 'get')) ??
    (await findTool('get', 'pull_request')) ??
    (await findTool('pullrequest', 'get'))
  if (!getTool) return null

  const args = buildArgs(getTool, {
    project,
    repositoryId: repo,
    repository: repo,
    repositoryNameOrId: repo,
    pullRequestId: adoPrId
  })

  const text = await callTool(getTool.name, args)
  const parsed = parseJsonFromText(text)
  if (!parsed) return null

  let obj: AnyRecord | undefined
  if (Array.isArray(parsed)) obj = parsed[0] as AnyRecord
  else if (parsed && typeof parsed === 'object') {
    const p = parsed as AnyRecord
    obj = Array.isArray(p.value) ? (p.value[0] as AnyRecord) : p
  }
  const source = (obj?.lastMergeSourceCommit ?? {}) as AnyRecord
  const target = (obj?.lastMergeTargetCommit ?? {}) as AnyRecord
  return {
    source: typeof source.commitId === 'string' ? source.commitId : null,
    target: typeof target.commitId === 'string' ? target.commitId : null
  }
}

/**
 * Gather a text description of the PR (metadata + changes/threads) for the agent.
 * Best-effort: pulls whatever detail tools are available.
 */
export async function getPullRequestContext(adoPrId: number): Promise<PrContext> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')

  const parts: string[] = []

  const getTool =
    (await findTool('pull_request', 'get')) ??
    (await findTool('get', 'pull_request')) ??
    (await findTool('pullrequest', 'get'))
  if (getTool) {
    const args = buildArgs(getTool, {
      project,
      repositoryId: repo,
      repository: repo,
      repositoryNameOrId: repo,
      pullRequestId: adoPrId,
      pullRequestId_: adoPrId
    })
    try {
      parts.push('## Pull request details\n' + (await callTool(getTool.name, args)))
    } catch (e) {
      parts.push(`(Could not fetch PR details: ${(e as Error).message})`)
    }
  }

  // Changes / iterations / diffs, if such a tool exists.
  const changesTool =
    (await findTool('pull_request', 'change')) ??
    (await findTool('pull_request', 'iteration')) ??
    (await findTool('pull_request', 'commit'))
  if (changesTool) {
    const args = buildArgs(changesTool, {
      project,
      repositoryId: repo,
      repository: repo,
      repositoryNameOrId: repo,
      pullRequestId: adoPrId,
      top: 100
    })
    try {
      parts.push('## Changes\n' + (await callTool(changesTool.name, args)))
    } catch {
      // optional
    }
  }

  return { summary: parts.join('\n\n') }
}
