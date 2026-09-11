export interface BuildInfo {
  version: string
  buildNumber: string
  buildId: string | null
  commit: string
  dirty: boolean
  builtAt: string
}

export const BUILD_INFO: Readonly<BuildInfo> = Object.freeze(__BOTSPECTOR_BUILD_INFO__)

export function compactBuildLabel(info: BuildInfo): string {
  const commitReference = info.commit === 'unknown' ? info.commit : info.commit.slice(0, 8)
  const localCommit = `${commitReference}${info.dirty ? '*' : ''}`
  const buildReference = info.buildId ? `#${info.buildId}` : localCommit
  return `v${info.version} · ${buildReference}`
}

export function buildInfoTitle(info: BuildInfo): string {
  const build = info.buildId ? `${info.buildNumber} (#${info.buildId})` : info.buildNumber
  const commit = `${info.commit}${info.dirty ? ' (dirty working tree)' : ''}`
  return `Version ${info.version}\nBuild ${build}\nCommit ${commit}\nBuilt ${info.builtAt}`
}

export function formatBuildTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime())
    ? timestamp
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
}
