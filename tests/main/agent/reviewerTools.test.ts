import { describe, expect, it } from 'vitest'
import { isReadOnlyReviewTool } from '../../../src/main/agent/reviewer'

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
