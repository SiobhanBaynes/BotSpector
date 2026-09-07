import { describe, expect, it } from 'vitest'
import type { PullRequest } from '../../src/shared/types'
import { buildOpenCodeSeed, messagesAfterOpenCodeAnchor } from '../../src/main/opencode'

function message(
  id: string,
  role: 'user' | 'assistant',
  parts: Array<{ type: string; text?: string; ignored?: boolean }>,
  completed = true
) {
  return {
    info: {
      id,
      role,
      ...(role === 'assistant' ? { time: completed ? { completed: 1 } : {} } : {})
    },
    parts
  }
}

const pullRequest: PullRequest = {
  id: 1,
  adoPrId: 42,
  repo: 'repo-profile',
  title: 'Keep the handoff compact',
  description: '',
  author: 'Siobhan',
  status: 'active',
  url: 'https://example.test/pr/42',
  sourceBranch: 'refs/heads/feature',
  targetBranch: 'refs/heads/main',
  headCommit: 'abcdef1234567890',
  reviewedCommit: null,
  reviewStatus: 'in_progress',
  postedComments: 0,
  unaddressedComments: 0,
  commentReplies: 0,
  isDraft: false,
  approvals: 0,
  reviewerCount: 1,
  commentCount: 0,
  unresolvedCommentCount: 0,
  myVote: 0,
  updatedAt: '2026-09-07'
}

describe('OpenCode handoff context', () => {
  it('seeds the PR, findings, comments, and recent conversation', () => {
    const seed = buildOpenCodeSeed({
      pullRequest,
      pullRequestContext: 'Changed files:\n- src/main.ts',
      findingsSummary: '- [F-001 · High · open] Validate input',
      priorComments: [
        {
          id: 1,
          prId: 1,
          adoThreadId: 10,
          findingPublicId: 'F-001',
          findingTitle: 'Validate input',
          bucket: 'High',
          commentText: 'Please validate this value.',
          postedAt: null,
          threadStatus: 'active',
          replyCount: 0,
          replies: [],
          updatedAt: null
        }
      ],
      history: [
        { role: 'user', content: 'Can we fix this now?' },
        { role: 'assistant', content: 'Yes, update the parser.' }
      ]
    })

    expect(seed).toContain('Pull request: #42 Keep the handoff compact')
    expect(seed).toContain('Changed files:\n- src/main.ts')
    expect(seed).toContain('F-001')
    expect(seed).toContain('Please validate this value.')
    expect(seed).toContain('User: Can we fix this now?')
    expect(seed).toContain('BotSpector: Yes, update the parser.')
  })

  it('imports only visible messages after the sync anchor', () => {
    const result = messagesAfterOpenCodeAnchor(
      [
        message('seed', 'user', [{ type: 'text', text: 'large seed' }]),
        message('user-1', 'user', [{ type: 'text', text: 'Make the change.' }]),
        message('assistant-1', 'assistant', [
          { type: 'tool' },
          { type: 'text', text: 'Updated the parser.' },
          { type: 'text', text: 'hidden', ignored: true }
        ])
      ],
      'seed',
      'seed'
    )

    expect(result).toEqual({
      messages: [
        { role: 'user', content: 'Make the change.', source: 'opencode' },
        { role: 'assistant', content: 'Updated the parser.', source: 'opencode' }
      ],
      lastMessageId: 'assistant-1',
      inProgress: false
    })
  })

  it('does not duplicate previously synced messages', () => {
    const result = messagesAfterOpenCodeAnchor(
      [
        message('seed', 'user', [{ type: 'text', text: 'seed' }]),
        message('assistant-1', 'assistant', [{ type: 'text', text: 'First result' }]),
        message('user-2', 'user', [{ type: 'text', text: 'One more change' }])
      ],
      'seed',
      'assistant-1'
    )

    expect(result.messages).toEqual([
      { role: 'user', content: 'One more change', source: 'opencode' }
    ])
    expect(result.lastMessageId).toBe('user-2')
    expect(result.inProgress).toBe(false)
  })

  it('leaves a streaming assistant message for the next sync', () => {
    const result = messagesAfterOpenCodeAnchor(
      [
        message('seed', 'user', [{ type: 'text', text: 'seed' }]),
        message('user-1', 'user', [{ type: 'text', text: 'Make the change' }]),
        message('assistant-1', 'assistant', [{ type: 'text', text: 'Partial response' }], false)
      ],
      'seed',
      'seed'
    )

    expect(result).toEqual({
      messages: [{ role: 'user', content: 'Make the change', source: 'opencode' }],
      lastMessageId: 'user-1',
      inProgress: true
    })
  })

  it('refuses an ambiguous sync when the previous anchor disappeared', () => {
    expect(() =>
      messagesAfterOpenCodeAnchor(
        [message('new-message', 'assistant', [{ type: 'text', text: 'Result' }])],
        'seed',
        'missing-anchor'
      )
    ).toThrow('last synced message')
  })
})
