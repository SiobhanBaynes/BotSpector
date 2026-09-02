import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../../shared/types'
import { PrList } from './views/PrList'
import { ReviewDetail } from './views/ReviewDetail'
import { SettingsView } from './views/Settings'
import { useTheme } from './theme'

type Tab = 'prs' | 'settings'

export function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('prs')
  const [selectedPrId, setSelectedPrId] = useState<number | null>(null)
  const [switchingRepository, setSwitchingRepository] = useState(false)
  const [repositoryError, setRepositoryError] = useState<string | null>(null)
  const { theme, setTheme } = useTheme()

  const refreshSettings = useCallback(async () => {
    const res = await window.api.getSettings()
    if (res.ok) setSettings(res.data)
  }, [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  const selectRepository = async (profileId: string): Promise<void> => {
    if (!profileId || profileId === settings?.activeRepositoryProfileId) return
    setSwitchingRepository(true)
    setRepositoryError(null)
    const res = await window.api.selectRepositoryProfile(profileId)
    setSwitchingRepository(false)
    if (res.ok) {
      setSettings(res.data)
      setSelectedPrId(null)
    } else {
      setRepositoryError(res.error)
    }
  }

  const configured =
    !!settings &&
    settings.copilotConnected &&
    settings.hasAdoPat &&
    !!settings.activeRepositoryProfileId

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🕵️ BotSpector
          <div className="tagline">your slightly nosy PR sidekick</div>
        </div>
        <div className="repository-switcher">
          <label htmlFor="active-repository">Repository</label>
          <select
            id="active-repository"
            value={settings?.activeRepositoryProfileId ?? ''}
            disabled={switchingRepository || !settings?.repositoryProfiles.length}
            onChange={(event) => void selectRepository(event.target.value)}
          >
            {!settings?.repositoryProfiles.length && <option value="">No repositories</option>}
            {settings?.repositoryProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.nickname}
              </option>
            ))}
          </select>
          {repositoryError && <span className="repository-switcher-error">{repositoryError}</span>}
        </div>
        <nav>
          <button
            className={tab === 'prs' ? 'nav active' : 'nav'}
            onClick={() => {
              setTab('prs')
              setSelectedPrId(null)
            }}
          >
            Pull requests
          </button>
          <button
            className={tab === 'settings' ? 'nav active' : 'nav'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
        <div className="status">
          <StatusDot label="Copilot" on={!!settings?.copilotConnected} />
          <StatusDot label="Repository PAT" on={!!settings?.hasAdoPat} />
          <div className="status-model">{settings?.model || 'No model selected'}</div>
        </div>
      </aside>

      <main className="content">
        {tab === 'settings' && (
          <SettingsView
            settings={settings}
            onChange={refreshSettings}
            theme={theme}
            onThemeChange={setTheme}
          />
        )}
        {tab === 'prs' && !configured && (
          <div className="empty">
            <h2>Let’s get BotSpector snooping 🔍</h2>
            <p>
              First, sign in to GitHub Copilot, add a repository profile with its Azure DevOps PAT,
              and pick a model in{' '}
              <button className="link" onClick={() => setTab('settings')}>
                Settings
              </button>
              . Then I’ll start poking around your PRs.
            </p>
          </div>
        )}
        {tab === 'prs' && configured && selectedPrId === null && (
          <PrList
            key={settings.activeRepositoryProfileId}
            myIdentity={settings.myIdentity}
            onOpen={setSelectedPrId}
          />
        )}
        {tab === 'prs' && configured && selectedPrId !== null && (
          <ReviewDetail
            prId={selectedPrId}
            defaultModel={settings?.model ?? ''}
            onBack={() => setSelectedPrId(null)}
          />
        )}
      </main>
    </div>
  )
}

function StatusDot({ label, on }: { label: string; on: boolean }): JSX.Element {
  return (
    <div className="status-row">
      <span className={on ? 'dot on' : 'dot'} />
      {label}
    </div>
  )
}
