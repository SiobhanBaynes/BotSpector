import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { diffLines } from 'diff'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import type {
  AdoCommentThread,
  ChangedFile,
  ChatMessage,
  CodeSnippet,
  CopilotModel,
  DeviceCodeInfo,
  FileDiff,
  Finding,
  FindingStatus,
  FindingThreadResolutionResult,
  IpcResult,
  OpenCodeCommitPreview,
  OpenCodeCommitResult,
  OpenCodeHandoff,
  OpenCodeStatus,
  OpenCodeSyncResult,
  PostedComment,
  PrAdoDetails,
  PullRequest,
  RepositoryProfileInput,
  ResolutionAssessment,
  Review,
  ReviewDepth,
  ReviewRunSettings,
  ReviewStatus,
  ReviewSummary,
  Settings,
  Skill,
  SkillInstructions
} from '../shared/types'
import { secrets } from './secrets'
import * as repo from './db/repo'
import * as auth from './copilot/auth'
import { listModels } from './copilot/client'
import { disconnect as disconnectAdoClients } from './mcp/adoClient'
import {
  listPullRequests,
  fetchPullRequestDescription,
  fetchPullRequestSummary,
  fetchPullRequestHeadCommit,
  fetchPullRequestDiffRange,
  fetchPullRequestThreads,
  fetchPullRequestDetails,
  fetchPullRequestListMeta,
  setPullRequestVote,
  addSelfAsOptionalReviewer,
  setPullRequestStatus,
  setPullRequestDraft,
  setPullRequestThreadStatus,
  fetchCurrentUserDisplayName,
  fetchChangedFiles,
  fetchFileContent,
  fetchImageAsDataUrl,
  fetchPullRequestComments,
  getPullRequestContext,
  replyAndResolvePullRequestThread,
  replyToPullRequestThread,
  postPullRequestComment
} from './mcp/adoService'
import {
  assessFindingResolution,
  chatAboutPullRequest,
  draftComment,
  explainFinding,
  explainFileChange,
  explainAdoComment,
  explainPullRequest,
  extractFindingFromChat,
  refineComment,
  reviewPullRequest
} from './agent/reviewer'
import { buildResolutionEvidence, type ResolutionFileVersion } from './agent/resolutionEvidence'
import { GENERAL_SKILL_ID, getSkill, listAllSkills, skillOverrideSettingKey } from './agent/skills'
import {
  importSkillFromFolder,
  importSkillFromGit,
  removeUserSkill,
  userSkillsDir
} from './agent/skillStore'
import { openLogs, logger } from './logger'
import {
  buildOpenCodeSeed,
  clearOpenCodeConfiguration,
  commitOpenCodeToPullRequest,
  containsInternalFindingNumber,
  configureOpenCode,
  createOpenCodeSession,
  detectOpenCode,
  getOpenCodeCommitPreview,
  getOpenCodeStatus,
  launchOpenCodeTui,
  messagesAfterOpenCodeAnchor,
  openCodeResolutionComment,
  readOpenCodeSession,
  readOpenCodeWorktreeFiles,
  RESOLUTION_COMMENT_MAX_LENGTH,
  resolutionCommentFromText,
  validateRepositoryCheckout
} from './opencode'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(error: unknown): IpcResult<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

// Run an async operation over items with a bounded number in flight at once, so
// large PR queues refresh quickly without spawning dozens of concurrent calls.
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < items.length) {
      const current = index++
      await fn(items[current])
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
}

// Use a per-call model override when provided, otherwise the Settings default.
function resolveModel(override?: string): string {
  const model = (override && override.trim()) || repo.getSetting('model')
  if (!model) throw new Error('No model selected. Choose one in Settings.')
  return model
}

function resolveReviewDepth(value?: string): ReviewDepth {
  return value === 'intensive' ? 'intensive' : 'quick'
}

function findingsSummaryForPr(prId: number): string {
  const review = repo.getReviewForPr(prId)
  return (review?.findings ?? [])
    .map((finding) => {
      const location = finding.filePath
        ? ` (${finding.filePath}${finding.line ? `:${finding.line}` : ''})`
        : ''
      return `- [${finding.publicId} · ${finding.bucket} · ${finding.status}] ${finding.title}${location}\n  ${finding.description}`
    })
    .join('\n')
}

function publicOpenCodeHandoff(handoff: repo.StoredOpenCodeHandoff): OpenCodeHandoff {
  return {
    findingId: handoff.findingId,
    findingPublicId: handoff.findingPublicId,
    sessionId: handoff.sessionId,
    worktreePath: handoff.worktreePath,
    branchName: handoff.branchName,
    baseCommit: handoff.baseCommit,
    lastPushedCommit: handoff.lastPushedCommit,
    changedFiles: handoff.changedFiles,
    fixAssessment: handoff.fixAssessment,
    prAssessment: handoff.prAssessment,
    createdAt: handoff.createdAt,
    lastSyncedAt: handoff.lastSyncedAt
  }
}

async function ensureOpenCodeHandoff(
  findingId: number,
  executablePath: string
): Promise<repo.StoredOpenCodeHandoff> {
  const existing = repo.getOpenCodeHandoffForFinding(findingId)
  if (existing) return existing

  const finding = repo.getFinding(findingId)
  if (!finding) throw new Error('Finding not found')
  const prId = repo.getPrIdForFinding(findingId)
  if (prId == null) throw new Error('Could not find the pull request for this finding.')
  const pullRequest = repo.getPullRequest(prId)
  if (!pullRequest) throw new Error('Pull request not found')
  const profile = repo.getCurrentRepositoryProfile()
  if (!profile?.localCheckoutPath) {
    throw new Error('Choose a local checkout for this repository in Settings first.')
  }
  const checkoutPath = await validateRepositoryCheckout(profile.localCheckoutPath, profile.adoRepo)
  const context = await getPullRequestContext(pullRequest.adoPrId)
  const seed = buildOpenCodeSeed({
    pullRequest,
    pullRequestContext: context.summary,
    findingsSummary: findingsSummaryForPr(prId),
    priorComments: repo.listPostedComments(prId),
    history: repo.listChatMessages(prId),
    finding
  })
  const created = await createOpenCodeSession({
    executablePath,
    checkoutPath,
    worktreesRoot: join(app.getPath('userData'), 'opencode-worktrees'),
    pullRequest,
    seed,
    finding
  })
  return repo.createOpenCodeHandoff(prId, findingId, created)
}

// Add ourselves as an optional reviewer on a PR — best-effort and non-blocking.
// Only called when the user actually engages (posts a comment or changes the
// PR status), not merely for kicking off an automated review. addSelf skips our
// own PRs and no-ops if we're already a reviewer.
async function ensureSelfReviewer(prId: number): Promise<void> {
  const pr = repo.getPullRequest(prId)
  if (!pr) return
  try {
    await addSelfAsOptionalReviewer(pr.adoPrId)
  } catch (e) {
    logger.warn(`could not add self as reviewer for pr id ${prId}`, {
      error: (e as Error).message
    })
  }
}

