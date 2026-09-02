import { useEffect, useState } from 'react'
import type {
  CopilotModel,
  DeviceCodeInfo,
  RepositoryProfileSummary,
  Settings,
  Skill
} from '../../../shared/types'
import type { ThemePref } from '../theme'

interface Props {
  settings: Settings | null
  onChange: () => Promise<void> | void
  theme: ThemePref
  onThemeChange: (pref: ThemePref) => void
}

export function SettingsView({ settings, onChange, theme, onThemeChange }: Props): JSX.Element {
  const [repositoryProfileId, setRepositoryProfileId] = useState<string | null>(null)
  const [repositoryEditorMode, setRepositoryEditorMode] = useState<'add' | 'edit' | null>(null)
  const [repositoryNickname, setRepositoryNickname] = useState('')
  const [adoOrg, setAdoOrg] = useState('')
  const [adoProject, setAdoProject] = useState('')
  const [adoRepo, setAdoRepo] = useState('')
  const [pat, setPat] = useState('')
  const [model, setModel] = useState('')
  const [myIdentity, setMyIdentity] = useState('')
  const [models, setModels] = useState<CopilotModel[]>([])
  const [device, setDevice] = useState<DeviceCodeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState<string>('general')
  const [gitSpec, setGitSpec] = useState('')
  const [instructions, setInstructions] = useState('')
  const [defaultInstructions, setDefaultInstructions] = useState('')
  const [instructionsUsingDefault, setInstructionsUsingDefault] = useState(true)

  useEffect(() => {
    if (!settings) return
    setModel(settings.model)
    setMyIdentity(settings.myIdentity)
  }, [settings])

  useEffect(() => {
    const unsub = window.api.onLoginStatus(async (s) => {
      setDevice(null)
      if (s.status === 'success') {
        setMessage('Signed in to GitHub Copilot.')
        setError(null)
        await onChange()
        await loadModels()
      } else {
        setError(s.error ?? 'Sign-in failed.')
      }
    })
    return unsub
  }, [onChange])

  useEffect(() => {
    if (settings?.copilotConnected) void loadModels()
  }, [settings?.copilotConnected])

  useEffect(() => {
    void loadSkills()
  }, [])

  useEffect(() => {
    void loadInstructions(selectedSkillId)
  }, [selectedSkillId])

  async function loadSkills(): Promise<void> {
    const res = await window.api.listSkills()
    if (res.ok) setSkills(res.data)
  }

  async function loadInstructions(skillId: string): Promise<void> {
    const res = await window.api.getSkillInstructions(skillId)
    if (res.ok) {
      setInstructions(res.data.instructions)
      setDefaultInstructions(res.data.defaultInstructions)
      setInstructionsUsingDefault(res.data.isDefault)
    }
  }

  async function saveInstructions(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.api.saveSkillInstructions(selectedSkillId, instructions)
    setBusy(false)
    if (res.ok) {
      setInstructions(res.data.instructions)
      setInstructionsUsingDefault(res.data.isDefault)
      const skillName = skills.find((s) => s.id === selectedSkillId)?.name ?? 'Skill'
      setMessage(`${skillName} instructions saved.`)
    } else setError(res.error)
  }

  async function resetInstructions(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.api.saveSkillInstructions(selectedSkillId, '')
    setBusy(false)
    if (res.ok) {
      setInstructions(res.data.instructions)
      setInstructionsUsingDefault(res.data.isDefault)
      const skillName = skills.find((s) => s.id === selectedSkillId)?.name ?? 'Skill'
      setMessage(`${skillName} instructions reset to default.`)
    } else setError(res.error)
  }

  async function importSkill(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.api.importSkill()
    setBusy(false)
    if (res.ok) {
      await loadSkills()
      setSelectedSkillId(res.data.id)
      setMessage(`Imported skill “${res.data.name}”. Review its instructions before using it.`)
    } else if (res.error !== 'Import cancelled.') {
      setError(res.error)
    }
  }

  async function importSkillFromGit(): Promise<void> {
    const spec = gitSpec.trim()
    if (!spec) return
    setBusy(true)
    setError(null)
    const res = await window.api.importSkillFromGit(spec)
    setBusy(false)
    if (res.ok) {
      setGitSpec('')
      await loadSkills()
      setSelectedSkillId(res.data.id)
      setMessage(
        `Imported skill “${res.data.name}” from Git. Review its instructions before using it.`
      )
    } else setError(res.error)
  }

  async function openSkillsFolder(): Promise<void> {
    await window.api.openSkillsFolder()
  }

  async function removeSelectedSkill(): Promise<void> {
    const skill = skills.find((s) => s.id === selectedSkillId)
    if (!skill || skill.source !== 'user') return
    setBusy(true)
    setError(null)
    const res = await window.api.removeSkill(selectedSkillId)
    setBusy(false)
    if (res.ok) {
      setSkills(res.data)
      setSelectedSkillId('general')
      setMessage(`Removed skill “${skill.name}”.`)
    } else setError(res.error)
  }

  async function loadModels(): Promise<void> {
    const res = await window.api.copilotListModels()
    if (res.ok) setModels(res.data)
    else setError(res.error)
  }

  function closeRepositoryProfileEditor(): void {
    setRepositoryEditorMode(null)
    setRepositoryProfileId(null)
    setRepositoryNickname('')
    setAdoOrg('')
    setAdoProject('')
    setAdoRepo('')
    setPat('')
  }

  function editRepositoryProfile(profile: RepositoryProfileSummary): void {
    if (repositoryEditorMode === 'edit' && repositoryProfileId === profile.id) {
      closeRepositoryProfileEditor()
      return
    }
    setRepositoryEditorMode('edit')
    setRepositoryProfileId(profile.id)
    setRepositoryNickname(profile.nickname)
    setAdoOrg(profile.adoOrg)
    setAdoProject(profile.adoProject)
    setAdoRepo(profile.adoRepo)
    setPat('')
    setMessage(null)
    setError(null)
  }

  function addRepositoryProfile(): void {
    if (repositoryEditorMode === 'add') {
      closeRepositoryProfileEditor()
      return
    }
    setRepositoryEditorMode('add')
    setRepositoryProfileId(null)
    setRepositoryNickname('')
    setAdoOrg('')
    setAdoProject('')
    setAdoRepo('')
    setPat('')
    setMessage(null)
    setError(null)
  }

  async function saveRepositoryProfile(): Promise<void> {
    const nickname = repositoryNickname.trim()
    setBusy(true)
    setError(null)
    const res = await window.api.saveRepositoryProfile(repositoryProfileId, {
      nickname: repositoryNickname,
      adoOrg,
      adoProject,
      adoRepo,
      ...(pat.trim() ? { pat: pat.trim() } : {})
    })
    setBusy(false)
    if (res.ok) {
      closeRepositoryProfileEditor()
      setMessage(`Repository profile “${nickname}” saved.`)
      await onChange()
    } else setError(res.error)
  }

  async function deleteRepositoryProfile(profile: RepositoryProfileSummary): Promise<void> {
    const confirmed = window.confirm(
      `Remove “${profile.nickname}”? Its stored pull requests and review history will be kept.`
    )
    if (!confirmed) return
    setBusy(true)
    setError(null)
    const res = await window.api.deleteRepositoryProfile(profile.id)
    setBusy(false)
    if (res.ok) {
      if (repositoryProfileId === profile.id) closeRepositoryProfileEditor()
      setMessage(`Removed repository profile “${profile.nickname}”.`)
      await onChange()
    } else setError(res.error)
  }

  async function saveModel(next: string): Promise<void> {
    setModel(next)
    const res = await window.api.saveSettings({ model: next })
    if (res.ok) await onChange()
    else setError(res.error)
  }

  async function saveIdentity(): Promise<void> {
    const res = await window.api.saveSettings({ myIdentity })
    if (res.ok) {
      setMessage('Saved your identity.')
      await onChange()
    } else setError(res.error)
  }

  async function detectIdentity(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.api.detectIdentity()
    setBusy(false)
    if (res.ok) {
      setMyIdentity(res.data)
      setMessage(`Detected: ${res.data}`)
      await onChange()
    } else setError(res.error)
  }

  async function startLogin(): Promise<void> {
    setError(null)
    setMessage(null)
    const res = await window.api.copilotStartLogin()
    if (res.ok) setDevice(res.data)
    else setError(res.error)
  }

  async function signOut(): Promise<void> {
    await window.api.copilotSignOut()
    setModels([])
    await onChange()
  }

  function repositoryProfileEditor(heading: string, editorId: string): JSX.Element {
    const hasStoredPat = settings?.repositoryProfiles.find(
      (profile) => profile.id === repositoryProfileId
    )?.hasAdoPat

    return (
      <div className="repository-profile-editor" id={editorId}>
        <h3>{heading}</h3>
        <div className="repository-profile-editor-fields">
          <label>
            Nickname
            <input
              value={repositoryNickname}
              onChange={(event) => setRepositoryNickname(event.target.value)}
              placeholder="Website"
            />
          </label>
          <label>
            Organization
            <input
              value={adoOrg}
              onChange={(event) => setAdoOrg(event.target.value)}
              placeholder="contoso"
            />
          </label>
          <label>
            Project
            <input
              value={adoProject}
              onChange={(event) => setAdoProject(event.target.value)}
              placeholder="MyProject"
            />
          </label>
          <label>
            Repository
            <input
              value={adoRepo}
              onChange={(event) => setAdoRepo(event.target.value)}
              placeholder="my-repo"
            />
          </label>
          <label className="repository-pat-field">
            Personal Access Token
            <input
              type="password"
              value={pat}
              onChange={(event) => setPat(event.target.value)}
              placeholder={
                repositoryEditorMode === 'edit' && hasStoredPat
                  ? 'Stored securely; enter a new PAT to replace it'
                  : 'Paste PAT (Code: Read; Pull Request: Read)'
              }
            />
          </label>
        </div>
        <p className="muted small">
          The PAT is encrypted and stored only for this repository profile. Leave it blank when
          editing to keep the stored PAT. Repository details become fixed after pull requests are
          stored, keeping review history attached to the right repository.
        </p>
        <div className="row repository-profile-editor-actions">
          <button
            className="btn primary"
            onClick={saveRepositoryProfile}
            disabled={
              busy ||
              !repositoryNickname.trim() ||
              !adoOrg.trim() ||
              !adoProject.trim() ||
              !adoRepo.trim()
            }
          >
            Save repository
          </button>
          <button className="btn" onClick={closeRepositoryProfileEditor} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings">
      <h1>Settings</h1>
      {message && <div className="banner ok">{message}</div>}
      {error && <div className="banner err">{error}</div>}

      <section className="card">
        <h2>Appearance</h2>
        <p className="muted">Choose a light or dark theme, or follow your system setting.</p>
        <div className="row theme-choices">
          {(['system', 'light', 'dark'] as ThemePref[]).map((opt) => (
            <label key={opt} className={theme === opt ? 'theme-choice active' : 'theme-choice'}>
              <input
                type="radio"
                name="theme"
                value={opt}
                checked={theme === opt}
                onChange={() => onThemeChange(opt)}
              />
              <span className="theme-choice-label">
                {opt === 'system' ? 'System' : opt === 'light' ? 'Light' : 'Dark'}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>GitHub Copilot</h2>
        {settings?.copilotConnected ? (
          <p className="row">
            <span className="badge on">Connected</span>
            <button className="btn" onClick={signOut}>
              Sign out
            </button>
          </p>
        ) : device ? (
          <div className="device">
            <p>
              Go to{' '}
              <a href={device.verificationUri} target="_blank" rel="noreferrer">
                {device.verificationUri}
              </a>{' '}
              and enter this code:
            </p>
            <div className="code">{device.userCode}</div>
            <p className="muted">Waiting for authorization…</p>
            <button
              className="btn"
              onClick={async () => {
                await window.api.copilotCancelLogin()
                setDevice(null)
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn primary" onClick={startLogin}>
            Sign in to GitHub Copilot
          </button>
        )}
      </section>

      <section className="card">
        <h2>Model</h2>
        <select
          value={model}
          disabled={!settings?.copilotConnected || models.length === 0}
          onChange={(e) => saveModel(e.target.value)}
        >
          <option value="">Select a model…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.vendor})
            </option>
          ))}
        </select>
        {settings?.copilotConnected && (
          <button className="btn" onClick={loadModels} style={{ marginLeft: 8 }}>
            Refresh
          </button>
        )}
      </section>

      <section className="card">
        <h2>Review skills</h2>
        <p className="muted">
          A skill is a named prompt profile that shapes how the reviewer approaches a PR. Pick a
          skill to edit its instructions — the JSON output format is fixed automatically, so you can
          edit freely.
          {instructionsUsingDefault ? ' Currently using the default.' : ' Customized.'}
        </p>
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={importSkill} disabled={busy}>
            Import skill…
          </button>
          <button className="btn" onClick={openSkillsFolder}>
            Reveal skills folder
          </button>
          <span className="muted small">
            Load an external SKILL.md folder (e.g. an Anthropic-style skill).
          </span>
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <input
            value={gitSpec}
            onChange={(e) => setGitSpec(e.target.value)}
            placeholder="https://github.com/org/repo#ref:path/to/skill"
            style={{ flex: 1 }}
            spellCheck={false}
          />
          <button className="btn" onClick={importSkillFromGit} disabled={busy || !gitSpec.trim()}>
            Import from Git
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Git import shallow-clones the repo, copies only its <code>SKILL.md</code>, and deletes the
          clone — nothing from the repo is executed. Use <code>#ref</code> to pin a branch/tag and
          <code>:subdir</code> to pick one skill from a monorepo.
        </p>
        <label>
          Skill
          <select
            value={selectedSkillId}
            onChange={(e) => setSelectedSkillId(e.target.value)}
            disabled={skills.length === 0}
          >
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.source === 'user' ? ' (imported)' : ''}
              </option>
            ))}
          </select>
        </label>
        {(() => {
          const active = skills.find((s) => s.id === selectedSkillId)
          if (!active) return null
          return (
            <>
              <p className="muted small">{active.description}</p>
              {active.source === 'user' && (
                <p className="muted small">
                  Imported skill{active.version ? ` · v${active.version}` : ''}. Its instructions
                  are untrusted content and always run inside BotSpector’s read-only review
                  guardrails.
                </p>
              )}
            </>
          )
        })()}
        <textarea
          className="instructions"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={12}
          spellCheck={false}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" onClick={saveInstructions} disabled={busy}>
            Save instructions
          </button>
          <button
            className="btn"
            onClick={resetInstructions}
            disabled={busy || instructions.trim() === defaultInstructions.trim()}
          >
            Reset to default
          </button>
          {skills.find((s) => s.id === selectedSkillId)?.source === 'user' && (
            <button className="btn danger" onClick={removeSelectedSkill} disabled={busy}>
              Remove skill
            </button>
          )}
        </div>
      </section>

      <section className="card">
        <div className="settings-section-heading">
          <div>
            <h2>Azure DevOps repositories</h2>
            <p className="muted">
              Name repositories so you can switch between them from the sidebar.
            </p>
          </div>
          <button
            className="btn"
            onClick={addRepositoryProfile}
            disabled={busy}
            aria-expanded={repositoryEditorMode === 'add'}
            aria-controls="new-repository-profile-editor"
          >
            {repositoryEditorMode === 'add' ? 'Cancel' : 'Add repository'}
          </button>
        </div>
        {settings?.repositoryProfiles.length ? (
          <div className="repository-profile-list">
            {settings.repositoryProfiles.map((profile) => {
              const isExpanded =
                repositoryEditorMode === 'edit' && repositoryProfileId === profile.id
              const className = [
                'repository-profile-item',
                profile.id === settings.activeRepositoryProfileId ? 'active' : '',
                isExpanded ? 'expanded' : ''
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <div className={className} key={profile.id}>
                  <div className="repository-profile-row">
                    <div className="repository-profile-details">
                      <strong>{profile.nickname}</strong>
                      <span>
                        {profile.adoOrg} / {profile.adoProject} / {profile.adoRepo}
                      </span>
                    </div>
                    <div className="repository-profile-actions">
                      <span className={profile.hasAdoPat ? 'badge on' : 'badge'}>
                        {profile.hasAdoPat ? 'PAT saved' : 'PAT missing'}
                      </span>
                      {profile.id === settings.activeRepositoryProfileId && (
                        <span className="badge on">Active</span>
                      )}
                      <button
                        className="btn subtle"
                        onClick={() => editRepositoryProfile(profile)}
                        disabled={busy}
                        aria-expanded={isExpanded}
                        aria-controls={`repository-profile-editor-${profile.id}`}
                      >
                        {isExpanded ? 'Close' : 'Edit'}
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => void deleteRepositoryProfile(profile)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  {isExpanded &&
                    repositoryProfileEditor(
                      `Edit ${profile.nickname}`,
                      `repository-profile-editor-${profile.id}`
                    )}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="muted">No repository profiles yet.</p>
        )}

        {repositoryEditorMode === 'add' &&
          repositoryProfileEditor('Add repository', 'new-repository-profile-editor')}
      </section>

      <section className="card">
        <h2>Your identity</h2>
        <p className="muted">
          Used to mark and filter your own pull requests. Detect it from Azure DevOps or type your
          display name.
        </p>
        <label>
          Your name
          <input
            value={myIdentity}
            onChange={(e) => setMyIdentity(e.target.value)}
            placeholder="e.g. Siobhan B"
          />
        </label>
        <div className="row">
          <button className="btn primary" onClick={saveIdentity} disabled={busy}>
            Save
          </button>
          <button className="btn" onClick={detectIdentity} disabled={busy || !settings?.hasAdoPat}>
            Detect from Azure DevOps
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Diagnostics</h2>
        <p className="muted">Open the log file to see review activity and errors.</p>
        <button className="btn" onClick={() => window.api.openLogs()}>
          Open logs
        </button>
      </section>
    </div>
  )
}
