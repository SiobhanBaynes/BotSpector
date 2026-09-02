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
  | 'declined'
  | 'error'

export type ReviewDepth = 'quick' | 'intensive'

export interface RepositoryProfile {
  id: string
  nickname: string
  adoOrg: string
  adoProject: string
  adoRepo: string
}

export type RepositoryProfileInput = Omit<RepositoryProfile, 'id'>

export interface Settings {
  adoOrg: string
  adoProject: string
  adoRepo: string
  repositoryProfiles: RepositoryProfile[]
  activeRepositoryProfileId: string | null
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

export interface ReviewSkillSnapshot {
  id: string
  name: string
  description: string
  source: SkillSource
  version: string | null
  instructions: string
  instructionsOverridden: boolean
  filePatterns: string[]
  toolAllowlist: string[]
}

export interface ReviewRunSettings {
  depth: ReviewDepth
  models: string[]
  skills: ReviewSkillSnapshot[]
}

// An immutable summary of one review pass: what it found and the exact model,
// skill configuration, and review options used at the time.
export interface ReviewSummary {
  id: number
  model: string
  createdAt: string
  reviewedCommit: string | null
  settings: ReviewRunSettings | null
  createdFindings: string[]
  contributedFindings: string[]
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

// A named prompt profile that shapes the reviewer for a particular focus (e.g.
// general code review, UI review). Skills are identified by a stable slug and
// swapped in as the reviewer's system-prompt instructions. They may also
// declare file patterns to focus on and an MCP tool-name allowlist.
//
// Skills come from two sources: 'builtin' (shipped with the app) and 'user'
// (imported from an on-disk SKILL.md folder, Anthropic-style).
export type SkillSource = 'builtin' | 'user'

export interface Skill {
  id: string
  name: string
  description: string
  instructions: string
  filePatterns?: string[]
  toolAllowlist?: string[]
  source: SkillSource
  // For imported skills: where the SKILL.md folder lives and its declared
  // version (from frontmatter), for display and update purposes.
  path?: string
  version?: string
  isBuiltIn: boolean
}

// The current effective instructions for a specific skill: what the reviewer
// will use, whether that's the built-in default or a user override, and the
// original default so the UI can offer a "reset" action.
export interface SkillInstructions {
  skillId: string
  instructions: string
  isDefault: boolean
  defaultInstructions: string
}

// A comment (by any author, incl. human reviewers) on an Azure DevOps PR thread.
export interface AdoComment {
  author: string
  content: string
  date: string | null
}

// A comment thread on the Azure DevOps PR — including ones raised by other
// people, not just those BotSpector posted. Anchored to a file/line when the
// reviewer commented on code.
export interface AdoCommentThread {
  id: number
  status: string | null
  filePath: string | null
  line: number | null
  comments: AdoComment[]
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  text: string
  oldLine: number | null
  newLine: number | null
}

// A file change pinned from the Files tab to be attached to the next chat message.
export interface PinnedFileChange {
  kind: 'change'
  path: string
  nonce: number
}

// A finding pinned from the Review tab to be attached to the next chat message.
export interface PinnedFinding {
  kind: 'finding'
  findingId: number
  publicId: string
  title: string
  filePath: string | null
  line: number | null
  nonce: number
}

// Whatever the user has pinned to the chat composer next. Only one at a time.
export type PinnedChange = PinnedFileChange | PinnedFinding

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
