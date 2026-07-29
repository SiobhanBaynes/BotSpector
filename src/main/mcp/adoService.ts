import { buildArgs, callTool, findTool, parseJsonFromText } from './adoClient'
import { getSetting } from '../db/repo'
import { secrets } from '../secrets'
import type { AdoCommentThread, ChangedFile, PrAdoDetails, PrReviewer, PullRequest } from '../../shared/types'

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

// Shared Azure DevOps REST config (org/project/repo + basic auth from the PAT).
function restConfig(): { org: string; project: string; repo: string; auth: string } | null {
  const org = getSetting('adoOrg')
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')
  const pat = secrets.getAdoPat()
  if (!org || !repo || !pat) return null
  return { org, project, repo, auth: Buffer.from(`:${pat}`, 'utf-8').toString('base64') }
}

/** The current user's Azure DevOps id (GUID), needed to cast a reviewer vote. */
let cachedUserId: string | null = null
export async function fetchCurrentUserId(): Promise<string | null> {
  if (cachedUserId) return cachedUserId
  const org = getSetting('adoOrg')
  const pat = secrets.getAdoPat()
  if (!org || !pat) return null
  const auth = Buffer.from(`:${pat}`, 'utf-8').toString('base64')
  const res = await fetch(`https://dev.azure.com/${org}/_apis/connectionData?api-version=7.1-preview`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }
  })
  if (!res.ok) return null
  const data = (await res.json()) as { authenticatedUser?: { id?: string } }
  cachedUserId = data.authenticatedUser?.id ?? null
  return cachedUserId
}

function prRestUrl(cfg: { org: string; project: string; repo: string }, adoPrId: number): string {
  return (
    `https://dev.azure.com/${cfg.org}/${encodeURIComponent(cfg.project)}/_apis/git/repositories/` +
    `${encodeURIComponent(cfg.repo)}/pullrequests/${adoPrId}`
  )
}

/** Count active (non-deleted, non-system) comment threads on a PR. */
async function fetchActiveThreadCount(adoPrId: number): Promise<number> {
  return (await fetchCommentCounts(adoPrId)).total
}

// A thread is "resolved" if it was closed out; anything else (active, pending,
// or no status) counts as still open / unresolved.
function isResolvedThreadStatus(status?: string): boolean {
  switch ((status ?? '').toLowerCase()) {
    case 'fixed':
    case 'closed':
    case 'wontfix':
    case 'bydesign':
      return true
    default:
      return false
  }
}

/** Count a PR's comment threads: total (with real comments) and unresolved. */
async function fetchCommentCounts(adoPrId: number): Promise<{ total: number; unresolved: number }> {
  const cfg = restConfig()
  if (!cfg) return { total: 0, unresolved: 0 }
  const url = `${prRestUrl(cfg, adoPrId)}/threads?api-version=7.1`
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' }
  })
  if (!res.ok) return { total: 0, unresolved: 0 }
  const data = (await res.json()) as {
    value?: Array<{
      status?: string
      isDeleted?: boolean
      comments?: Array<{ commentType?: string; isDeleted?: boolean }>
    }>
  }
  const threads = (data.value ?? []).filter(
    (t) =>
      !t.isDeleted &&
      (t.comments ?? []).some((c) => !c.isDeleted && c.commentType !== 'system')
  )
  const total = threads.length
  const unresolved = threads.filter((t) => !isResolvedThreadStatus(t.status)).length
  return { total, unresolved }
}

/** Count active comment threads (exported for list enrichment). */
export async function fetchPullRequestCommentCount(adoPrId: number): Promise<number> {
  return fetchActiveThreadCount(adoPrId)
}

/**
 * Lightweight per-PR metadata for the list: draft flag, reviewer approvals/vote
 * counts, and comment-thread count. Uses REST because the MCP list tool omits
 * reviewer votes (which is why the approval count was always 0).
 */
