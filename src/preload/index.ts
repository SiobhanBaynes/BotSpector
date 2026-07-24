import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AdoCommentThread,
  AgentInstructions,
  ChangedFile,
  ChatMessage,
  CodeSnippet,
  CopilotModel,
  DeviceCodeInfo,
  FileDiff,
  Finding,
  FindingStatus,
  IpcResult,
  PostedComment,
  PrAdoDetails,
  PullRequest,
  ResolutionAssessment,
  Review,
  ReviewStatus,
  ReviewSummary,
  Settings
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
  saveSettings: (
    partial: Partial<Pick<Settings, 'adoOrg' | 'adoProject' | 'adoRepo' | 'model' | 'myIdentity'>>
  ): Promise<IpcResult<Settings>> => ipcRenderer.invoke(IPC.settingsSave, partial),
  setAdoPat: (pat: string): Promise<IpcResult<Settings>> =>
    ipcRenderer.invoke(IPC.setAdoPat, pat),
  detectIdentity: (): Promise<IpcResult<string>> => ipcRenderer.invoke(IPC.detectIdentity),

  // copilot
  copilotStartLogin: (): Promise<IpcResult<DeviceCodeInfo>> =>
    ipcRenderer.invoke(IPC.copilotStartLogin),
  copilotCancelLogin: (): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.copilotCancelLogin),
  copilotSignOut: (): Promise<IpcResult<Settings>> => ipcRenderer.invoke(IPC.copilotSignOut),
  copilotListModels: (): Promise<IpcResult<CopilotModel[]>> =>
    ipcRenderer.invoke(IPC.copilotListModels),
  onLoginStatus: (cb: (s: LoginStatus) => void): (() => void) => {
    const handler = (_e: unknown, payload: LoginStatus): void => cb(payload)
    ipcRenderer.on(IPC.copilotLoginStatus, handler)
    return () => ipcRenderer.removeListener(IPC.copilotLoginStatus, handler)
  },

  // agent instructions
  getAgentInstructions: (): Promise<IpcResult<AgentInstructions>> =>
    ipcRenderer.invoke(IPC.agentGetInstructions),
  saveAgentInstructions: (instructions: string): Promise<IpcResult<AgentInstructions>> =>
    ipcRenderer.invoke(IPC.agentSaveInstructions, instructions),

  // pull requests
  listPullRequests: (): Promise<IpcResult<PullRequest[]>> => ipcRenderer.invoke(IPC.prList),
  listCachedPullRequests: (): Promise<IpcResult<PullRequest[]>> =>
    ipcRenderer.invoke(IPC.prListCached),
  getPullRequest: (prId: number): Promise<IpcResult<PullRequest | null>> =>
    ipcRenderer.invoke(IPC.prGet, prId),
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
  ): Promise<IpcResult<PrAdoDetails | null>> => ipcRenderer.invoke(IPC.prSetAdoStatus, prId, status),
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
  getReviewHistory: (prId: number): Promise<IpcResult<ReviewSummary[]>> =>
    ipcRenderer.invoke(IPC.prGetReviewHistory, prId),
  getChangedFiles: (prId: number): Promise<IpcResult<ChangedFile[]>> =>
    ipcRenderer.invoke(IPC.prGetChangedFiles, prId),
  getFileDiff: (prId: number, path: string): Promise<IpcResult<FileDiff>> =>
    ipcRenderer.invoke(IPC.prGetFileDiff, prId, path),
  reviewPullRequest: (prId: number, model?: string): Promise<IpcResult<Review>> =>
    ipcRenderer.invoke(IPC.prReview, prId, model),
  onReviewProgress: (cb: (p: ReviewProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: ReviewProgress): void => cb(payload)
    ipcRenderer.on(IPC.prReviewProgress, handler)
    return () => ipcRenderer.removeListener(IPC.prReviewProgress, handler)
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
  refineComment: (findingId: number, instruction: string, model?: string): Promise<IpcResult<string>> =>
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
  chatAboutPr: (
    prId: number,
    message: string,
    model?: string
  ): Promise<IpcResult<string>> => ipcRenderer.invoke(IPC.prChat, prId, message, model),
  createFindingFromChat: (
    prId: number,
    assistantMessage: string,
    model?: string
  ): Promise<IpcResult<Finding>> =>
    ipcRenderer.invoke(IPC.findingCreateFromChat, prId, assistantMessage, model),
  getChatHistory: (prId: number): Promise<IpcResult<ChatMessage[]>> =>
    ipcRenderer.invoke(IPC.prChatHistory, prId),
  clearChat: (prId: number): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.prChatClear, prId),

  // diagnostics
  openLogs: (): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.logsOpen)
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