// Refresh the Azure DevOps thread status/replies for a PR's posted comments.
async function syncCommentThreads(prId: number): Promise<void> {
  const pr = repo.getPullRequest(prId)
  if (!pr) return
  // Live comments belong to the current review's findings; durable comments are
  // the PR-level history that survives re-reviews. Sync both from one fetch.
  const live = repo.getPostedCommentsForPr(prId)
  const durable = repo.listPostedComments(prId)
  if (live.length === 0 && durable.length === 0) return
  const threads = await fetchPullRequestThreads(pr.adoPrId)
  const byId = new Map(threads.map((t) => [t.id, t]))
  for (const c of live) {
    const t = byId.get(c.adoThreadId)
    if (!t) continue
    const replies = Math.max(0, t.commentCount - 1)
    repo.updateCommentThreadState(c.findingId, t.status, replies, t.replies)
  }
  for (const c of durable) {
    const t = byId.get(c.adoThreadId)
    if (!t) continue
    const replies = Math.max(0, t.commentCount - 1)
    repo.updatePostedCommentThreadState(prId, c.adoThreadId, t.status, replies, t.replies)
  }
}

function readSettings(): Settings {
  const activeRepositoryProfile = repo.getActiveRepositoryProfile()
  const activeRepositoryProfileId = activeRepositoryProfile?.id ?? null
  return {
    adoOrg: repo.getSetting('adoOrg'),
    adoProject: repo.getSetting('adoProject'),
    adoRepo: repo.getSetting('adoRepo'),
    repositoryProfiles: repo.listRepositoryProfiles().map((profile) => ({
      ...profile,
      hasAdoPat: !!secrets.getAdoPat(profile.id)
    })),
    activeRepositoryProfileId,
    model: repo.getSetting('model'),
    myIdentity: activeRepositoryProfile?.myIdentity ?? '',
    hasAdoPat: !!secrets.getAdoPat(activeRepositoryProfileId),
    copilotConnected: auth.isSignedIn()
  }
}

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function handlePullRequest<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, prId: number, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, (event, prId: number, ...args: Args) =>
    repo.withPullRequestProfile(prId, async () => handler(event, prId, ...args))
  )
}

function handleFinding<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, findingId: number, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, (event, findingId: number, ...args: Args) =>
    repo.withFindingProfile(findingId, async () => handler(event, findingId, ...args))
  )
}