export async function fetchPullRequestListMeta(adoPrId: number): Promise<{
  isDraft: boolean
  approvals: number
  reviewerCount: number
  commentCount: number
  unresolvedCommentCount: number
  myVote: number
} | null> {
  const cfg = restConfig()
  if (!cfg) return null
  const res = await fetch(`${prRestUrl(cfg, adoPrId)}?api-version=7.1`, {
    headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' }
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    isDraft?: boolean
    reviewers?: Array<{ id?: string; vote?: number }>
  }
  const reviewers = data.reviewers ?? []
  const approvals = reviewers.filter((r) => (r.vote ?? 0) >= 5).length
  const reviewerCount = reviewers.filter((r) => (r.vote ?? 0) !== 0).length
  const myId = await fetchCurrentUserId().catch(() => null)
  const myVote = myId ? (reviewers.find((r) => r.id === myId)?.vote ?? 0) : 0
  const counts = await fetchCommentCounts(adoPrId).catch(() => ({ total: 0, unresolved: 0 }))
  return {
    isDraft: !!data.isDraft,
    approvals,
    reviewerCount,
    commentCount: counts.total,
    unresolvedCommentCount: counts.unresolved,
    myVote
  }
}

/** Fetch live Azure DevOps state for a PR: status, draft, reviewers, my vote. */
export async function fetchPullRequestDetails(adoPrId: number): Promise<PrAdoDetails | null> {
  const cfg = restConfig()
  if (!cfg) return null
  const res = await fetch(`${prRestUrl(cfg, adoPrId)}?api-version=7.1`, {
    headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' }
  })
  if (!res.ok) throw new Error(`Could not load PR details (${res.status})`)
  const data = (await res.json()) as {
    status?: string
    isDraft?: boolean
    reviewers?: Array<{ id?: string; displayName?: string; vote?: number; isRequired?: boolean }>
  }
  const reviewers: PrReviewer[] = (data.reviewers ?? [])
    .filter((r) => r.id)
    .map((r) => ({
      id: r.id as string,
      displayName: r.displayName ?? '',
      vote: r.vote ?? 0,
      isRequired: !!r.isRequired
    }))
  const myId = await fetchCurrentUserId().catch(() => null)
  const myVote = myId ? (reviewers.find((r) => r.id === myId)?.vote ?? 0) : 0
  const commentCount = await fetchActiveThreadCount(adoPrId).catch(() => 0)
  return { status: data.status ?? 'active', isDraft: !!data.isDraft, reviewers, myVote, commentCount }
}

/** Add the current user as an optional (non-required) reviewer, if not already one. */
export async function addSelfAsOptionalReviewer(adoPrId: number): Promise<void> {
  const cfg = restConfig()
  if (!cfg) return
  const userId = await fetchCurrentUserId()
  if (!userId) return
  const headers = {
    Authorization: `Basic ${cfg.auth}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }

  // Don't add ourselves as a reviewer on our own PR.
  try {
    const prRes = await fetch(`${prRestUrl(cfg, adoPrId)}?api-version=7.1`, { headers })
    if (prRes.ok) {
      const pr = (await prRes.json()) as { createdBy?: { id?: string } }
      if (pr.createdBy?.id && pr.createdBy.id === userId) return
    }
  } catch {
    // If the author check fails, proceed — the reviewers PUT is still safe.
  }

  const url =
    `https://dev.azure.com/${cfg.org}/${encodeURIComponent(cfg.project)}/_apis/git/repositories/` +
    `${encodeURIComponent(cfg.repo)}/pullRequests/${adoPrId}/reviewers/${userId}?api-version=7.1`
  // If we're already a reviewer, leave the entry (and any existing vote) alone.
  const existing = await fetch(url, { headers }).catch(() => null)
  if (existing && existing.ok) return
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ vote: 0, isRequired: false })
  })
  if (!res.ok) throw new Error(`Could not add you as a reviewer (${res.status})`)
}

/** Cast (or reset) the current user's reviewer vote on a PR. */
export async function setPullRequestVote(adoPrId: number, vote: number): Promise<void> {
  const cfg = restConfig()
  if (!cfg) throw new Error('Azure DevOps is not configured')
  const userId = await fetchCurrentUserId()
  if (!userId) throw new Error('Could not determine your Azure DevOps identity')
  const url =
    `https://dev.azure.com/${cfg.org}/${encodeURIComponent(cfg.project)}/_apis/git/repositories/` +
    `${encodeURIComponent(cfg.repo)}/pullRequests/${adoPrId}/reviewers/${userId}?api-version=7.1`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${cfg.auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ vote })
  })
  if (!res.ok) throw new Error(`Could not set your vote (${res.status})`)
}

