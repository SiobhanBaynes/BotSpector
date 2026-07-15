import { contextBridge, ipcRenderer } from 'electron'
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

export interface ReviewProgress {
  prId: number
  message: string
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
  getPullRequest: (prId: number): Promise<IpcResult<PullRequest | null>> =>
    ipcRenderer.invoke(IPC.prGet, prId),
  getReview: (prId: number): Promise<IpcResult<Review | null>> =>
    ipcRenderer.invoke(IPC.prGetReview, prId),
  explainPrDescription: (prId: number): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.prExplainDescription, prId),
  refreshComments: (prId: number): Promise<IpcResult<Review | null>> =>
    ipcRenderer.invoke(IPC.prRefreshComments, prId),
  getChangedFiles: (prId: number): Promise<IpcResult<ChangedFile[]>> =>
    ipcRenderer.invoke(IPC.prGetChangedFiles, prId),
  getFileDiff: (prId: number, path: string): Promise<IpcResult<FileDiff>> =>
    ipcRenderer.invoke(IPC.prGetFileDiff, prId, path),
  reviewPullRequest: (prId: number): Promise<IpcResult<Review>> =>
    ipcRenderer.invoke(IPC.prReview, prId),
  onReviewProgress: (cb: (p: ReviewProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: ReviewProgress): void => cb(payload)
    ipcRenderer.on(IPC.prReviewProgress, handler)
    return () => ipcRenderer.removeListener(IPC.prReviewProgress, handler)
  },

  // findings
  setFindingStatus: (findingId: number, status: FindingStatus): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingSetStatus, findingId, status),
  explainFinding: (findingId: number): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingExplain, findingId),
  getFindingCode: (findingId: number): Promise<IpcResult<CodeSnippet | null>> =>
    ipcRenderer.invoke(IPC.findingGetCode, findingId),
  draftComment: (findingId: number): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingDraftComment, findingId),
  refineComment: (findingId: number, instruction: string): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(IPC.findingRefineComment, findingId, instruction),
  updateComment: (findingId: number, text: string): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingUpdateComment, findingId, text),
  postComment: (findingId: number): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(IPC.findingPostComment, findingId),

  // diagnostics
  openLogs: (): Promise<IpcResult<null>> => ipcRenderer.invoke(IPC.logsOpen)
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('api', api)
