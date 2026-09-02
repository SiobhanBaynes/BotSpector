import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepositoryProfileInput } from '../../../src/shared/types'
import { runMigrations } from '../../../src/main/db/migrations'

const state = vi.hoisted(() => ({ database: null as Database.Database | null }))

vi.mock('../../../src/main/db/db', () => ({
  getDb: (): Database.Database => {
    if (!state.database) throw new Error('Test database is not ready')
    return state.database
  }
}))

import {
  deleteRepositoryProfile,
  getActiveRepositoryProfile,
  getCurrentRepositoryProfileId,
  getSetting,
  listPullRequests,
  listRepositoryProfiles,
  markAllPullRequestsInactive,
  saveRepositoryProfile,
  selectRepositoryProfile,
  withPullRequestProfile
} from '../../../src/main/db/repo'

function profile(
  nickname: string,
  adoRepo: string,
  adoProject = 'DillonWay'
): RepositoryProfileInput {
  return { nickname, adoOrg: 'contoso', adoProject, adoRepo }
}

describe('repository profile persistence', () => {
  let database: Database.Database

  beforeEach(() => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    state.database = database
    runMigrations(database)
  })

  afterEach(() => {
    database.close()
    state.database = null
  })

  it('normalizes the first profile and projects it into the active settings', () => {
    const saved = saveRepositoryProfile(null, {
      nickname: '  Web  ',
      adoOrg: ' contoso ',
      adoProject: ' DillonWay ',
      adoRepo: ' web-app '
    })

    expect(saved).toMatchObject(profile('Web', 'web-app'))
    expect(listRepositoryProfiles()).toEqual([saved])
    expect(getActiveRepositoryProfile()).toEqual(saved)
    expect(getSetting('activeRepositoryProfileId')).toBe(saved.id)
    expect(getSetting('adoOrg')).toBe('contoso')
    expect(getSetting('adoProject')).toBe('DillonWay')
    expect(getSetting('adoRepo')).toBe('web-app')
  })

  it('enforces unique nicknames and repository locations case-insensitively', () => {
    saveRepositoryProfile(null, profile('Web', 'web-app'))

    expect(() => saveRepositoryProfile(null, profile('web', 'api'))).toThrow(
      'A repository profile named "web" already exists.'
    )
    expect(() => saveRepositoryProfile(null, profile('Another', 'WEB-APP'))).toThrow(
      'That Azure DevOps repository already has a profile.'
    )
  })

  it('switches profiles atomically and isolates cached pull requests', () => {
    const web = saveRepositoryProfile(null, profile('Web', 'web-app'))
    const api = saveRepositoryProfile(null, profile('API', 'api'))
    const insertPr = database.prepare(
      `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
       VALUES (?, ?, ?, 'Reviewer', 'active', ?)`
    )
    insertPr.run(42, web.id, 'Web change', 'https://example.test/web/42')
    insertPr.run(42, api.id, 'API change', 'https://example.test/api/42')

    selectRepositoryProfile(web.id)
    expect(getSetting('adoRepo')).toBe('web-app')
    expect(listPullRequests().map((pullRequest) => pullRequest.title)).toEqual(['Web change'])

    markAllPullRequestsInactive()
    expect(listPullRequests()).toEqual([])
    expect(
      database.prepare('SELECT active FROM pull_requests WHERE repo = ?').pluck().get(api.id)
    ).toBe(1)

    selectRepositoryProfile(api.id)
    expect(getSetting('adoRepo')).toBe('api')
    expect(listPullRequests().map((pullRequest) => pullRequest.title)).toEqual(['API change'])
  })

  it('keeps in-flight pull request work scoped to its original profile', async () => {
    const web = saveRepositoryProfile(null, profile('Web', 'web-app'))
    const api = saveRepositoryProfile(null, profile('API', 'api'))
    const prId = Number(
      database
        .prepare(
          `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
           VALUES (42, ?, 'Web change', 'Reviewer', 'active', 'https://example.test/web/42')`
        )
        .run(web.id).lastInsertRowid
    )

    selectRepositoryProfile(web.id)
    const observed = await withPullRequestProfile(prId, async () => {
      selectRepositoryProfile(api.id)
      await Promise.resolve()
      return {
        profileId: getCurrentRepositoryProfileId(),
        adoRepo: getSetting('adoRepo')
      }
    })

    expect(observed).toEqual({ profileId: web.id, adoRepo: 'web-app' })
    expect(getCurrentRepositoryProfileId()).toBe(api.id)
    expect(getSetting('adoRepo')).toBe('api')
  })

  it('archives a deleted profile, selects a fallback, and restores its history when re-added', () => {
    const web = saveRepositoryProfile(null, profile('Web', 'web-app'))
    const api = saveRepositoryProfile(null, profile('API', 'api'))
    database
      .prepare(
        `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
         VALUES (42, ?, 'Web change', 'Reviewer', 'active', 'https://example.test/web/42')`
      )
      .run(web.id)

    deleteRepositoryProfile(web.id)

    expect(listRepositoryProfiles()).toEqual([api])
    expect(getActiveRepositoryProfile()).toEqual(api)
    expect(getSetting('adoRepo')).toBe('api')

    const restored = saveRepositoryProfile(null, profile('Website', 'web-app'))
    expect(restored.id).toBe(web.id)
    selectRepositoryProfile(restored.id)
    expect(listPullRequests().map((pullRequest) => pullRequest.title)).toEqual(['Web change'])
  })

  it('clears active repository settings when the last profile is deleted', () => {
    const web = saveRepositoryProfile(null, profile('Web', 'web-app'))

    deleteRepositoryProfile(web.id)

    expect(getActiveRepositoryProfile()).toBeNull()
    expect(getSetting('activeRepositoryProfileId')).toBe('')
    expect(getSetting('adoOrg')).toBe('')
    expect(getSetting('adoProject')).toBe('')
    expect(getSetting('adoRepo')).toBe('')
  })

  it('allows nickname edits but protects stored history from repository reassignment', () => {
    const web = saveRepositoryProfile(null, profile('Web', 'web-app'))
    const renamed = saveRepositoryProfile(web.id, profile('Website', 'web-app'))
    expect(renamed.nickname).toBe('Website')

    database
      .prepare(
        `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
         VALUES (42, ?, 'Web change', 'Reviewer', 'active', 'https://example.test/web/42')`
      )
      .run(web.id)

    expect(() => saveRepositoryProfile(web.id, profile('Website', 'other-repo'))).toThrow(
      'Repository details cannot be changed after pull requests have been stored.'
    )
  })
})
