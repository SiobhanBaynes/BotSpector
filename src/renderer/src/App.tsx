import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../../shared/types'
import { PrList } from './views/PrList'
import { ReviewDetail } from './views/ReviewDetail'
import { SettingsView } from './views/Settings'

type Tab = 'prs' | 'settings'

export function App(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [tab, setTab] = useState<Tab>('prs')
  const [selectedPrId, setSelectedPrId] = useState<number | null>(null)

  const refreshSettings = useCallback(async () => {
    const res = await window.api.getSettings()
    if (res.ok) setSettings(res.data)
  }, [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  const configured = !!settings && settings.copilotConnected && settings.hasAdoPat && !!settings.adoRepo

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🕵️ BotSpector
          <div className="tagline">your slightly nosy PR sidekick</div>
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
          <StatusDot label="Azure DevOps PAT" on={!!settings?.hasAdoPat} />
          <div className="status-model">{settings?.model || 'No model selected'}</div>
        </div>
      </aside>

      <main className="content">
        {tab === 'settings' && (
          <SettingsView settings={settings} onChange={refreshSettings} />
        )}
        {tab === 'prs' && !configured && (
          <div className="empty">
            <h2>Let’s get BotSpector snooping 🔍</h2>
            <p>
              First, sign in to GitHub Copilot, add your Azure DevOps PAT and repository, and pick a
              model in <button className="link" onClick={() => setTab('settings')}>Settings</button>.
              Then I’ll start poking around your PRs.
            </p>
          </div>
        )}
        {tab === 'prs' && configured && selectedPrId === null && (
          <PrList myIdentity={settings?.myIdentity ?? ''} onOpen={setSelectedPrId} />
        )}
        {tab === 'prs' && configured && selectedPrId !== null && (
          <ReviewDetail prId={selectedPrId} onBack={() => setSelectedPrId(null)} />
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
