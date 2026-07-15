import { BrowserWindow, ipcMain } from 'electron'
import { diffLines } from 'diff'
import { IPC } from '../shared/ipc'
import type {
  AgentInstructions,
  ChangedFile,
  CodeSnippet,
  CopilotModel,
  DeviceCodeInfo,
  FileDiff,
  FindingStatus,
  IpcResult,
  PullRequest,
  Review,
  Settings
} from '../shared/types'
import { secrets } from './secrets'
import * as repo from './db/repo'
import * as auth from './copilot/auth'
import { listModels } from './copilot/client'
import {
  listPullRequests,
  fetchPullRequestDescription,
  fetchPullRequestHeadCommit,
  fetchPullRequestMergeCommits,
  fetchPullRequestThreads,
  fetchCurrentUserDisplayName,
  fetchChangedFiles,
  fetchFileContent,
  postPullRequestComment
} from './mcp/adoService'
import {
  DEFAULT_REVIEW_INSTRUCTIONS,
  draftComment,
  explainFinding,
  explainPullRequest,
  refineComment,
  reviewPullRequest
} from './agent/reviewer'
import { openLogs, logger } from './logger'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

// Refresh the Azure DevOps thread status/replies for a PR's posted comments.
async function syncCommentThreads(prId: number): Promise<void> {
  const pr = repo.getPullRequest(prId)
  if (!pr) return
  const posted = repo.getPostedCommentsForPr(prId)
  if (posted.length === 0) return
  const threads = await fetchPullRequestThreads(pr.adoPrId)
  const byId = new Map(threads.map((t) => [t.id, t]))
  for (const c of posted) {
    const t = byId.get(c.adoThreadId)
    if (!t) continue
    const replies = Math.max(0, t.commentCount - 1)
    repo.updateCommentThreadState(c.findingId, t.status, replies, t.replies)
  }
}

