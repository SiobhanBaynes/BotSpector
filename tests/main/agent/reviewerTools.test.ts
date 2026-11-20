import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Finding } from '../../../src/shared/types'

vi.mock('../../../src/main/copilot/client', () => ({ complete: vi.fn() }))
vi.mock('../../../src/main/mcp/adoClient', () => ({ listTools: vi.fn() }))
vi.mock('../../../src/main/mcp/adoService', () => ({ getPullRequestContext: vi.fn() }))
vi.mock('../../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn() }
}))

import { complete } from '../../../src/main/copilot/client'
import { listTools } from '../../../src/main/mcp/adoClient'
import { getPullRequestContext } from '../../../src/main/mcp/adoService'
import { isReadOnlyReviewTool, reviewPullRequest } from '../../../src/main/agent/reviewer'

describe('reviewer tool safety', () => {
  it.each([
    'repo_get_pull_request_by_id',
    'repo_list_pull_requests_by_repo_or_project',
    'repo_list_pull_request_thread_comments',
    'repo_get_file_content',
    'repo_search_commits',
    'search_code',
    'pipelines_get_build_log',
    'wit_query_by_wiql'
  ])('allows known read operation %s', (name) => {
    expect(isReadOnlyReviewTool(name)).toBe(true)
  })

  describe('review report validation', () => {
    beforeEach(() => {
      vi.resetAllMocks()
      vi.mocked(listTools).mockResolvedValue([])
      vi.mocked(getPullRequestContext).mockResolvedValue({ summary: 'Test pull request' })
    })

    it('normalizes findings with missing or nullable optional fields', async () => {
      vi.mocked(complete).mockResolvedValue({
        toolCalls: [],
        content: JSON.stringify({
          findings: [
            { bucket: ' high ', title: ' First ', description: ' Details ' },
            {
              id: ' F-002 ',
              bucket: 'Low',
              title: 'Second',
              description: 'Details',
              file: null,
              line: null
            }
          ]
        })
      })

      const result = await reviewPullRequest(42, 'test-model')

      expect(result.findings).toEqual([
        {
          publicId: 'F-001',
          bucket: 'High',
          title: 'First',
          description: 'Details',
          filePath: null,
          line: null
        },
        {
          publicId: 'F-002',
          bucket: 'Low',
          title: 'Second',
          description: 'Details',
          filePath: null,
          line: null
        }
      ])
    })

    it('rejects malformed findings after requesting a repaired report', async () => {
      vi.mocked(complete).mockResolvedValue({
        toolCalls: [],
        content: JSON.stringify({
          findings: [{ bucket: 'High', title: 'Invalid', description: 'Details', line: '12' }]
        })
      })

      await expect(reviewPullRequest(42, 'test-model')).rejects.toThrow(
        'The model did not return valid JSON findings.'
      )
      expect(complete).toHaveBeenCalledTimes(2)
      expect(vi.mocked(complete).mock.calls[1][0].messages.at(-1)).toMatchObject({
        role: 'user',
        content: expect.stringContaining('not valid JSON')
      })
    })

    it('validates merge decisions and converts duplicate findings into contributions', async () => {
      const existing: Finding = {
        id: 1,
        reviewId: 1,
        publicId: 'F-001',
        bucket: 'High',
        title: 'Existing issue',
        description: 'Details',
        filePath: null,
        line: null,
        status: 'open',
        explanation: null,
        comment: null,
        model: 'previous-model',
        contributors: []
      }
      vi.mocked(complete)
        .mockResolvedValueOnce({
          toolCalls: [],
          content: JSON.stringify({
            findings: [{ bucket: 'High', title: 'Same issue', description: 'Details' }]
          })
        })
        .mockResolvedValueOnce({
          toolCalls: [],
          content: JSON.stringify({ decisions: [{ candidateIndex: 0, duplicateOf: 'F-001' }] })
        })

      await expect(
        reviewPullRequest(42, 'test-model', undefined, undefined, [], [existing])
      ).resolves.toMatchObject({
        findings: [],
        additions: [{ publicId: 'F-001', note: 'Same issue' }]
      })
    })
  })

  it.each([
    'pipelines_run_pipeline',
    'pipelines_build_download',
    'pipelines_download_artifact',
    'pipelines_queue',
    'repo_vote_pull_request',
    'repo_update_pull_request_thread',
    'future_unknown_operation'
  ])('blocks write or unknown operation %s', (name) => {
    expect(isReadOnlyReviewTool(name)).toBe(false)
  })
})
