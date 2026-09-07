import { contextBridge, ipcRenderer } from 'electron'
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
  IpcResult,
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
  ReviewStatus,
  ReviewSummary,
  Settings,
  Skill,
  SkillInstructions
} from '../shared/types'

export interface ReviewProgress {
  prId: number
  message: string
}

export interface ReviewDone {
  prId: number
  status: 'reviewed' | 'error'
}

export interface LoginStatus {
  status: 'success' | 'error'
  error?: string
}

const api = {
  // settings
  getSettings: (): Promise<IpcResult<Settings>> => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (partial: Partial<Pick<Settings, 'model'>>): Promise<IpcResult<Settings>> =>
    ipcRenderer.invoke(IPC.settingsSave, partial),
  saveRepositoryProfile: (
    profileId: string | null,
    input: RepositoryProfileInput
  ): Promise<IpcResult<Settings>> =>
    ipcRenderer.invoke(IPC.repositoryProfileSave, profileId, input),
  selectRepositoryProfile: (profileId: string): Promise<IpcResult<Settings>> =>
    ipcRenderer.invoke(IPC.repositoryProfileSelect, profileId),
  deleteRepositoryProfile: (profileId: string): Promise<IpcResult<Settings>> =>
    ipcRenderer.invoke(IPC.repositoryProfileDelete, profileId),
  chooseRepositoryCheckout: (repository: string): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IPC.repositoryChooseCheckout, repository),
  detectIdentity: (profileId: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.detectIdentity, profileId),
  getOpenCodeStatus: (): Promise<IpcResult<OpenCodeStatus>> =>
    ipcRenderer.invoke(IPC.openCodeStatus),
  detectOpenCode: (): Promise<IpcResult<OpenCodeStatus>> => ipcRenderer.invoke(IPC.openCodeDetect),
  chooseOpenCode: (): Promise<IpcResult<OpenCodeStatus>> => ipcRenderer.invoke(IPC.openCodeChoose),
  clearOpenCode: (): Promise<IpcResult<OpenCodeStatus>> => ipcRenderer.invoke(IPC.openCodeClear),

  // copilot
  copilotStartLogin: (): Promise<IpcResult<DeviceCodeInfo>> =>
    ipcRenderer.invoke(IPC.copilotStartLogin),
  copilotCancelLogin: (): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.copilotCancelLogin),
  copilotSignOut: (): Promise<IpcResult<Settings>> => ipcRenderer.invoke(IPC.copilotSignOut),
  copilotListModels: (): Promise<IpcResult<CopilotModel[]>> =>
    ipcRenderer.invoke(IPC.copilotListModels),
  onLoginStatus: (cb: (s: LoginStatus) => void): (() => void) => {
    const handler = (_e: unknown, payload: LoginStatus): void => cb(payload)
    ipcRenderer.on(IPC.copilotLoginStatus, handler)
    return () => ipcRenderer.removeListener(IPC.copilotLoginStatus, handler)
  },

  // skills
  listSkills: (): Promise<IpcResult<Skill[]>> => ipcRenderer.invoke(IPC.skillList),
  getSkillInstructions: (skillId: string): Promise<IpcResult<SkillInstructions>> =>
    ipcRenderer.invoke(IPC.skillGetInstructions, skillId),
  saveSkillInstructions: (
    skillId: string,
    instructions: string
  ): Promise<IpcResult<SkillInstructions>> =>
    ipcRenderer.invoke(IPC.skillSaveInstructions, skillId, instructions),
  importSkill: (): Promise<IpcResult<Skill>> => ipcRenderer.invoke(IPC.skillImport),
  importSkillFromGit: (spec: string): Promise<IpcResult<Skill>> =>
    ipcRenderer.invoke(IPC.skillImportGit, spec),
  openSkillsFolder: (): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.skillOpenFolder),
  removeSkill: (skillId: string): Promise<IpcResult<Skill[]>> =>
    ipcRenderer.invoke(IPC.skillRemove, skillId),

  // pull requests
  listPullRequests: (): Promise<IpcResult<PullRequest[]>> => ipcRenderer.invoke(IPC.prList),
  listCachedPullRequests: (): Promise<IpcResult<PullRequest[]>> =>
    ipcRenderer.invoke(IPC.prListCached),
  getPullRequest: (prId: number): Promise<IpcResult<PullRequest | null>> =>
    ipcRenderer.invoke(IPC.prGet, prId),
  refreshPullRequest: (prId: number): Promise<IpcResult<PullRequest | null>> =>
    ipcRenderer.invoke(IPC.prRefresh, prId),
  getReview: (prId: number): Promise<IpcResult<Review | null>> =>
    ipcRenderer.invoke(IPC.prGetReview, prId),
  setReviewStatus: (prId: number, status: ReviewStatus): Promise<IpcResult<PullRequest | null>> =>
    ipcRenderer.invoke(IPC.prSetReviewStatus, prId, status),
  getAdoDetails: (prId: number): Promise<IpcResult<PrAdoDetails | null>> =>
    ipcRenderer.invoke(IPC.prGetAdoDetails, prId),
  setVote: (prId: number, vote: number): Promise<IpcResult<PrAdoDetails | null>> =>
    ipcRenderer.invoke(IPC.prSetVote, prId, vote),
  setAdoStatus: (
    prId: number,
    status: 'active' | 'abandoned'
  ): Promise<IpcResult<PrAdoDetails | null>> =>
    ipcRenderer.invoke(IPC.prSetAdoStatus, prId, status),
  setDraft: (prId: number, isDraft: boolean): Promise<IpcResult<PrAdoDetails | null>> =>
    ipcRenderer.invoke(IPC.prSetDraft, prId, isDraft),
  getPostedComments: (prId: number): Promise<IpcResult<PostedComment[]>> =>
    ipcRenderer.invoke(IPC.prGetPostedComments, prId),
  explainPrDescription: (prId: number, model?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.prExplainDescription, prId, model),
  explainFileChange: (prId: number, path: string, model?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.prExplainFileChange, prId, path, model),
  refreshComments: (prId: number): Promise<IpcResult<Review | null>> =>
    ipcRenderer.invoke(IPC.prRefreshComments, prId),
  getAdoComments: (prId: number): Promise<IpcResult<AdoCommentThread[]>> =>
    ipcRenderer.invoke(IPC.prGetAdoComments, prId),
  explainAdoComment: (
    prId: number,
    filePath: string | null,
    line: number | null,
    commentText: string,
    model?: string
  ): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.prExplainAdoComment, prId, filePath, line, commentText, model),
  getCodeSnippet: (
    prId: number,
    filePath: string,
    line: number | null
  ): Promise<IpcResult<CodeSnippet | null>> =>
    ipcRenderer.invoke(IPC.prGetCodeSnippet, prId, filePath, line),
  replyToAdoComment: (
    prId: number,
    threadId: number,
    content: string
  ): Promise<IpcResult<AdoCommentThread[]>> =>
    ipcRenderer.invoke(IPC.prReplyToComment, prId, threadId, content),
  getReviewHistory: (prId: number): Promise<IpcResult<ReviewSummary[]>> =>
    ipcRenderer.invoke(IPC.prGetReviewHistory, prId),
  getChangedFiles: (prId: number): Promise<IpcResult<ChangedFile[]>> =>
    ipcRenderer.invoke(IPC.prGetChangedFiles, prId),
  getFileDiff: (prId: number, path: string): Promise<IpcResult<FileDiff>> =>
    ipcRenderer.invoke(IPC.prGetFileDiff, prId, path),
  fetchImage: (url: string): Promise<IpcResult<string | null>> =>
    ipcRenderer.invoke(IPC.prFetchImage, url),
  reviewPullRequest: (
    prId: number,
    model?: string,
    skillId?: string,
    depth?: ReviewDepth
  ): Promise<IpcResult<Review>> => ipcRenderer.invoke(IPC.prReview, prId, model, skillId, depth),
  reviewPullRequestPanel: (
    prId: number,
    models: string[],
    skillId?: string,
    depth?: ReviewDepth
  ): Promise<IpcResult<Review>> =>
    ipcRenderer.invoke(IPC.prReviewPanel, prId, models, skillId, depth),
  onReviewProgress: (cb: (p: ReviewProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: ReviewProgress): void => cb(payload)
    ipcRenderer.on(IPC.prReviewProgress, handler)
    return () => ipcRenderer.removeListener(IPC.prReviewProgress, handler)
  },
  onExplainProgress: (cb: (p: ReviewProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: ReviewProgress): void => cb(payload)
    ipcRenderer.on(IPC.prExplainProgress, handler)
    return () => ipcRenderer.removeListener(IPC.prExplainProgress, handler)
  },
  onReviewDone: (cb: (p: ReviewDone) => void): (() => void) => {
    const handler = (_e: unknown, payload: ReviewDone): void => cb(payload)
    ipcRenderer.on(IPC.prReviewDone, handler)
    return () => ipcRenderer.removeListener(IPC.prReviewDone, handler)
  },

  // findings
  setFindingStatus: (findingId: number, status: FindingStatus): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingSetStatus, findingId, status),
  explainFinding: (findingId: number, model?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingExplain, findingId, model),
  getFindingCode: (findingId: number): Promise<IpcResult<CodeSnippet | null>> =>
    ipcRenderer.invoke(IPC.findingGetCode, findingId),
  draftComment: (findingId: number, model?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingDraftComment, findingId, model),
  refineComment: (
    findingId: number,
    instruction: string,
    model?: string
  ): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingRefineComment, findingId, instruction, model),
  updateComment: (findingId: number, text: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingUpdateComment, findingId, text),
  postComment: (findingId: number): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingPostComment, findingId),
  setThreadStatus: (findingId: number, status: string): Promise<IpcResult<Review | null>> =>
    ipcRenderer.invoke(IPC.findingSetThreadStatus, findingId, status),
  checkFindingResolved: (
    findingId: number,
    model?: string
  ): Promise<IpcResult<ResolutionAssessment>> =>
    ipcRenderer.invoke(IPC.findingCheckResolved, findingId, model),
  chatAboutPr: (prId: number, message: string, model?: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.prChat, prId, message, model),
  createFindingFromChat: (
    prId: number,
    assistantMessage: string,
    model?: string
  ): Promise<IpcResult<Finding>> =>
    ipcRenderer.invoke(IPC.findingCreateFromChat, prId, assistantMessage, model),
  createFindingFromAdoComment: (
    prId: number,
    threadId: number,
    model?: string
  ): Promise<IpcResult<Finding>> =>
    ipcRenderer.invoke(IPC.findingCreateFromAdoComment, prId, threadId, model),
  getChatHistory: (prId: number): Promise<IpcResult<ChatMessage[]>> =>
    ipcRenderer.invoke(IPC.prChatHistory, prId),
  clearChat: (prId: number): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.prChatClear, prId),
  getOpenCodeHandoff: (prId: number): Promise<IpcResult<OpenCodeHandoff | null>> =>
    ipcRenderer.invoke(IPC.prOpenCodeHandoff, prId),
  startOpenCodeHandoff: (prId: number): Promise<IpcResult<OpenCodeHandoff>> =>
    ipcRenderer.invoke(IPC.prOpenCodeStart, prId),
  reopenOpenCodeHandoff: (prId: number): Promise<IpcResult<OpenCodeHandoff>> =>
    ipcRenderer.invoke(IPC.prOpenCodeReopen, prId),
  syncOpenCodeHandoff: (prId: number): Promise<IpcResult<OpenCodeSyncResult>> =>
    ipcRenderer.invoke(IPC.prOpenCodeSync, prId),

  // diagnostics
  openLogs: (): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.logsOpen)
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