function readSettings(): Settings {
  return {
    adoOrg: repo.getSetting('adoOrg'),
    adoProject: repo.getSetting('adoProject'),
    adoRepo: repo.getSetting('adoRepo'),
    model: repo.getSetting('model'),
    myIdentity: repo.getSetting('myIdentity'),
    hasAdoPat: !!secrets.getAdoPat(),
    copilotConnected: auth.isSignedIn()
  }
}

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(): void {
  // ---- settings ----
  ipcMain.handle(IPC.settingsGet, (): IpcResult<Settings> => ok(readSettings()))

  ipcMain.handle(
    IPC.settingsSave,
    (_e, partial: Partial<Pick<Settings, 'adoOrg' | 'adoProject' | 'adoRepo' | 'model' | 'myIdentity'>>):
      IpcResult<Settings> => {
      try {
        if (partial.adoOrg !== undefined) repo.setSetting('adoOrg', partial.adoOrg)
        if (partial.adoProject !== undefined) repo.setSetting('adoProject', partial.adoProject)
        if (partial.adoRepo !== undefined) repo.setSetting('adoRepo', partial.adoRepo)
        if (partial.model !== undefined) repo.setSetting('model', partial.model)
        if (partial.myIdentity !== undefined) repo.setSetting('myIdentity', partial.myIdentity)
        return ok(readSettings())
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.detectIdentity, async (): Promise<IpcResult<string>> => {
    try {
      const name = await fetchCurrentUserDisplayName()
      if (!name) throw new Error('Could not determine your Azure DevOps display name')
      repo.setSetting('myIdentity', name)
      return ok(name)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.setAdoPat, (_e, pat: string): IpcResult<Settings> => {
    try {
      secrets.setAdoPat(pat ? pat : null)
      return ok(readSettings())
    } catch (e) {
      return fail(e)
    }
  })

  // ---- copilot auth ----
  ipcMain.handle(IPC.copilotStartLogin, async (): Promise<IpcResult<DeviceCodeInfo>> => {
    try {
      const info = await auth.startDeviceLogin()
      // Kick off polling in the background; report status via events.
      void auth
        .pollForToken(info.interval)
        .then(() => send(IPC.copilotLoginStatus, { status: 'success' }))
        .catch((e: Error) => send(IPC.copilotLoginStatus, { status: 'error', error: e.message }))
      return ok(info)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.copilotCancelLogin, (): IpcResult<null> => {
    auth.cancelDeviceLogin()
    return ok(null)
  })

  ipcMain.handle(IPC.copilotSignOut, (): IpcResult<Settings> => {
    auth.signOut()
    return ok(readSettings())
  })

  ipcMain.handle(IPC.copilotListModels, async (): Promise<IpcResult<CopilotModel[]>> => {
    try {
      return ok(await listModels())
    } catch (e) {
      return fail(e)
    }
  })

  // ---- agent instructions ----
  ipcMain.handle(IPC.agentGetInstructions, (): IpcResult<AgentInstructions> => {
    const stored = repo.getSetting('reviewInstructions')
    return ok({
      instructions: stored || DEFAULT_REVIEW_INSTRUCTIONS,
      isDefault: !stored,
      defaultInstructions: DEFAULT_REVIEW_INSTRUCTIONS
    })
  })

  ipcMain.handle(
    IPC.agentSaveInstructions,
    (_e, instructions: string): IpcResult<AgentInstructions> => {
      try {
        // An empty value resets to the built-in default.
        const trimmed = (instructions ?? '').trim()
        repo.setSetting(
          'reviewInstructions',
          trimmed === DEFAULT_REVIEW_INSTRUCTIONS.trim() ? '' : trimmed
        )
        const stored = repo.getSetting('reviewInstructions')
        return ok({
          instructions: stored || DEFAULT_REVIEW_INSTRUCTIONS,
          isDefault: !stored,
          defaultInstructions: DEFAULT_REVIEW_INSTRUCTIONS
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  // ---- pull requests ----
  ipcMain.handle(IPC.prList, async (): Promise<IpcResult<PullRequest[]>> => {
    try {
      const prs = await listPullRequests()
      // Reconcile: anything not in the active set becomes inactive (hidden).
      repo.markAllPullRequestsInactive()
      for (const pr of prs) repo.upsertPullRequest(pr)
      // Keep posted-comment reply counts fresh for the list badges.
      for (const prId of repo.getPrIdsWithPostedComments()) {
        try {
          await syncCommentThreads(prId)
        } catch (e) {
          logger.warn(`could not sync comments for pr id ${prId}`, {
            error: (e as Error).message
          })
        }
      }
      return ok(repo.listPullRequests())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.prGet, async (_e, prId: number): Promise<IpcResult<PullRequest | null>> => {
    try {
      let pr = repo.getPullRequest(prId)
      if (!pr) return ok(null)

      // The list tool often omits the description; fetch it on demand.
      if (!pr.description.trim()) {
        try {
          const desc = await fetchPullRequestDescription(pr.adoPrId)
          if (desc && desc.trim()) repo.updatePullRequestDescription(prId, desc)
        } catch (e) {
          logger.warn(`could not fetch description for pr id ${prId}`, {
            error: (e as Error).message
          })
        }
      }

      // Refresh the head commit so re-review detection is current.
      try {
        const head = await fetchPullRequestHeadCommit(pr.adoPrId)
        if (head && head !== pr.headCommit) repo.updatePullRequestHeadCommit(prId, head)
      } catch (e) {
        logger.warn(`could not refresh head commit for pr id ${prId}`, {
          error: (e as Error).message
        })
      }

      pr = repo.getPullRequest(prId)
      return ok(pr)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.prGetReview, (_e, prId: number): IpcResult<Review | null> => {
    try {
      return ok(repo.getReviewForPr(prId))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    IPC.prRefreshComments,
    async (_e, prId: number): Promise<IpcResult<Review | null>> => {
      try {
        await syncCommentThreads(prId)
        return ok(repo.getReviewForPr(prId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.prExplainDescription,
    async (_e, prId: number): Promise<IpcResult<string>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        if (!pr.description.trim()) return ok('This pull request has no description.')
        const model = repo.getSetting('model')
        if (!model) throw new Error('No model selected. Choose one in Settings.')
        return ok(await explainPullRequest(pr.description, model))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.prGetChangedFiles,
    async (_e, prId: number): Promise<IpcResult<ChangedFile[]>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const commits = await fetchPullRequestMergeCommits(pr.adoPrId)
        if (!commits?.source || !commits?.target) {
          throw new Error('Could not determine the PR base/head commits')
        }
        const files = await fetchChangedFiles(commits.target, commits.source)
        return ok(files)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.prGetFileDiff,
    async (_e, prId: number, path: string): Promise<IpcResult<FileDiff>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const commits = await fetchPullRequestMergeCommits(pr.adoPrId)
        const head = commits?.source || pr.headCommit || undefined
        const base = commits?.target || undefined

        const after =
          (await fetchFileContent(path, { commit: head, branch: pr.sourceBranch }).catch(
            () => null
          )) ?? ''
        const before = base
          ? ((await fetchFileContent(path, { commit: base }).catch(() => null)) ?? '')
          : ''

        return ok(buildFileDiff(path, before, after))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.prReview, async (_e, prId: number): Promise<IpcResult<Review>> => {
    try {
      const pr = repo.getPullRequest(prId)
      if (!pr) throw new Error('Pull request not found')
      const model = repo.getSetting('model')
      if (!model) throw new Error('No model selected. Choose one in Settings.')
      const instructions = repo.getSetting('reviewInstructions') || undefined

      repo.setReviewStatus(prId, 'reviewing')
      send(IPC.prReviewProgress, { prId, message: 'Starting review…' })
      logger.info(`review started for pr id ${prId} (ADO #${pr.adoPrId}) with model ${model}`)

      // Capture the current head commit so we can detect later changes.
      let headCommit = pr.headCommit
      try {
        const fetched = await fetchPullRequestHeadCommit(pr.adoPrId)
        if (fetched) {
          headCommit = fetched
          repo.updatePullRequestHeadCommit(prId, fetched)
        }
      } catch (e) {
        logger.warn(`could not fetch head commit for pr id ${prId}`, {
          error: (e as Error).message
        })
      }

      const { findings, raw } = await reviewPullRequest(pr.adoPrId, model, instructions, (message) =>
        send(IPC.prReviewProgress, { prId, message })
      )
      repo.createReview(prId, model, findings, raw, headCommit)
      repo.setReviewStatus(prId, 'reviewed')
      logger.info(
        `review completed for pr id ${prId}: ${findings.length} finding(s) at commit ${headCommit.slice(0, 8) || 'n/a'}`
      )

      const review = repo.getReviewForPr(prId)
      if (!review) throw new Error('Review was not saved')
      return ok(review)
    } catch (e) {
      repo.setReviewStatus(prId, 'error')
      logger.error(`review failed for pr id ${prId}`, { error: (e as Error).message })
      return fail(e)
    }
  })

  // ---- findings ----
  ipcMain.handle(
    IPC.findingSetStatus,
    (_e, findingId: number, status: FindingStatus): IpcResult<null> => {
      try {
        repo.setFindingStatus(findingId, status)
        return ok(null)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.findingExplain, async (_e, findingId: number): Promise<IpcResult<string>> => {
    try {
      const finding = repo.getFinding(findingId)
      if (!finding) throw new Error('Finding not found')
      const model = repo.getSetting('model')
      const explanation = await explainFinding(finding, model)
      repo.setFindingExplanation(findingId, explanation)
      return ok(explanation)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    IPC.findingGetCode,
    async (_e, findingId: number): Promise<IpcResult<CodeSnippet | null>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        if (!finding.filePath) return ok(null)

        const review = repo.getReviewById(finding.reviewId)
        const pr = review ? repo.getPullRequest(review.prId) : null

        const commits = pr ? await fetchPullRequestMergeCommits(pr.adoPrId) : null
        const headCommit = review?.reviewedCommit || commits?.source || pr?.headCommit || undefined
        const baseCommit = commits?.target || undefined

        // Fetch "after" (head) and "before" (base) versions of the file.
        const after =
          (await fetchFileContent(finding.filePath, {
            commit: headCommit,
            branch: pr?.sourceBranch || undefined
          }).catch(() => null)) ?? ''
        const before = baseCommit
          ? ((await fetchFileContent(finding.filePath, { commit: baseCommit }).catch(
              () => null
            )) ?? '')
          : ''

        const snippet = buildDiffSnippet(finding.filePath, before, after, finding.line)
        return ok(snippet)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.findingDraftComment,
    async (_e, findingId: number): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const model = repo.getSetting('model')
        const text = await draftComment(finding, model)
        repo.upsertComment(findingId, text)
        return ok(text)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.findingRefineComment,
    async (_e, findingId: number, instruction: string): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        if (!finding.comment) throw new Error('Draft a comment before refining it')
        const model = repo.getSetting('model')
        const text = await refineComment(finding.comment.draftText, instruction, model)
        repo.upsertComment(findingId, text)
        return ok(text)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.findingUpdateComment,
    (_e, findingId: number, text: string): IpcResult<null> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        repo.upsertComment(findingId, text)
        return ok(null)
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.findingPostComment, async (_e, findingId: number): Promise<IpcResult<null>> => {
    try {
      const finding = repo.getFinding(findingId)
      if (!finding) throw new Error('Finding not found')
      if (!finding.comment) throw new Error('Draft a comment before posting')

      // Find the PR this finding belongs to.
      const review = repo.getReviewById(finding.reviewId)
      const pr = review ? repo.getPullRequest(review.prId) : null
      if (!pr) throw new Error('Could not find the pull request for this finding')

      const body = `[${finding.publicId} · ${finding.bucket}] ${finding.comment.draftText}`
      logger.info(`posting comment for ${finding.publicId} to ADO PR #${pr.adoPrId}`)
      const threadId = await postPullRequestComment(
        pr.adoPrId,
        body,
        finding.filePath,
        finding.line
      )
      repo.markCommentPosted(findingId, threadId)
      repo.setFindingStatus(findingId, 'posted')
      logger.info(`posted comment for ${finding.publicId} (thread ${threadId ?? 'n/a'})`)
      return ok(null)
    } catch (e) {
      logger.error(`failed to post comment for finding ${findingId}`, {
        error: (e as Error).message
      })
      return fail(e)
    }
  })

  // ---- diagnostics ----
  ipcMain.handle(IPC.logsOpen, async (): Promise<IpcResult<null>> => {
    try {
      await openLogs()
      return ok(null)
    } catch (e) {
      return fail(e)
    }
  })
}

// Build a windowed diff around a finding's line, comparing the base and head
// versions of the file. Falls back to plain context when the file is unchanged.
const DIFF_CONTEXT = 6

interface AnchoredLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldLine: number | null
  newLine: number | null
  anchor: number
}

function buildDiffSnippet(
  filePath: string,
  before: string,
  after: string,
  targetLine: number | null
): CodeSnippet {
  const target = targetLine && targetLine > 0 ? targetLine : null
  const changed = before !== after
  const entries: AnchoredLine[] = []
  let oldNum = 0
  let newNum = 0

  if (!changed) {
    const lines = after.split(/\r?\n/)
    for (const line of lines) {
      oldNum++
      newNum++
      entries.push({ kind: 'ctx', text: line, oldLine: newNum, newLine: newNum, anchor: newNum })
    }
  } else {
    for (const part of diffLines(before, after)) {
      const partLines = part.value.split('\n')
      if (partLines.length && partLines[partLines.length - 1] === '') partLines.pop()
      for (const line of partLines) {
        if (part.added) {
          newNum++
          entries.push({ kind: 'add', text: line, oldLine: null, newLine: newNum, anchor: newNum })
        } else if (part.removed) {
          oldNum++
          entries.push({ kind: 'del', text: line, oldLine: oldNum, newLine: null, anchor: newNum + 1 })
        } else {
          oldNum++
          newNum++
          entries.push({ kind: 'ctx', text: line, oldLine: oldNum, newLine: newNum, anchor: newNum })
        }
      }
    }
  }

  let selected: AnchoredLine[]
  if (target) {
    const lo = target - DIFF_CONTEXT
    const hi = target + DIFF_CONTEXT
    selected = entries.filter((e) => e.anchor >= lo && e.anchor <= hi)
    if (selected.length === 0) selected = entries.slice(0, DIFF_CONTEXT * 2 + 1)
  } else {
    selected = entries.slice(0, 40)
  }

  return {
    filePath,
    targetLine: target,
    isDiff: changed,
    lines: selected.map(({ kind, text, oldLine, newLine }) => ({ kind, text, oldLine, newLine }))
  }
}

// Build a full-file diff, collapsing long unchanged runs into "gap" markers.
const FILE_DIFF_CONTEXT = 3

function buildFileDiff(path: string, before: string, after: string): FileDiff {
  const entries: AnchoredLine[] = []
  let oldNum = 0
  let newNum = 0
  let added = 0
  let removed = 0

  if (before === after) {
    // Unchanged content (e.g. rename with no edits) — show nothing but the file.
    return { path, lines: [], added: 0, removed: 0 }
  }

  for (const part of diffLines(before, after)) {
    const partLines = part.value.split('\n')
    if (partLines.length && partLines[partLines.length - 1] === '') partLines.pop()
    for (const line of partLines) {
      if (part.added) {
        newNum++
        added++
        entries.push({ kind: 'add', text: line, oldLine: null, newLine: newNum, anchor: newNum })
      } else if (part.removed) {
        oldNum++
        removed++
        entries.push({ kind: 'del', text: line, oldLine: oldNum, newLine: null, anchor: newNum + 1 })
      } else {
        oldNum++
        newNum++
        entries.push({ kind: 'ctx', text: line, oldLine: oldNum, newLine: newNum, anchor: newNum })
      }
    }
  }

  // Keep context lines near changes; collapse the rest.
  const keep = new Array(entries.length).fill(false)
  entries.forEach((e, i) => {
    if (e.kind !== 'ctx') {
      for (let j = i - FILE_DIFF_CONTEXT; j <= i + FILE_DIFF_CONTEXT; j++) {
        if (j >= 0 && j < entries.length) keep[j] = true
      }
    }
  })

  const lines: FileDiff['lines'] = []
  let hidden = 0
  const flushGap = (): void => {
    if (hidden > 0) {
      lines.push({
        kind: 'gap',
        text: `⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}`,
        oldLine: null,
        newLine: null
      })
      hidden = 0
    }
  }
  entries.forEach((e, i) => {
    if (keep[i]) {
      flushGap()
      lines.push({ kind: e.kind, text: e.text, oldLine: e.oldLine, newLine: e.newLine })
    } else {
      hidden++
    }
  })
  flushGap()

  return { path, lines, added, removed }
}
