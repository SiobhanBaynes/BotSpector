// Shared types used across main, preload, and renderer.

export type FindingBucket = 'Blocking' | 'High' | 'Medium' | 'Low' | 'Nit'

export const FINDING_BUCKETS: FindingBucket[] = ['Blocking', 'High', 'Medium', 'Low', 'Nit']

export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'posted'

export type CommentStatus = 'draft' | 'posted'

export type ReviewStatus = 'not_reviewed' | 'reviewing' | 'reviewed' | 'error'

export interface Settings {
  adoOrg: string
  adoProject: string
  adoRepo: string
  model: string
  myIdentity: string
  hasAdoPat: boolean
  copilotConnected: boolean
}

export interface PullRequest {
  id: number
  adoPrId: number
  repo: string
  title: string
  description: string
  author: string
  status: string
  url: string
  sourceBranch: string
  targetBranch: string
  headCommit: string
  reviewedCommit: string | null
  reviewStatus: ReviewStatus
  postedComments: number
  commentReplies: number
  updatedAt: string
}

export interface Finding {
  id: number
  reviewId: number
  publicId: string
  bucket: FindingBucket
  title: string
  description: string
  filePath: string | null
  line: number | null
  status: FindingStatus
  explanation: string | null
  comment: Comment | null
}

export interface CommentReply {
  author: string
  text: string
  date: string | null
}

export interface Comment {
  id: number
  findingId: number
  draftText: string
  status: CommentStatus
  postedAt: string | null
  adoThreadId: number | null
  threadStatus: string | null
  replyCount: number
  replies: CommentReply[]
}

export interface Review {
  id: number
  prId: number
  model: string
  createdAt: string
  status: 'complete' | 'error'
  findings: Finding[]
}

export interface CopilotModel {
  id: string
  name: string
  vendor: string
}

export interface AgentInstructions {
  instructions: string
  isDefault: boolean
  defaultInstructions: string
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface CodeSnippet {
  filePath: string
  targetLine: number | null
  lines: DiffLine[]
  isDiff: boolean
}

export interface ChangedFile {
  path: string
  changeType: string
}

export interface FileDiff {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
}

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

// Discriminated result type for IPC calls that can fail gracefully.
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