export function registerIpcHandlers(): void {
  secrets.migrateLegacyAdoPat(repo.listRepositoryProfiles().map((profile) => profile.id))

  // ---- settings ----
  ipcMain.handle(IPC.settingsGet, (): IpcResult<Settings> => ok(readSettings()))

  ipcMain.handle(
    IPC.settingsSave,
    (_e, partial: Partial<Pick<Settings, 'model'>>): IpcResult<Settings> => {
      try {
        if (partial.model !== undefined) repo.setSetting('model', partial.model)
        return ok(readSettings())
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.repositoryProfileSave,
    async (
      _e,
      profileId: string | null,
      input: RepositoryProfileInput
    ): Promise<IpcResult<Settings>> => {
      try {
        const pat = typeof input.pat === 'string' ? input.pat.trim() : ''
        if (pat) secrets.assertSecureStorageAvailable()
        const localCheckoutPath = input.localCheckoutPath?.trim()
        const normalizedCheckout = localCheckoutPath
          ? await validateRepositoryCheckout(localCheckoutPath, input.adoRepo.trim())
          : ''
        const saved = repo.saveRepositoryProfile(profileId, {
          ...input,
          localCheckoutPath: normalizedCheckout
        })
        if (pat) {
          secrets.setAdoPat(saved.id, pat)
          await disconnectAdoClients()
        }
        return ok(readSettings())
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(
    IPC.repositoryChooseCheckout,
    async (_e, expectedRepository: string): Promise<IpcResult<string | null>> => {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Choose local repository checkout',
          properties: ['openDirectory']
        })
        if (result.canceled || !result.filePaths[0]) return ok(null)
        return ok(await validateRepositoryCheckout(result.filePaths[0], expectedRepository.trim()))
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.repositoryProfileSelect, (_e, profileId: string): IpcResult<Settings> => {
    try {
      repo.selectRepositoryProfile(profileId)
      return ok(readSettings())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    IPC.repositoryProfileDelete,
    async (_e, profileId: string): Promise<IpcResult<Settings>> => {
      try {
        repo.deleteRepositoryProfile(profileId)
        secrets.setAdoPat(profileId, null)
        await disconnectAdoClients()
        return ok(readSettings())
      } catch (e) {
        return fail(e)
      }
    }
  )

  ipcMain.handle(IPC.detectIdentity, async (_e, profileId: string): Promise<IpcResult<string>> => {
    try {
      const name = await repo.withRepositoryProfile(profileId, fetchCurrentUserDisplayName)
      if (!name) throw new Error('Could not determine your Azure DevOps display name')
      return ok(name)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.openCodeStatus, async (): Promise<IpcResult<OpenCodeStatus>> => {
    try {
      return ok(await getOpenCodeStatus())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.openCodeDetect, async (): Promise<IpcResult<OpenCodeStatus>> => {
    try {
      return ok(await detectOpenCode())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.openCodeChoose, async (): Promise<IpcResult<OpenCodeStatus>> => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Choose OpenCode executable',
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) return ok(await getOpenCodeStatus())
      return ok(await configureOpenCode(result.filePaths[0]))
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.openCodeClear, (): IpcResult<OpenCodeStatus> => {
    try {
      return ok(clearOpenCodeConfiguration())
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

  // ---- skills ----

  // A skill's default instructions (from the built-in definition) with the
  // user's override — if any — spliced in. Kept in one place so both the
  // read/write IPCs and the reviewer resolve skills identically.
  function readSkillInstructions(skillId: string): SkillInstructions | null {
    const skill = getSkill(skillId)
    if (!skill) return null
    const override = repo.getSetting(skillOverrideSettingKey(skillId))
    return {
      skillId: skill.id,
      instructions: override || skill.instructions,
      isDefault: !override,
      defaultInstructions: skill.instructions
    }
  }

  ipcMain.handle(IPC.skillList, (): IpcResult<Skill[]> => {
    try {
      return ok(listAllSkills())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.skillGetInstructions, (_e, skillId: string): IpcResult<SkillInstructions> => {
    try {
      const res = readSkillInstructions(skillId)
      if (!res) throw new Error(`Unknown skill: ${skillId}`)
      return ok(res)
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(
    IPC.skillSaveInstructions,
    (_e, skillId: string, instructions: string): IpcResult<SkillInstructions> => {
      try {
        const skill = getSkill(skillId)
        if (!skill) throw new Error(`Unknown skill: ${skillId}`)
        // An empty value (or the exact default) resets to the skill's default.
        const trimmed = (instructions ?? '').trim()
        const value = trimmed && trimmed !== skill.instructions.trim() ? trimmed : ''
        repo.setSetting(skillOverrideSettingKey(skillId), value)
        const res = readSkillInstructions(skillId)
        if (!res) throw new Error(`Unknown skill: ${skillId}`)
        return ok(res)
      } catch (e) {
        return fail(e)
      }
    }
  )

  // Import an external ("user") skill from a SKILL.md folder the user selects.
  ipcMain.handle(IPC.skillImport, async (): Promise<IpcResult<Skill>> => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = await dialog.showOpenDialog(win, {
        title: 'Select a skill folder (containing SKILL.md)',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        throw new Error('Import cancelled.')
      }
      const skill = importSkillFromFolder(result.filePaths[0])
      return ok(skill)
    } catch (e) {
      return fail(e)
    }
  })

  // Import an external skill directly from a Git repository (optionally pinned
  // to a ref and/or a subdirectory: "<url>#<ref>:<subdir>").
  ipcMain.handle(IPC.skillImportGit, async (_e, spec: string): Promise<IpcResult<Skill>> => {
    try {
      const skill = await importSkillFromGit(spec)
      return ok(skill)
    } catch (e) {
      return fail(e)
    }
  })

  // Reveal the imported-skills folder in the OS file manager.
  ipcMain.handle(IPC.skillOpenFolder, async (): Promise<IpcResult<null>> => {
    try {
      await shell.openPath(userSkillsDir())
      return ok(null)
    } catch (e) {
      return fail(e)
    }
  })

  // Remove an imported user skill (built-ins can't be removed). Also clears any
  // saved instruction override for it.
  ipcMain.handle(IPC.skillRemove, (_e, skillId: string): IpcResult<Skill[]> => {
    try {
      const skill = getSkill(skillId)
      if (!skill) throw new Error(`Unknown skill: ${skillId}`)
      if (skill.source !== 'user') throw new Error('Built-in skills cannot be removed.')
      removeUserSkill(skillId)
      repo.setSetting(skillOverrideSettingKey(skillId), '')
      return ok(listAllSkills())
    } catch (e) {
      return fail(e)
    }
  })

  // ---- pull requests ----
  ipcMain.handle(IPC.prListCached, (): IpcResult<PullRequest[]> => {
    // Instant, local-only: return the last synced PRs from the DB without
    // touching Azure DevOps. The renderer refreshes from ADO in the background.
    try {
      return ok(repo.listPullRequests())
    } catch (e) {
      return fail(e)
    }
  })

  ipcMain.handle(IPC.prList, async (): Promise<IpcResult<PullRequest[]>> => {
    try {
      const activeProfile = repo.getActiveRepositoryProfile()
      if (!activeProfile) throw new Error('Select a repository profile first.')
      return await repo.withRepositoryProfile(activeProfile.id, async () => {
        const prs = await listPullRequests()
        // Reconcile: anything not in the active set becomes inactive (hidden).
        repo.markAllPullRequestsInactive(activeProfile.id)
        for (const pr of prs) repo.upsertPullRequest({ ...pr, repo: activeProfile.id })
        // A profile can be switched while this network request is in flight.
        // The fetched rows stay safely partitioned, but skip optional enrichment
        // once another profile owns the visible queue.
        if (repo.getSetting('activeRepositoryProfileId') !== activeProfile.id) {
          return ok(repo.listPullRequests(activeProfile.id))
        }
        // Keep posted-comment reply counts fresh for the list badges. Run the
        // per-PR Azure DevOps calls with bounded concurrency so a large queue
        // refreshes in seconds rather than minutes (sequential was far too slow).
        await mapWithConcurrency(
          repo.getPrIdsWithPostedComments(activeProfile.id),
          6,
          async (prId) => {
            try {
              await syncCommentThreads(prId)
            } catch (e) {
              logger.warn(`could not sync comments for pr id ${prId}`, {
                error: (e as Error).message
              })
            }
          }
        )
        // Refresh the authoritative head commit for already-reviewed PRs so the
        // list can flag those that changed since review. The list tool's commit
        // field is unreliable, so use the same per-PR source the reviewer uses.
        await mapWithConcurrency(
          repo
            .listPullRequests(activeProfile.id)
            .filter((pr) => pr.reviewStatus === 'reviewed' || pr.reviewStatus === 'in_progress'),
          6,
          async (pr) => {
            try {
              const head = await fetchPullRequestHeadCommit(pr.adoPrId)
              if (head && head !== pr.headCommit) repo.updatePullRequestHeadCommit(pr.id, head)
            } catch (e) {
              logger.warn(`could not refresh head commit for pr id ${pr.id}`, {
                error: (e as Error).message
              })
            }
          }
        )
        // Enrich the list with live Azure DevOps metadata (draft, reviewer
        // approvals/votes, comment count) — the MCP list omits reviewer votes.
        await mapWithConcurrency(repo.listPullRequests(activeProfile.id), 6, async (pr) => {
          try {
            const meta = await fetchPullRequestListMeta(pr.adoPrId)
            if (meta) repo.updatePrAdoMeta(pr.id, meta)
          } catch (e) {
            logger.warn(`could not fetch ADO metadata for pr id ${pr.id}`, {
              error: (e as Error).message
            })
          }
        })
        return ok(repo.listPullRequests(activeProfile.id))
      })
    } catch (e) {
      return fail(e)
    }
  })

  handlePullRequest(IPC.prGet, async (_e, prId: number): Promise<IpcResult<PullRequest | null>> => {
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

  // Force-refresh a PR from Azure DevOps: title, description, branches, status,
  // draft flag, head commit and cached list metadata. Wired to the Refresh
  // button on the review detail page so edits made in Azure DevOps flow back.
  handlePullRequest(
    IPC.prRefresh,
    async (_e, prId: number): Promise<IpcResult<PullRequest | null>> => {
      try {
        const existing = repo.getPullRequest(prId)
        if (!existing) return ok(null)

        // Fetch the mutable PR fields, head commit and ADO metadata in parallel
        // — each is optional and failures shouldn't block the others.
        const [summaryRes, headRes, metaRes] = await Promise.allSettled([
          fetchPullRequestSummary(existing.adoPrId),
          fetchPullRequestHeadCommit(existing.adoPrId),
          fetchPullRequestListMeta(existing.adoPrId)
        ])

        if (summaryRes.status === 'fulfilled' && summaryRes.value) {
          repo.updatePullRequestSummary(prId, summaryRes.value)
        } else if (summaryRes.status === 'rejected') {
          logger.warn(`could not refresh summary for pr id ${prId}`, {
            error: (summaryRes.reason as Error).message
          })
        }

        if (headRes.status === 'fulfilled' && headRes.value) {
          repo.updatePullRequestHeadCommit(prId, headRes.value)
        } else if (headRes.status === 'rejected') {
          logger.warn(`could not refresh head commit for pr id ${prId}`, {
            error: (headRes.reason as Error).message
          })
        }

        if (metaRes.status === 'fulfilled' && metaRes.value) {
          repo.updatePrAdoMeta(prId, metaRes.value)
        } else if (metaRes.status === 'rejected') {
          logger.warn(`could not refresh ADO metadata for pr id ${prId}`, {
            error: (metaRes.reason as Error).message
          })
        }

        return ok(repo.getPullRequest(prId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(IPC.prGetReview, (_e, prId: number): IpcResult<Review | null> => {
    try {
      return ok(repo.getReviewForPr(prId))
    } catch (e) {
      return fail(e)
    }
  })

  handlePullRequest(IPC.prGetReviewHistory, (_e, prId: number): IpcResult<ReviewSummary[]> => {
    try {
      return ok(repo.listReviewSummaries(prId))
    } catch (e) {
      return fail(e)
    }
  })

  handlePullRequest(
    IPC.prSetReviewStatus,
    (_e, prId: number, status: ReviewStatus): IpcResult<PullRequest | null> => {
      try {
        repo.setReviewStatus(prId, status)
        // Changing the PR status counts as engaging with it: put us on as reviewer.
        void ensureSelfReviewer(prId)
        return ok(repo.getPullRequest(prId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetAdoDetails,
    async (_e, prId: number): Promise<IpcResult<PrAdoDetails | null>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) return ok(null)
        const details = await fetchPullRequestDetails(pr.adoPrId)
        if (details) repo.updatePrCommentCount(prId, details.commentCount)
        return ok(details)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prSetVote,
    async (_e, prId: number, vote: number): Promise<IpcResult<PrAdoDetails | null>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        await setPullRequestVote(pr.adoPrId, vote)
        // Approving (or approving with suggestions) in ADO marks it reviewed here.
        if (vote >= 5) repo.setReviewStatus(prId, 'reviewed')
        logger.info(`set reviewer vote ${vote} on ADO PR #${pr.adoPrId}`)
        return ok(await fetchPullRequestDetails(pr.adoPrId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prSetAdoStatus,
    async (
      _e,
      prId: number,
      status: 'active' | 'abandoned'
    ): Promise<IpcResult<PrAdoDetails | null>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        await setPullRequestStatus(pr.adoPrId, status)
        void ensureSelfReviewer(prId)
        logger.info(`set ADO status '${status}' on PR #${pr.adoPrId}`)
        return ok(await fetchPullRequestDetails(pr.adoPrId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prSetDraft,
    async (_e, prId: number, isDraft: boolean): Promise<IpcResult<PrAdoDetails | null>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        await setPullRequestDraft(pr.adoPrId, isDraft)
        void ensureSelfReviewer(prId)
        logger.info(`set draft=${isDraft} on ADO PR #${pr.adoPrId}`)
        return ok(await fetchPullRequestDetails(pr.adoPrId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetPostedComments,
    async (_e, prId: number): Promise<IpcResult<PostedComment[]>> => {
      try {
        // Best-effort refresh so thread status/conversation are current.
        try {
          await syncCommentThreads(prId)
        } catch (e) {
          logger.warn(`could not sync posted comments for pr id ${prId}`, {
            error: (e as Error).message
          })
        }
        return ok(repo.listPostedComments(prId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
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

  handlePullRequest(
    IPC.prExplainDescription,
    async (_e, prId: number, modelArg?: string): Promise<IpcResult<string>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const model = resolveModel(modelArg)
        // Explain from the actual changes (diffs/files) via tools, using the
        // description only as a hint — it may be missing, wrong, or out of date.
        return ok(
          await explainPullRequest(pr.adoPrId, model, pr.description, (message) =>
            send(IPC.prExplainProgress, { prId, message })
          )
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prExplainFileChange,
    async (_e, prId: number, path: string, modelArg?: string): Promise<IpcResult<string>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const model = resolveModel(modelArg)

        // Use the same commit range as the Files-tab diff view so the change we
        // explain matches exactly what the user sees (the PR's own changes,
        // base = merge-base). Using the raw merge commits here could pick a
        // base where the file differs, making the whole file look "added".
        const range = await fetchPullRequestDiffRange(pr.adoPrId)
        const head = range.head || pr.headCommit || undefined
        const base = range.base || undefined
        const after =
          (await fetchFileContent(path, { commit: head, branch: pr.sourceBranch }).catch(
            () => null
          )) ?? ''
        const before = base
          ? ((await fetchFileContent(path, { commit: base }).catch(() => null)) ?? '')
          : ''

        const diff = buildFileDiff(path, before, after)
        if (diff.lines.length === 0) {
          return ok('This file has no line changes to explain (metadata or rename only).')
        }
        const diffText = diff.lines
          .filter((l) => l.kind !== 'gap')
          .map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
          .join('\n')
          .slice(0, 12000)

        return ok(await explainFileChange(path, diffText, model))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetAdoComments,
    async (_e, prId: number): Promise<IpcResult<AdoCommentThread[]>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        return ok(await fetchPullRequestComments(pr.adoPrId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prExplainAdoComment,
    async (
      _e,
      prId: number,
      filePath: string | null,
      line: number | null,
      commentText: string,
      modelArg?: string
    ): Promise<IpcResult<string>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const model = resolveModel(modelArg)

        // Best-effort: attach the diff of the commented file so the explanation
        // can reference the actual change. Never let this block the explanation.
        let diffText: string | undefined
        if (filePath) {
          try {
            const range = await fetchPullRequestDiffRange(pr.adoPrId)
            const head = range.head || pr.headCommit || undefined
            const base = range.base || undefined
            const after =
              (await fetchFileContent(filePath, { commit: head, branch: pr.sourceBranch }).catch(
                () => null
              )) ?? ''
            const before = base
              ? ((await fetchFileContent(filePath, { commit: base }).catch(() => null)) ?? '')
              : ''
            const diff = buildFileDiff(filePath, before, after)
            const text = diff.lines
              .filter((l) => l.kind !== 'gap')
              .map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
              .join('\n')
              .slice(0, 8000)
            diffText = text || undefined
          } catch {
            // context is optional
          }
        }

        return ok(await explainAdoComment({ filePath, line, commentText, diffText }, model))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetCodeSnippet,
    async (
      _e,
      prId: number,
      filePath: string,
      line: number | null
    ): Promise<IpcResult<CodeSnippet | null>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        if (!filePath) return ok(null)
        const range = await fetchPullRequestDiffRange(pr.adoPrId)
        const headCommit = range.head || pr.headCommit || undefined
        const baseCommit = range.base || undefined
        const after =
          (await fetchFileContent(filePath, {
            commit: headCommit,
            branch: pr.sourceBranch || undefined
          }).catch(() => null)) ?? ''
        const before = baseCommit
          ? ((await fetchFileContent(filePath, { commit: baseCommit }).catch(() => null)) ?? '')
          : ''
        return ok(buildDiffSnippet(filePath, before, after, line))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prReplyToComment,
    async (
      _e,
      prId: number,
      threadId: number,
      content: string
    ): Promise<IpcResult<AdoCommentThread[]>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const text = content.trim()
        if (!text) throw new Error('Reply is empty')
        await replyToPullRequestThread(pr.adoPrId, threadId, text)
        // Return the refreshed threads so the UI shows the new reply immediately.
        return ok(await fetchPullRequestComments(pr.adoPrId))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetChangedFiles,
    async (_e, prId: number): Promise<IpcResult<ChangedFile[]>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const { base, head } = await fetchPullRequestDiffRange(pr.adoPrId)
        if (!base || !head) {
          throw new Error('Could not determine the PR base/head commits')
        }
        const files = await fetchChangedFiles(base, head)
        return ok(files)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prGetFileDiff,
    async (_e, prId: number, path: string): Promise<IpcResult<FileDiff>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const range = await fetchPullRequestDiffRange(pr.adoPrId)
        const head = range.head || pr.headCommit || undefined
        const base = range.base || undefined

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

  ipcMain.handle(IPC.prFetchImage, async (_e, url: string): Promise<IpcResult<string | null>> => {
    try {
      if (!url || typeof url !== 'string') return ok(null)
      return ok(await fetchImageAsDataUrl(url))
    } catch (e) {
      return fail(e)
    }
  })

  // Run a single reviewer pass for one model. Extracted so it can be reused by
  // both the single-model handler and the multi-model "panel review" handler.
  // The caller owns the surrounding lifecycle (setting 'reviewing' status,
  // emitting prReviewDone, etc.) so we don't fire duplicate events when
  // stacking reviewers.
  async function runReviewerPass(
    prId: number,
    model: string,
    headCommit: string,
    skillId: string,
    depth: ReviewDepth,
    reviewModels: string[],
    onProgress: (message: string) => void
  ): Promise<void> {
    const pr = repo.getPullRequest(prId)
    if (!pr) throw new Error('Pull request not found')
    const skill = getSkill(skillId) ?? getSkill(GENERAL_SKILL_ID)
    if (!skill) throw new Error('No review skill available')
    const override = repo.getSetting(skillOverrideSettingKey(skill.id))
    const instructions = override || skill.instructions
    const settings: ReviewRunSettings = {
      depth,
      models: [...reviewModels],
      skills: [
        {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.source,
          version: skill.version ?? null,
          instructions,
          instructionsOverridden: override.length > 0,
          filePatterns: [...(skill.filePatterns ?? [])],
          toolAllowlist: [...(skill.toolAllowlist ?? [])]
        }
      ]
    }
    const { findings, additions, raw } = await reviewPullRequest(
      pr.adoPrId,
      model,
      instructions,
      onProgress,
      repo.listPostedComments(prId),
      // Existing findings the new agent should not duplicate: everything raised
      // by other models, plus this model's own findings that we preserve (those
      // with a posted comment).
      (repo.getReviewForPr(prId)?.findings ?? []).filter(
        (f) => f.model !== model || f.comment?.status === 'posted'
      ),
      skill,
      depth
    )
    repo.createReview(prId, model, findings, raw, headCommit, {
      settings,
      contributedFindings: additions.map((addition) => addition.publicId)
    })
    // Merge this model's contributions into other agents' existing findings.
    repo.applyContributions(prId, model, additions)
    logger.info(
      `review pass completed for pr id ${prId} (${model}, skill=${skill.id}, depth=${depth}): ${findings.length} new finding(s), ${additions.length} contribution(s)`
    )
  }

  // Fetch the current head commit for the PR, updating the stored copy. Used at
  // the start of a review so we can detect later changes.
  async function captureHeadCommit(prId: number): Promise<string> {
    const pr = repo.getPullRequest(prId)
    if (!pr) throw new Error('Pull request not found')
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
    return headCommit
  }

  handlePullRequest(
    IPC.prReview,
    async (
      _e,
      prId: number,
      modelArg?: string,
      skillIdArg?: string,
      depthArg?: string
    ): Promise<IpcResult<Review>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const model = resolveModel(modelArg)
        const skillId = (skillIdArg ?? '').trim() || GENERAL_SKILL_ID
        const depth = resolveReviewDepth(depthArg)

        // Capture the current status/conversation of previously posted comments
        // before this re-review replaces the old findings, so that history is kept.
        try {
          await syncCommentThreads(prId)
        } catch (e) {
          logger.warn(`could not sync comment threads before re-review for pr id ${prId}`, {
            error: (e as Error).message
          })
        }

        repo.setReviewStatus(prId, 'reviewing')
        send(IPC.prReviewProgress, { prId, message: `Starting ${depth} review…` })
        logger.info(
          `review started for pr id ${prId} (ADO #${pr.adoPrId}) with model ${model}, skill ${skillId}, depth ${depth}`
        )

        const headCommit = await captureHeadCommit(prId)
        await runReviewerPass(prId, model, headCommit, skillId, depth, [model], (message) =>
          send(IPC.prReviewProgress, { prId, message })
        )
        // A fresh review has untriaged (open) findings, so this lands as
        // 'in_progress'; it only becomes 'reviewed' once every finding is handled.
        repo.recomputeReviewStatus(prId)

        const review = repo.getReviewForPr(prId)
        if (!review) throw new Error('Review was not saved')
        send(IPC.prReviewDone, { prId, status: 'reviewed' })
        return ok(review)
      } catch (e) {
        repo.setReviewStatus(prId, 'error')
        logger.error(`review failed for pr id ${prId}`, { error: (e as Error).message })
        send(IPC.prReviewDone, { prId, status: 'error' })
        return fail(e)
      }
    }
  )

  // Panel review: run several reviewers sequentially so their scrutiny stacks.
  // Each pass sees the findings the earlier ones raised, so overlaps become
  // "+1" contributions and only genuinely new issues are added.
  handlePullRequest(
    IPC.prReviewPanel,
    async (
      _e,
      prId: number,
      modelsArg: string[],
      skillIdArg?: string,
      depthArg?: string
    ): Promise<IpcResult<Review>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const models = Array.isArray(modelsArg)
          ? Array.from(new Set(modelsArg.map((m) => (m ?? '').trim()).filter(Boolean)))
          : []
        if (models.length === 0) throw new Error('No reviewers selected.')
        const skillId = (skillIdArg ?? '').trim() || GENERAL_SKILL_ID
        const depth = resolveReviewDepth(depthArg)

        try {
          await syncCommentThreads(prId)
        } catch (e) {
          logger.warn(`could not sync comment threads before panel review for pr id ${prId}`, {
            error: (e as Error).message
          })
        }

        repo.setReviewStatus(prId, 'reviewing')
        send(IPC.prReviewProgress, {
          prId,
          message: `Starting ${depth} panel review with ${models.length} reviewer${models.length === 1 ? '' : 's'}…`
        })
        logger.info(
          `panel review started for pr id ${prId} (ADO #${pr.adoPrId}) with models: ${models.join(', ')}, skill ${skillId}, depth ${depth}`
        )

        const headCommit = await captureHeadCommit(prId)

        for (let i = 0; i < models.length; i++) {
          const model = models[i]
          const prefix = `Reviewer ${i + 1}/${models.length} · ${model}`
          send(IPC.prReviewProgress, { prId, message: `${prefix} · starting…` })
          try {
            await runReviewerPass(prId, model, headCommit, skillId, depth, models, (message) =>
              send(IPC.prReviewProgress, { prId, message: `${prefix} · ${message}` })
            )
          } catch (e) {
            // Don't abandon the whole panel because one reviewer failed — log,
            // surface via progress, and continue with the remaining models.
            logger.error(`panel review: reviewer ${model} failed for pr id ${prId}`, {
              error: (e as Error).message
            })
            send(IPC.prReviewProgress, {
              prId,
              message: `${prefix} · failed: ${(e as Error).message}`
            })
          }
        }

        repo.recomputeReviewStatus(prId)
        const review = repo.getReviewForPr(prId)
        if (!review) throw new Error('Review was not saved')
        send(IPC.prReviewDone, { prId, status: 'reviewed' })
        return ok(review)
      } catch (e) {
        repo.setReviewStatus(prId, 'error')
        logger.error(`panel review failed for pr id ${prId}`, { error: (e as Error).message })
        send(IPC.prReviewDone, { prId, status: 'error' })
        return fail(e)
      }
    }
  )

  // ---- findings ----
  handleFinding(
    IPC.findingSetStatus,
    (_e, findingId: number, status: FindingStatus): IpcResult<null> => {
      try {
        repo.setFindingStatus(findingId, status)
        // Triaging a finding may complete (or re-open) the PR's review.
        const prId = repo.getPrIdForFinding(findingId)
        if (prId != null) repo.recomputeReviewStatus(prId)
        return ok(null)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingExplain,
    async (_e, findingId: number, modelArg?: string): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const model = resolveModel(modelArg)
        const explanation = await explainFinding(finding, model)
        repo.setFindingExplanation(findingId, explanation)
        return ok(explanation)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingCheckResolved,
    async (_e, findingId: number, modelArg?: string): Promise<IpcResult<ResolutionAssessment>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const model = resolveModel(modelArg)
        const review = repo.getReviewById(finding.reviewId)
        const pr = review ? repo.getPullRequest(review.prId) : null

        // Compare every relevant changed file so fixes made at another layer
        // (for example, at a caller rather than the commented helper) are visible.
        let diffEvidence = ''
        let checkedCommit = pr?.headCommit || review?.reviewedCommit || ''
        if (pr) {
          const range = await fetchPullRequestDiffRange(pr.adoPrId).catch(() => null)
          const headCommit = range?.head || pr.headCommit || undefined
          checkedCommit = headCommit || checkedCommit
          if (range?.head && range.head !== pr.headCommit) {
            repo.updatePullRequestHeadCommit(pr.id, range.head)
          }
          const baseCommit = range?.base || undefined
          const changedPaths =
            baseCommit && headCommit
              ? (await fetchChangedFiles(baseCommit, headCommit).catch(() => [])).map(
                  (file) => file.path
                )
              : []
          const seenPaths = new Set<string>()
          const paths = [finding.filePath, ...changedPaths]
            .filter((path): path is string => !!path)
            .filter((path) => {
              const normalized = path.replace(/^\/+/, '')
              if (seenPaths.has(normalized)) return false
              seenPaths.add(normalized)
              return true
            })
            .slice(0, 20)
          const files: ResolutionFileVersion[] = []
          await mapWithConcurrency(paths, 4, async (path) => {
            const after =
              (await fetchFileContent(path, {
                commit: headCommit,
                branch: pr.sourceBranch || undefined
              }).catch(() => null)) ?? ''
            const before = baseCommit
              ? ((await fetchFileContent(path, { commit: baseCommit }).catch(() => null)) ?? '')
              : ''
            files.push({ path, before, after })
          })
          diffEvidence = buildResolutionEvidence(files, finding.filePath)
        }

        const assessment = await assessFindingResolution(
          {
            finding,
            commentText: finding.comment?.draftText ?? finding.description,
            replies: finding.comment?.replies ?? [],
            diffEvidence
          },
          model
        )
        if (repo.getOpenCodeHandoffForFinding(findingId)) {
          repo.setOpenCodePrAssessment(findingId, assessment, checkedCommit)
        }
        return ok(assessment)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.prChat,
    async (
      _e,
      prId: number,
      message: string,
      modelArg?: string,
      findingId?: number
    ): Promise<IpcResult<string>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const text = message.trim()
        if (!text) throw new Error('Message is empty')
        if (findingId != null && repo.getPrIdForFinding(findingId) !== prId) {
          throw new Error('The selected finding does not belong to this pull request.')
        }
        const model = resolveModel(modelArg)
        const findingsSummary = findingsSummaryForPr(prId)
        const priorComments = repo.listPostedComments(prId)
        const scopedHistory = repo
          .listChatMessages(prId)
          .filter(
            (chatMessage) =>
              findingId == null ||
              chatMessage.findingId == null ||
              chatMessage.findingId === findingId
          )
        const history: ChatMessage[] = [
          ...scopedHistory,
          { role: 'user', content: text, findingId }
        ]
        const reply = await chatAboutPullRequest(
          { adoPrId: pr.adoPrId, findingsSummary, priorComments, history },
          model
        )
        // Only persist once the turn succeeds, so a failed call leaves no orphan.
        repo.addChatMessages(prId, [
          { role: 'user', content: text, findingId },
          { role: 'assistant', content: reply, findingId }
        ])
        return ok(reply)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.findingCreateFromChat,
    async (
      _e,
      prId: number,
      assistantMessage: string,
      modelArg?: string
    ): Promise<IpcResult<Finding>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const text = assistantMessage.trim()
        if (!text) throw new Error('Nothing to turn into a finding')
        const model = resolveModel(modelArg)
        const history = repo.listChatMessages(prId)
        const draft = await extractFindingFromChat(
          { adoPrId: pr.adoPrId, assistantMessage: text, history },
          model
        )
        const finding = repo.addManualFinding(prId, model, draft)
        // A new open finding may move the PR back into an in-progress state.
        repo.recomputeReviewStatus(prId)
        return ok(finding)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(
    IPC.findingCreateFromAdoComment,
    async (_e, prId: number, threadId: number, modelArg?: string): Promise<IpcResult<Finding>> => {
      try {
        const pr = repo.getPullRequest(prId)
        if (!pr) throw new Error('Pull request not found')
        const model = resolveModel(modelArg)

        // Look up the thread live so we always work from the current text and
        // status, not whatever the renderer had cached.
        const threads = await fetchPullRequestComments(pr.adoPrId)
        const thread = threads.find((t) => t.id === threadId)
        if (!thread) throw new Error('Comment thread not found')
        if (thread.comments.length === 0) throw new Error('Comment thread is empty')

        const locLabel = thread.filePath
          ? `${thread.filePath}${thread.line ? `:${thread.line}` : ''}`
          : 'general PR comment'
        const conversation = thread.comments.map((c) => `${c.author}: ${c.content}`).join('\n\n')
        const assistantMessage =
          `A reviewer left this comment on ${locLabel}. Turn the concern it raises ` +
          `into a review finding:\n\n${conversation}`

        const draft = await extractFindingFromChat(
          { adoPrId: pr.adoPrId, assistantMessage, history: [] },
          model
        )
        // Prefer the thread's own anchor when the model didn't pick one — the
        // reviewer already told us exactly which file/line the concern is about.
        if (!draft.filePath && thread.filePath) draft.filePath = thread.filePath
        if (draft.line == null && thread.line != null) draft.line = thread.line

        const finding = repo.addManualFinding(prId, model, draft)
        repo.recomputeReviewStatus(prId)
        return ok(finding)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handlePullRequest(IPC.prChatHistory, (_e, prId: number): IpcResult<ChatMessage[]> => {
    try {
      return ok(repo.listChatMessages(prId))
    } catch (e) {
      return fail(e)
    }
  })

  handlePullRequest(IPC.prChatClear, (_e, prId: number): IpcResult<null> => {
    try {
      repo.clearChatMessages(prId)
      return ok(null)
    } catch (e) {
      return fail(e)
    }
  })

  handlePullRequest(IPC.prOpenCodeHandoffs, (_e, prId: number): IpcResult<OpenCodeHandoff[]> => {
    try {
      return ok(repo.listOpenCodeHandoffs(prId).map(publicOpenCodeHandoff))
    } catch (e) {
      return fail(e)
    }
  })

  handleFinding(
    IPC.findingOpenCodeStart,
    async (_e, findingId: number): Promise<IpcResult<OpenCodeHandoff>> => {
      try {
        const status = await getOpenCodeStatus()
        if (!status.available || !status.executablePath) {
          throw new Error(status.error ?? 'Configure OpenCode in Settings first.')
        }
        const handoff = await ensureOpenCodeHandoff(findingId, status.executablePath)
        await launchOpenCodeTui(status.executablePath, handoff.worktreePath, handoff.sessionId)
        return ok(publicOpenCodeHandoff(handoff))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeReopen,
    async (_e, findingId: number): Promise<IpcResult<OpenCodeHandoff>> => {
      try {
        const status = await getOpenCodeStatus()
        if (!status.available || !status.executablePath) {
          throw new Error(status.error ?? 'Configure OpenCode in Settings first.')
        }
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        await launchOpenCodeTui(status.executablePath, handoff.worktreePath, handoff.sessionId)
        return ok(publicOpenCodeHandoff(handoff))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeSync,
    async (_e, findingId: number): Promise<IpcResult<OpenCodeSyncResult>> => {
      try {
        const status = await getOpenCodeStatus()
        if (!status.available || !status.executablePath) {
          throw new Error(status.error ?? 'Configure OpenCode in Settings first.')
        }
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        const snapshot = await readOpenCodeSession(
          status.executablePath,
          handoff.worktreePath,
          handoff.sessionId
        )
        const imported = messagesAfterOpenCodeAnchor(
          snapshot.messages,
          handoff.seedMessageId,
          handoff.lastSyncedMessageId
        )
        const synced = repo.applyOpenCodeSync(
          findingId,
          imported.messages,
          imported.lastMessageId,
          snapshot.changedFiles
        )
        return ok({
          handoff: publicOpenCodeHandoff(synced),
          importedMessages: imported.messages.length,
          inProgress: imported.inProgress
        })
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeCheckFix,
    async (_e, findingId: number, modelArg?: string): Promise<IpcResult<OpenCodeHandoff>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        const files = await readOpenCodeWorktreeFiles(
          handoff.worktreePath,
          handoff.baseCommit,
          finding.filePath
        )
        const diffEvidence = buildResolutionEvidence(files, finding.filePath)
        const assessment = await assessFindingResolution(
          {
            finding,
            commentText: finding.comment?.draftText ?? finding.description,
            replies: finding.comment?.replies ?? [],
            diffEvidence,
            evidenceKind: 'worktree'
          },
          resolveModel(modelArg)
        )
        return ok(publicOpenCodeHandoff(repo.setOpenCodeFixAssessment(findingId, assessment)))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeResolutionComment,
    async (_e, findingId: number): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        const prId = repo.getPrIdForFinding(findingId)
        if (prId == null) throw new Error('Could not find the pull request for this finding.')

        let liveError: string | null = null
        const status = await getOpenCodeStatus()
        if (status.available && status.executablePath) {
          try {
            const snapshot = await readOpenCodeSession(
              status.executablePath,
              handoff.worktreePath,
              handoff.sessionId
            )
            const comment = openCodeResolutionComment(
              snapshot.messages,
              handoff.seedMessageId,
              finding.publicId
            )
            if (comment) return ok(comment)
          } catch (error) {
            liveError = error instanceof Error ? error.message : String(error)
          }
        } else {
          liveError = status.error ?? 'OpenCode is not available.'
        }

        const syncedMessages = repo.listChatMessages(prId)
        for (let index = syncedMessages.length - 1; index >= 0; index -= 1) {
          const message = syncedMessages[index]
          if (
            message.source !== 'opencode' ||
            message.role !== 'assistant' ||
            message.findingId !== findingId
          ) {
            continue
          }
          const comment = resolutionCommentFromText(message.content, finding.publicId)
          if (comment) return ok(comment)
        }

        throw new Error(
          liveError
            ? `Could not load a completed OpenCode response for this finding. ${liveError}`
            : 'OpenCode has not produced a completed response for this finding yet.'
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeCommitPreview,
    async (_e, findingId: number): Promise<IpcResult<OpenCodeCommitPreview>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        const prId = repo.getPrIdForFinding(findingId)
        const pr = prId == null ? null : repo.getPullRequest(prId)
        if (!pr?.sourceBranch) throw new Error('The pull request source branch is unknown.')
        return ok(
          await getOpenCodeCommitPreview({
            worktreePath: handoff.worktreePath,
            branchName: handoff.branchName,
            baseCommit: handoff.baseCommit,
            lastPushedCommit: handoff.lastPushedCommit,
            knownPrHeadCommit: pr.headCommit,
            sourceBranch: pr.sourceBranch,
            findingPublicId: finding.publicId,
            findingTitle: finding.title
          })
        )
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingOpenCodeCommit,
    async (
      _e,
      findingId: number,
      commitMessage: string,
      snapshotId: string
    ): Promise<IpcResult<OpenCodeCommitResult>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const handoff = repo.getOpenCodeHandoffForFinding(findingId)
        if (!handoff) throw new Error('No OpenCode work session exists for this finding.')
        const prId = repo.getPrIdForFinding(findingId)
        const pr = prId == null ? null : repo.getPullRequest(prId)
        if (!pr?.sourceBranch) throw new Error('The pull request source branch is unknown.')
        const result = await commitOpenCodeToPullRequest(
          {
            worktreePath: handoff.worktreePath,
            branchName: handoff.branchName,
            baseCommit: handoff.baseCommit,
            lastPushedCommit: handoff.lastPushedCommit,
            knownPrHeadCommit: pr.headCommit,
            sourceBranch: pr.sourceBranch,
            findingPublicId: finding.publicId,
            findingTitle: finding.title
          },
          commitMessage,
          snapshotId
        )
        repo.setOpenCodeLastPushedCommit(findingId, result.commit)
        repo.updatePullRequestHeadCommit(pr.id, result.commit)
        return ok(result)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingGetCode,
    async (_e, findingId: number): Promise<IpcResult<CodeSnippet | null>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        if (!finding.filePath) return ok(null)

        const review = repo.getReviewById(finding.reviewId)
        const pr = review ? repo.getPullRequest(review.prId) : null

        const range = pr ? await fetchPullRequestDiffRange(pr.adoPrId) : null
        const headCommit = review?.reviewedCommit || range?.head || pr?.headCommit || undefined
        const baseCommit = range?.base || undefined

        // Fetch "after" (head) and "before" (base) versions of the file.
        const after =
          (await fetchFileContent(finding.filePath, {
            commit: headCommit,
            branch: pr?.sourceBranch || undefined
          }).catch(() => null)) ?? ''
        const before = baseCommit
          ? ((await fetchFileContent(finding.filePath, { commit: baseCommit }).catch(() => null)) ??
            '')
          : ''

        const snippet = buildDiffSnippet(finding.filePath, before, after, finding.line)
        return ok(snippet)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingDraftComment,
    async (_e, findingId: number, modelArg?: string): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        const model = resolveModel(modelArg)
        const text = await draftComment(finding, model)
        repo.upsertComment(findingId, text)
        return ok(text)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingRefineComment,
    async (
      _e,
      findingId: number,
      instruction: string,
      modelArg?: string
    ): Promise<IpcResult<string>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding) throw new Error('Finding not found')
        if (!finding.comment) throw new Error('Draft a comment before refining it')
        const model = resolveModel(modelArg)
        const text = await refineComment(finding.comment.draftText, instruction, model)
        repo.upsertComment(findingId, text)
        return ok(text)
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
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

  handleFinding(
    IPC.findingSetThreadStatus,
    async (_e, findingId: number, status: string): Promise<IpcResult<Review | null>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding?.comment?.adoThreadId) {
          throw new Error('This finding has no posted comment thread to update')
        }
        const review = repo.getReviewById(finding.reviewId)
        const pr = review ? repo.getPullRequest(review.prId) : null
        if (!pr) throw new Error('Could not find the pull request for this finding')
        await setPullRequestThreadStatus(pr.adoPrId, finding.comment.adoThreadId, status)
        logger.info(
          `set comment thread ${finding.comment.adoThreadId} to '${status}' on ADO PR #${pr.adoPrId}`
        )
        // Refresh local thread status/replies to reflect the change.
        await syncCommentThreads(pr.id)
        return ok(repo.getReviewForPr(pr.id))
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(
    IPC.findingCommentAndResolve,
    async (
      _e,
      findingId: number,
      content: string
    ): Promise<IpcResult<FindingThreadResolutionResult>> => {
      try {
        const finding = repo.getFinding(findingId)
        if (!finding?.comment?.adoThreadId) {
          throw new Error('This finding has no posted comment thread to resolve')
        }
        if (typeof content !== 'string') throw new Error('Enter a valid reply')
        const text = content.trim().replace(/\s+/g, ' ')
        if (!text) throw new Error('Reply is empty')
        if (text.length > RESOLUTION_COMMENT_MAX_LENGTH) {
          throw new Error(`Keep the reply to ${RESOLUTION_COMMENT_MAX_LENGTH} characters or fewer`)
        }
        if (containsInternalFindingNumber(text, finding.publicId)) {
          throw new Error('Remove internal finding numbers from the reply before posting')
        }
        const review = repo.getReviewById(finding.reviewId)
        const pr = review ? repo.getPullRequest(review.prId) : null
        if (!pr) throw new Error('Could not find the pull request for this finding')

        const result = await replyAndResolvePullRequestThread(
          pr.adoPrId,
          finding.comment.adoThreadId,
          text
        )
        let warning = result.warning
        try {
          await syncCommentThreads(pr.id)
        } catch (error) {
          const syncWarning = `Azure DevOps was updated, but BotSpector could not refresh the thread. ${error instanceof Error ? error.message : String(error)}`
          warning = warning ? `${warning} ${syncWarning}` : syncWarning
        }
        logger.info(`commented on finding ${finding.publicId} thread`, {
          adoPrId: pr.adoPrId,
          threadId: finding.comment.adoThreadId,
          resolved: result.resolved
        })
        return ok({ resolved: result.resolved, warning })
      } catch (e) {
        return fail(e)
      }
    }
  )

  handleFinding(IPC.findingPostComment, async (_e, findingId: number): Promise<IpcResult<null>> => {
    try {
      const finding = repo.getFinding(findingId)
      if (!finding) throw new Error('Finding not found')
      if (!finding.comment) throw new Error('Draft a comment before posting')

      // Find the PR this finding belongs to.
      const review = repo.getReviewById(finding.reviewId)
      const pr = review ? repo.getPullRequest(review.prId) : null
      if (!pr) throw new Error('Could not find the pull request for this finding')

      // Post only the comment text; the finding id/severity are tracked
      // internally via the Azure DevOps thread id and never exposed in ADO.
      const body = finding.comment.draftText.trim()
      if (containsInternalFindingNumber(body, finding.publicId)) {
        throw new Error('Remove internal finding numbers from the comment before posting')
      }
      logger.info(`posting comment for ${finding.publicId} to ADO PR #${pr.adoPrId}`)
      const threadId = await postPullRequestComment(
        pr.adoPrId,
        body,
        finding.filePath,
        finding.line
      )
      repo.markCommentPosted(findingId, threadId)
      repo.setFindingStatus(findingId, 'posted')
      // Posting responds to a finding, which may complete the PR's review.
      repo.recomputeReviewStatus(pr.id)
      // Posting a comment puts me on the PR as an optional reviewer.
      void ensureSelfReviewer(pr.id)
      // Track the posted comment at the PR level so its thread status and
      // conversation survive future re-reviews (which replace findings).
      if (threadId != null) {
        repo.recordPostedComment({
          prId: pr.id,
          adoThreadId: threadId,
          findingPublicId: finding.publicId,
          findingTitle: finding.title,
          bucket: finding.bucket,
          commentText: body
        })
      }
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
          entries.push({
            kind: 'del',
            text: line,
            oldLine: oldNum,
            newLine: null,
            anchor: newNum + 1
          })
        } else {
          oldNum++
          newNum++
          entries.push({
            kind: 'ctx',
            text: line,
            oldLine: oldNum,
            newLine: newNum,
            anchor: newNum
          })
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
        entries.push({
          kind: 'del',
          text: line,
          oldLine: oldNum,
          newLine: null,
          anchor: newNum + 1
        })
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
