// Shared types used across main, preload, and renderer.

export type FindingBucket = 'Blocking' | 'High' | 'Medium' | 'Low' | 'Nit'

export const FINDING_BUCKETS: FindingBucket[] = ['Blocking', 'High', 'Medium', 'Low', 'Nit']

export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'posted'

export type CommentStatus = 'draft' | 'posted'

export type ReviewStatus =
  | 'not_reviewed'
  | 'reviewing'
  | 'review_pending'
  | 'in_progress'
  | 'reviewed'
  | 'error'

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
  unaddressedComments: number
  commentReplies: number
  isDraft: boolean
  approvals: number
  reviewerCount: number
  commentCount: number
  unresolvedCommentCount: number
  myVote: number
  updatedAt: string
}

// A reviewer on the Azure DevOps PR and their vote.
// Vote values: 10 approved, 5 approved with suggestions, 0 no vote,
// -5 waiting for author, -10 rejected.
export interface PrReviewer {
  id: string
  displayName: string
  vote: number
  isRequired: boolean
}

// Live Azure DevOps state for a PR, fetched on demand for the detail page.
export interface PrAdoDetails {
  status: string
  isDraft: boolean
  reviewers: PrReviewer[]
  myVote: number
  commentCount: number
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
  model: string
  contributors: string[]
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

// A comment we posted to Azure DevOps, tracked at the PR level so its thread
// status and conversation survive re-reviews (which replace reviews/findings).
export interface PostedComment {
  id: number
  prId: number
  adoThreadId: number
  findingPublicId: string | null
  findingTitle: string | null
  bucket: FindingBucket | null
  commentText: string
  postedAt: string | null
  threadStatus: string | null
  replyCount: number
  replies: CommentReply[]
  updatedAt: string | null
}

export interface CopilotModel {
  id: string
  name: string
  vendor: string
}

// The AI's verdict on whether a posted finding has been resolved.
export interface ResolutionAssessment {
  verdict: 'resolved' | 'unresolved' | 'unclear'
  explanation: string
}

// A single message in the per-PR chat conversation.
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
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

// A file change pinned from the Files tab to be attached to the next chat message.
export interface PinnedChange {
  path: string
  nonce: number
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