/** Set the PR lifecycle status (active = reactivate, abandoned = abandon). */
export async function setPullRequestStatus(
  adoPrId: number,
  status: 'active' | 'abandoned'
): Promise<void> {
  const cfg = restConfig()
  if (!cfg) throw new Error('Azure DevOps is not configured')
  const res = await fetch(`${prRestUrl(cfg, adoPrId)}?api-version=7.1`, {
    method: 'PATCH',
    headers: {
      Authorization: `Basic ${cfg.auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ status })
  })
  if (!res.ok) throw new Error(`Could not update PR status (${res.status})`)
}

/** Toggle the PR's draft flag (true = mark draft, false = publish). */
export async function setPullRequestDraft(adoPrId: number, isDraft: boolean): Promise<void> {
  const cfg = restConfig()
  if (!cfg) throw new Error('Azure DevOps is not configured')
  const res = await fetch(`${prRestUrl(cfg, adoPrId)}?api-version=7.1`, {
    method: 'PATCH',
    headers: {
      Authorization: `Basic ${cfg.auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ isDraft })
  })
  if (!res.ok) throw new Error(`Could not update draft state (${res.status})`)
}

/**
 * Set the status of a specific comment thread (e.g. resolve or reopen).
 * Valid statuses: active, fixed (resolved), wontFix, closed, byDesign, pending.
 */
export async function setPullRequestThreadStatus(
  adoPrId: number,
  threadId: number,
  status: string
): Promise<void> {
  const cfg = restConfig()
  if (!cfg) throw new Error('Azure DevOps is not configured')
  const url =
    `https://dev.azure.com/${cfg.org}/${encodeURIComponent(cfg.project)}/_apis/git/repositories/` +
    `${encodeURIComponent(cfg.repo)}/pullRequests/${adoPrId}/threads/${threadId}?api-version=7.1`
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Basic ${cfg.auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ status })
  })
  if (!res.ok) throw new Error(`Could not update comment status (${res.status})`)
}

/**
 * The commit range for *this PR's own changes*: the merge base (common ancestor
 * with the target branch) as the base, and the latest source commit as the head.
 * Using the merge base rather than the target-branch tip means the diff excludes
 * changes from any PR this one is stacked on top of — matching the Azure DevOps
 * "Files" view. Falls back to the last-merge commits if iterations are missing.
 */
