import { execFile } from 'child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import type { PullRequest } from '../../src/shared/types'
import {
  buildOpenCodeSeed,
  commitOpenCodeToPullRequest,
  containsInternalFindingNumber,
  getOpenCodeCommitPreview,
  messagesAfterOpenCodeAnchor,
  openCodeResolutionComment,
  readOpenCodeWorktreeFiles,
  validateRepositoryCheckout,
  windowsOpenCodeLaunchArgs
} from '../../src/main/opencode'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

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
  it('validates the complete Azure DevOps fetch and push destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botspector-opencode-remote-'))
    try {
      await git(root, ['init'])
      await git(root, [
        'remote',
        'add',
        'origin',
        'https://contoso@dev.azure.com/contoso/Dillon%20Way/_git/BotSpector.git'
      ])
      const expected = { adoOrg: 'Contoso', adoProject: 'Dillon Way', adoRepo: 'botspector' }

      await expect(validateRepositoryCheckout(root, expected)).resolves.toBe(await realpath(root))
      await expect(
        validateRepositoryCheckout(root, { ...expected, adoOrg: 'another-org' })
      ).rejects.toThrow('fetch URL')
      await expect(
        validateRepositoryCheckout(root, { ...expected, adoProject: 'another-project' })
      ).rejects.toThrow('fetch URL')

      const legacyRemote = 'user@vs-ssh.visualstudio.com:v3/contoso/Dillon%20Way/BotSpector.git'
      await git(root, ['remote', 'set-url', 'origin', legacyRemote])
      await git(root, ['remote', 'set-url', '--push', 'origin', legacyRemote])
      await expect(validateRepositoryCheckout(root, expected)).resolves.toBe(await realpath(root))

      await git(root, [
        'remote',
        'set-url',
        '--push',
        'origin',
        'git@ssh.dev.azure.com:v3/contoso/Dillon%20Way/another-repo'
      ])
      await expect(validateRepositoryCheckout(root, expected)).rejects.toThrow('push destination')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds a Windows START command for an executable outside PATH', () => {
    expect(
      windowsOpenCodeLaunchArgs(
        'C:\\Program Files\\OpenCode\\opencode.exe',
        'C:\\Worktrees\\PR 42',
        'session-123'
      )
    ).toEqual([
      '/d',
      '/c',
      'start',
      '',
      'C:\\Program Files\\OpenCode\\opencode.exe',
      'C:\\Worktrees\\PR 42',
      '--session',
      'session-123'
    ])
  })

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

  it('scopes a work session to one durable finding', () => {
    const seed = buildOpenCodeSeed({
      pullRequest,
      pullRequestContext: 'Changed files:\n- src/main.ts',
      findingsSummary: '- [F-001 · High · open] Validate input',
      priorComments: [],
      history: [
        { role: 'user', content: 'General PR context.' },
        { role: 'assistant', content: 'Stay on this finding.', findingId: 17 },
        { role: 'assistant', content: 'Unrelated finding context.', findingId: 99 }
      ],
      finding: {
        id: 17,
        reviewId: 4,
        publicId: 'F-001',
        bucket: 'High',
        title: 'Validate input',
        description: 'Reject malformed values before parsing.',
        filePath: 'src/main.ts',
        line: 42,
        status: 'posted',
        explanation: null,
        comment: {
          id: 9,
          findingId: 17,
          draftText: 'Please validate this input.',
          status: 'posted',
          adoThreadId: 30,
          postedAt: '2026-09-07',
          threadStatus: 'active',
          replyCount: 1,
          replies: [{ author: 'Dev', text: 'I will fix this.', date: null }]
        },
        model: 'gpt-5.6-sol',
        contributors: []
      }
    })

    expect(seed).toContain('Work scope: BotSpector finding F-001')
    expect(seed).toContain('Concern: Reject malformed values before parsing.')
    expect(seed).toContain('Location: src/main.ts:42')
    expect(seed).toContain('Review comment: Please validate this input.')
    expect(seed).toContain('Dev: I will fix this.')
    expect(seed).toContain('Address this finding only')
    expect(seed).toContain('Leave the result uncommitted and do not push it')
    expect(seed).toContain('`Resolution comment:` section')
    expect(seed).toContain('one accurate sentence of no more than 200 characters')
    expect(seed).toContain('Do not mention BotSpector or internal finding numbers')
    expect(seed).toContain('General PR context.')
    expect(seed).toContain('Stay on this finding.')
    expect(seed).not.toContain('Unrelated finding context.')
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

  it('uses the latest completed OpenCode resolution comment as the thread reply', () => {
    const result = openCodeResolutionComment(
      [
        message('seed', 'user', [{ type: 'text', text: 'session context' }]),
        message('assistant-1', 'assistant', [{ type: 'text', text: 'Earlier summary.' }]),
        message('user-2', 'user', [{ type: 'text', text: 'Please run the tests too.' }]),
        message('assistant-2', 'assistant', [
          { type: 'tool' },
          {
            type: 'text',
            text: 'Implemented the change and ran the tests.\n\nResolution comment:\nIncluded the local-debug tests in the automated test target; the full suite passes.'
          },
          { type: 'text', text: 'internal detail', ignored: true }
        ]),
        message(
          'assistant-streaming',
          'assistant',
          [{ type: 'text', text: 'This incomplete response must not be used.' }],
          false
        )
      ],
      'seed'
    )

    expect(result).toBe(
      'Included the local-debug tests in the automated test target; the full suite passes.'
    )
  })

  it('uses the full final assistant response for sessions without a resolution marker', () => {
    const result = openCodeResolutionComment(
      [
        message('seed', 'user', [{ type: 'text', text: 'session context' }]),
        message('assistant-1', 'assistant', [
          {
            type: 'text',
            text: 'Updated the deployment test target to include local-debug tests. All deployment tests pass.'
          }
        ])
      ],
      'seed'
    )

    expect(result).toBe('Updated the deployment test target to include local-debug tests.')
  })

  it('makes AI resolution comments one line and removes internal finding numbers', () => {
    const result = openCodeResolutionComment(
      [
        message('assistant-1', 'assistant', [
          {
            type: 'text',
            text: 'Resolution comment:\nFixed BotSpector finding REVIEW-7 by including the local-debug tests.\nThe automated suite now covers them.'
          }
        ])
      ],
      null,
      'REVIEW-7'
    )

    expect(result).toBe('Fixed this issue by including the local-debug tests.')
    expect(result).not.toContain('\n')
    expect(result).not.toContain('REVIEW-7')
    expect(containsInternalFindingNumber(result ?? '')).toBe(false)
    expect(containsInternalFindingNumber('Fix F-123 before merging.')).toBe(true)
    expect(containsInternalFindingNumber('Fix REVIEW-7 before merging.', 'REVIEW-7')).toBe(true)
  })

  it('caps AI resolution comments at the short reply limit', () => {
    const result = openCodeResolutionComment(
      [
        message('assistant-1', 'assistant', [
          {
            type: 'text',
            text: `Resolution comment: ${'Updated the affected validation path '.repeat(10)}`
          }
        ])
      ],
      null
    )

    expect(result).not.toBeNull()
    expect(result?.length).toBeLessThanOrEqual(200)
    expect(result).not.toContain('\n')
  })

  it('reads modified and new files as local worktree evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botspector-opencode-'))
    try {
      await mkdir(join(root, 'src'))
      await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1\n')
      await git(root, ['init'])
      await git(root, ['add', '.'])
      await git(root, [
        '-c',
        'user.name=BotSpector Test',
        '-c',
        'user.email=botspector@example.test',
        'commit',
        '-m',
        'base'
      ])
      const baseCommit = await git(root, ['rev-parse', 'HEAD'])

      await writeFile(join(root, 'src', 'main.ts'), 'export const value = 2\n')
      await writeFile(join(root, 'src', 'helper.ts'), 'export const helper = true\n')

      await expect(readOpenCodeWorktreeFiles(root, baseCommit, 'src/main.ts')).resolves.toEqual([
        {
          path: 'src/main.ts',
          before: 'export const value = 1\n',
          after: 'export const value = 2\n'
        },
        {
          path: 'src/helper.ts',
          before: '',
          after: 'export const helper = true\n'
        }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('previews, commits, and pushes a finding fix to the PR source branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botspector-opencode-publish-'))
    const checkout = join(root, 'checkout')
    const remote = join(root, 'remote.git')
    try {
      await mkdir(checkout)
      await mkdir(remote)
      await git(remote, ['init', '--bare'])
      await git(checkout, ['init'])
      await git(checkout, ['config', 'user.name', 'BotSpector Test'])
      await git(checkout, ['config', 'user.email', 'botspector@example.test'])
      await git(checkout, ['checkout', '-b', 'feature/fix'])
      await writeFile(join(checkout, 'base.txt'), 'base\n')
      await git(checkout, ['add', '.'])
      await git(checkout, ['commit', '-m', 'base'])
      const baseCommit = await git(checkout, ['rev-parse', 'HEAD'])
      await git(checkout, ['remote', 'add', 'origin', remote])
      await git(checkout, ['push', '-u', 'origin', 'feature/fix'])
      await git(checkout, ['checkout', '-b', 'botspector/pr-42-f-001'])
      await writeFile(join(checkout, 'fix.txt'), 'fixed\n')

      const input = {
        worktreePath: checkout,
        branchName: 'botspector/pr-42-f-001',
        baseCommit,
        sourceBranch: 'feature/fix',
        findingPublicId: 'F-001',
        findingTitle: 'Handle the edge case'
      }
      const stalePreview = await getOpenCodeCommitPreview(input)
      expect(stalePreview).toEqual({
        targetBranch: 'feature/fix',
        files: ['fix.txt'],
        hasUncommittedChanges: true,
        commitsAhead: 0,
        suggestedMessage: 'Fix: Handle the edge case',
        snapshotId: expect.stringMatching(/^[0-9a-f]{64}$/)
      })

      await writeFile(join(checkout, 'fix.txt'), 'fixed after preview\n')
      await expect(
        commitOpenCodeToPullRequest(input, 'Fix: Handle the edge case', stalePreview.snapshotId)
      ).rejects.toThrow('changed after the preview')

      const preview = await getOpenCodeCommitPreview(input)
      await expect(
        commitOpenCodeToPullRequest(input, 'Fix F-001: Handle the edge case', preview.snapshotId)
      ).rejects.toThrow('Remove the internal finding number')
      const result = await commitOpenCodeToPullRequest(
        input,
        'Fix: Handle the edge case',
        preview.snapshotId
      )

      expect(result).toMatchObject({ targetBranch: 'feature/fix', createdCommit: true })
      expect(result.commit).toMatch(/^[0-9a-f]{40}$/)
      await expect(git(remote, ['show', 'refs/heads/feature/fix:fix.txt'])).resolves.toBe(
        'fixed after preview'
      )

      const pushedInput = { ...input, lastPushedCommit: result.commit }
      await expect(getOpenCodeCommitPreview(pushedInput)).resolves.toMatchObject({
        files: [],
        hasUncommittedChanges: false,
        commitsAhead: 0
      })
      await expect(
        getOpenCodeCommitPreview({ ...input, knownPrHeadCommit: result.commit })
      ).resolves.toMatchObject({
        files: [],
        hasUncommittedChanges: false,
        commitsAhead: 0
      })

      await writeFile(join(checkout, 'next-fix.txt'), 'another fix\n')
      await expect(getOpenCodeCommitPreview(pushedInput)).resolves.toMatchObject({
        files: ['next-fix.txt'],
        hasUncommittedChanges: true,
        commitsAhead: 0
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rebases existing finding commits onto a newer PR head before pushing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'botspector-opencode-rebase-'))
    const checkout = join(root, 'checkout')
    const contributor = join(root, 'contributor')
    const remote = join(root, 'remote.git')
    try {
      await mkdir(checkout)
      await mkdir(remote)
      await git(remote, ['init', '--bare'])
      await git(checkout, ['init'])
      await git(checkout, ['config', 'user.name', 'BotSpector Test'])
      await git(checkout, ['config', 'user.email', 'botspector@example.test'])
      await git(checkout, ['checkout', '-b', 'feature/fix'])
      await writeFile(join(checkout, 'base.txt'), 'base\n')
      await git(checkout, ['add', '.'])
      await git(checkout, ['commit', '-m', 'base'])
      const baseCommit = await git(checkout, ['rev-parse', 'HEAD'])
      await git(checkout, ['remote', 'add', 'origin', remote])
      await git(checkout, ['push', '-u', 'origin', 'feature/fix'])

      await git(root, ['clone', '--branch', 'feature/fix', remote, contributor])
      await git(contributor, ['config', 'user.name', 'PR Author'])
      await git(contributor, ['config', 'user.email', 'author@example.test'])
      await writeFile(join(contributor, 'upstream.txt'), 'new PR work\n')
      await git(contributor, ['add', '.'])
      await git(contributor, ['commit', '-m', 'Advance PR'])
      await git(contributor, ['push', 'origin', 'feature/fix'])

      await git(checkout, ['checkout', '-b', 'botspector/pr-42-f-002'])
      await writeFile(join(checkout, 'fix.txt'), 'finding fix\n')
      await git(checkout, ['add', '.'])
      await git(checkout, ['commit', '-m', 'Handle the finding'])
      const input = {
        worktreePath: checkout,
        branchName: 'botspector/pr-42-f-002',
        baseCommit,
        sourceBranch: 'refs/heads/feature/fix',
        findingPublicId: 'F-002',
        findingTitle: 'Preserve concurrent work'
      }
      const preview = await getOpenCodeCommitPreview(input)
      expect(preview).toMatchObject({ hasUncommittedChanges: false, commitsAhead: 1 })

      const result = await commitOpenCodeToPullRequest(input, '', preview.snapshotId)

      expect(result).toMatchObject({ targetBranch: 'feature/fix', createdCommit: false })
      expect(await git(remote, ['show', 'refs/heads/feature/fix:upstream.txt'])).toBe('new PR work')
      expect(await git(remote, ['show', 'refs/heads/feature/fix:fix.txt'])).toBe('finding fix')
      expect(await git(remote, ['rev-parse', 'refs/heads/feature/fix'])).toBe(result.commit)

      await git(contributor, ['pull', '--ff-only'])
      await writeFile(join(contributor, 'later-upstream.txt'), 'later PR work\n')
      await git(contributor, ['add', '.'])
      await git(contributor, ['commit', '-m', 'Advance PR again'])
      await git(contributor, ['push', 'origin', 'feature/fix'])
      const advancedRemoteCommit = await git(remote, ['rev-parse', 'refs/heads/feature/fix'])

      await writeFile(join(checkout, 'second-fix.txt'), 'second finding fix\n')
      const secondInput = { ...input, lastPushedCommit: result.commit }
      const secondPreview = await getOpenCodeCommitPreview(secondInput)
      expect(secondPreview).toMatchObject({
        files: ['second-fix.txt'],
        hasUncommittedChanges: true,
        commitsAhead: 0
      })

      const secondResult = await commitOpenCodeToPullRequest(
        secondInput,
        'Extend the edge-case fix',
        secondPreview.snapshotId
      )

      expect(await git(remote, ['show', 'refs/heads/feature/fix:later-upstream.txt'])).toBe(
        'later PR work'
      )
      expect(await git(remote, ['show', 'refs/heads/feature/fix:second-fix.txt'])).toBe(
        'second finding fix'
      )
      expect(
        await git(remote, [
          'rev-list',
          '--count',
          `${advancedRemoteCommit}..refs/heads/feature/fix`
        ])
      ).toBe('1')
      expect(await git(remote, ['rev-parse', 'refs/heads/feature/fix'])).toBe(secondResult.commit)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