export async function fetchPullRequestDiffRange(
  adoPrId: number
): Promise<{ base: string | null; head: string | null }> {
  const cfg = restConfig()
  if (cfg) {
    try {
      const res = await fetch(`${prRestUrl(cfg, adoPrId)}/iterations?api-version=7.1`, {
        headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' }
      })
      if (res.ok) {
        const data = (await res.json()) as {
          value?: Array<{
            sourceRefCommit?: { commitId?: string }
            commonRefCommit?: { commitId?: string }
          }>
        }
        const iterations = data.value ?? []
        const last = iterations[iterations.length - 1]
        const base = last?.commonRefCommit?.commitId ?? null
        const head = last?.sourceRefCommit?.commitId ?? null
        if (base && head) return { base, head }
      }
    } catch {
      // fall through to the merge-commit fallback
    }
  }
  const commits = await fetchPullRequestMergeCommits(adoPrId)
  return { base: commits?.target ?? null, head: commits?.source ?? null }
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
  Array<
    Omit<
      PullRequest,
      | 'id'
      | 'reviewStatus'
      | 'reviewedCommit'
      | 'postedComments'
      | 'unaddressedComments'
      | 'commentReplies'
      | 'commentCount'
      | 'unresolvedCommentCount'
      | 'myVote'
    >
  >
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
    const reviewers = Array.isArray(r.reviewers) ? (r.reviewers as AnyRecord[]) : []
    const approvals = reviewers.filter((rv) => Number(rv.vote) >= 5).length
    const reviewerCount = reviewers.filter((rv) => Number(rv.vote) !== 0).length
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
      isDraft: Boolean(r.isDraft),
      approvals,
      reviewerCount,
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
 * Fetch every human-visible comment thread on a PR (including those raised by
 * other reviewers, not just BotSpector's own). Skips purely-system threads
 * (votes, status changes, ref updates) and anchors each thread to a file/line
 * when the comment was made on code. Uses REST for the full thread payload.
 */
export async function fetchPullRequestComments(adoPrId: number): Promise<AdoCommentThread[]> {
  const cfg = restConfig()
  if (!cfg) return []
  const url = `${prRestUrl(cfg, adoPrId)}/threads?api-version=7.1`
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${cfg.auth}`, Accept: 'application/json' }
  })
  if (!res.ok) return []
  const data = (await res.json()) as {
    value?: Array<{
      id?: number
      status?: string
      isDeleted?: boolean
      threadContext?: {
        filePath?: string
        rightFileStart?: { line?: number }
        leftFileStart?: { line?: number }
      }
      comments?: Array<{
        author?: { displayName?: string; uniqueName?: string }
        content?: string
        commentType?: string
        publishedDate?: string
        lastUpdatedDate?: string
        isDeleted?: boolean
      }>
    }>
  }

  const result: AdoCommentThread[] = []
  for (const t of data.value ?? []) {
    if (t.isDeleted) continue
    const comments = (t.comments ?? []).filter(
      (c) => !c.isDeleted && c.commentType !== 'system' && str(c.content).trim() !== ''
    )
    if (comments.length === 0) continue // system-only thread (vote/status/update)
    const ctx = t.threadContext ?? {}
    const line = ctx.rightFileStart?.line ?? ctx.leftFileStart?.line ?? null
    result.push({
      id: Number(t.id ?? 0),
      status: typeof t.status === 'string' ? t.status : null,
      filePath: ctx.filePath ? str(ctx.filePath).replace(/^\//, '') : null,
      line: typeof line === 'number' ? line : null,
      comments: comments.map((c) => ({
        author: c.author?.displayName || c.author?.uniqueName || 'Unknown',
        content: str(c.content),
        date: str(c.publishedDate || c.lastUpdatedDate) || null
      }))
    })
  }
  return result
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

/** Best-effort MIME type for an image based on its file extension. */
function imageMimeFromPath(pathname: string): string {
  const ext = pathname.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'bmp':
      return 'image/bmp'
    default:
      return ''
  }
}

/**
 * Fetch an image embedded in a PR description (an Azure DevOps attachment) using
 * the PAT and return it as a base64 data URL the renderer can display directly.
 * Only Azure DevOps hosts are fetched with credentials so the PAT is never sent
 * to an arbitrary URL that might appear in a description.
 */
export async function fetchImageAsDataUrl(rawUrl: string): Promise<string | null> {
  const pat = secrets.getAdoPat()
  if (!pat) return null

  let url: URL
  try {
    // Relative attachment paths resolve against the Azure DevOps host.
    url = new URL(rawUrl, 'https://dev.azure.com')
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()
  const isAdoHost = host === 'dev.azure.com' || host.endsWith('.visualstudio.com')
  if (url.protocol !== 'https:' || !isAdoHost) return null

  // REST attachment endpoints expect an api-version; add one if it's missing.
  if (url.pathname.includes('/_apis/') && !url.searchParams.has('api-version')) {
    url.searchParams.set('api-version', '7.1')
  }

  const auth = Buffer.from(`:${pat}`, 'utf-8').toString('base64')
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/octet-stream, image/*' }
  })
  if (!res.ok) throw new Error(`Could not fetch image (${res.status})`)

  const headerType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const mime = headerType.startsWith('image/')
    ? headerType
    : imageMimeFromPath(url.pathname) || 'application/octet-stream'
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${mime};base64,${buf.toString('base64')}`
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
 * Post a reply into an existing Azure DevOps comment thread. Uses REST so we can
 * target a specific thread (the MCP create-thread tool always starts a new one).
 */
export async function replyToPullRequestThread(
  adoPrId: number,
  threadId: number,
  content: string
): Promise<boolean> {
  const cfg = restConfig()
  if (!cfg) throw new Error('Azure DevOps is not configured')
  const url = `${prRestUrl(cfg, adoPrId)}/threads/${threadId}/comments?api-version=7.1`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${cfg.auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content, parentCommentId: 1, commentType: 'text' })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(
      `Failed to post reply (${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`
    )
  }
  return true
}

/**
 * Fetch the full PR description via the "get pull request" tool. The list tool
 * often omits the description, so we retrieve it on demand.
 */
export async function fetchPullRequestDescription(adoPrId: number): Promise<string | null> {
  const summary = await fetchPullRequestSummary(adoPrId)
  return summary?.description ?? null
}

/**
 * Fetch the current mutable PR fields (title, description, branches, status,
 * draft flag) via the "get pull request" tool. Used by the Refresh button so
 * changes made on Azure DevOps flow back into the app.
 */
export interface PullRequestSummary {
  title: string
  description: string
  sourceBranch: string
  targetBranch: string
  status: string
  isDraft: boolean
}

export async function fetchPullRequestSummary(
  adoPrId: number
): Promise<PullRequestSummary | null> {
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
  if (!obj) return null

  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    description: typeof obj.description === 'string' ? obj.description : '',
    sourceBranch: shortBranch(obj.sourceRefName),
    targetBranch: shortBranch(obj.targetRefName),
    status: typeof obj.status === 'string' ? obj.status : 'active',
    isDraft: !!obj.isDraft
  }
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
/**
 * Gather a compact description of the PR (metadata + changed-file list) for the
 * agent's seed context. Deliberately avoids dumping raw diffs/file blobs — the
 * agent pulls specific files via tools (which are size-capped) as needed. This
 * keeps the very first request well under the model's prompt-token limit even
 * for very large PRs.
 */
const MAX_CONTEXT_CHARS = 24000
const MAX_DESCRIPTION_CHARS = 4000
const MAX_LISTED_FILES = 300

export async function getPullRequestContext(adoPrId: number): Promise<PrContext> {
  const project = getSetting('adoProject')
  const repo = getSetting('adoRepo')
  const org = getSetting('adoOrg')

  const parts: string[] = []

  // Tell the agent exactly which repo/project/PR it's on so it doesn't waste
  // turns discovering them, and how to read files efficiently.
  parts.push(
    `You are reviewing pull request #${adoPrId} in repository "${repo}" ` +
      `(project "${project}", organization "${org}").\n` +
      `The changed files are listed below. Read the specific ones you need with the ` +
      `file-content tool (pass repository "${repo}" and project "${project}"). ` +
      `Do not fetch the entire PR diff at once.`
  )

  // Concise PR metadata parsed from the get tool (not the raw JSON dump).
  const getTool =
    (await findTool('pull_request', 'get')) ??
    (await findTool('get', 'pull_request')) ??
    (await findTool('pullrequest', 'get'))
  if (getTool) {
    try {
      const args = buildArgs(getTool, {
        project,
        repositoryId: repo,
        repository: repo,
        repositoryNameOrId: repo,
        pullRequestId: adoPrId,
        pullRequestId_: adoPrId
      })
      const text = await callTool(getTool.name, args)
      const parsed = parseJsonFromText(text)
      const pr = (Array.isArray(parsed) ? parsed[0] : parsed) as AnyRecord | undefined
      if (pr && (pr.title || pr.description)) {
        const description = str(pr.description)
        parts.push(
          `## Pull request #${adoPrId}\n` +
            `Title: ${str(pr.title)}\n` +
            `Status: ${str(pr.status) || 'active'}\n` +
            `Branch: ${shortBranch(pr.sourceRefName)} -> ${shortBranch(pr.targetRefName)}\n\n` +
            `Description:\n${description.slice(0, MAX_DESCRIPTION_CHARS) || '(none)'}`
        )
      } else {
        // Fallback: unknown shape — include a truncated slice of the raw text.
        parts.push('## Pull request details\n' + text.slice(0, MAX_DESCRIPTION_CHARS))
      }
    } catch (e) {
      parts.push(`(Could not fetch PR details: ${(e as Error).message})`)
    }
  }

  // A list of changed files (paths + change type) rather than full diffs. The
  // agent reads the ones it cares about via the file-content tool on demand.
  // Uses the PR's merge-base range so files from any stacked-on PR are excluded.
  try {
    const { base, head } = await fetchPullRequestDiffRange(adoPrId)
    if (base && head) {
      const files = await fetchChangedFiles(base, head)
      if (files.length > 0) {
        const listed = files
          .slice(0, MAX_LISTED_FILES)
          .map((f) => `- ${f.changeType}: ${f.path}`)
          .join('\n')
        const extra =
          files.length > MAX_LISTED_FILES
            ? `\n… and ${files.length - MAX_LISTED_FILES} more file(s)`
            : ''
        parts.push(`## Changed files (${files.length})\n${listed}${extra}`)
      }
    }
  } catch {
    // optional — the agent can still list/read files via tools
  }

  let summary = parts.join('\n\n')
  if (summary.length > MAX_CONTEXT_CHARS) {
    summary = summary.slice(0, MAX_CONTEXT_CHARS) + '\n\n…(seed context truncated to fit the model)'
  }
  return { summary }
}
