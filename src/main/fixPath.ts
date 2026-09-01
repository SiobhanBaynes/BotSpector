import { execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'

/**
 * A GUI app launched from Finder/Dock inherits a minimal PATH (roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`) that omits Node version managers (nvm, fnm,
 * Volta) and Homebrew. That makes spawning `npx` fail with `spawn npx ENOENT`.
 *
 * Ask the user's login+interactive shell for its real PATH (so nvm/fnm init in
 * ~/.zshrc is applied) and merge it into process.env.PATH. Runs once at startup.
 */

// The absolute path to npx, resolved once at startup for the packaged app.
let resolvedNpx: string | null = null

/**
 * The command to spawn for `npx`. Prefers an absolute path resolved at startup
 * (robust against lazy-loaded nvm and a stripped PATH); otherwise falls back to
 * the bare command, which works in dev where the terminal PATH is intact.
 */
export function getNpxCommand(): string {
  if (resolvedNpx) return resolvedNpx
  return process.platform === 'win32' ? 'npx.cmd' : 'npx'
}

export function fixEnvPath(): void {
  if (process.platform === 'win32') return

  const marker = '__BOTSPECTOR_PATH__'
  const shell = process.env.SHELL || '/bin/zsh'
  let shellPath = ''
  try {
    const out = execFileSync(shell, ['-ilc', `echo ${marker}; echo -n "$PATH"; echo ${marker}`], {
      encoding: 'utf8',
      timeout: 5000
    })
    const between = out.split(marker)[1]
    if (between) shellPath = between.trim()
  } catch {
    // Best effort — fall back to the common locations below.
  }

  const common = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const parts = [shellPath, process.env.PATH ?? '', ...common]
    .join(delimiter)
    .split(delimiter)
    .filter(Boolean)
  process.env.PATH = Array.from(new Set(parts)).join(delimiter)

  resolvedNpx = resolveNpx(shell)
  // Ensure npx's own directory (which also holds `node`) is on PATH, otherwise
  // the spawned npx may fail to locate the node binary it needs.
  if (resolvedNpx) {
    const binDir = dirname(resolvedNpx)
    if (!process.env.PATH.split(delimiter).includes(binDir)) {
      process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`
    }
  }
}

/**
 * Resolve npx to an absolute path so spawning doesn't depend on PATH quirks
 * (e.g. lazy-loaded nvm) at spawn time. Asks the login shell for `command -v
 * npx` first, then falls back to scanning the merged PATH.
 */
function resolveNpx(shell: string): string | null {
  const marker = '__BOTSPECTOR_NPX__'
  try {
    const out = execFileSync(
      shell,
      ['-ilc', `echo ${marker}; command -v npx || true; echo ${marker}`],
      { encoding: 'utf8', timeout: 5000 }
    )
    const found = out.split(marker)[1]?.trim()
    if (found && existsSync(found)) return found
  } catch {
    // Fall through to a manual PATH scan.
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, 'npx')
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore
    }
  }
  // Last resort: look directly in nvm's installed node versions, since a slow or
  // failed shell probe can leave the nvm bin off PATH entirely.
  const nvmNodes = join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = readdirSync(nvmNodes)
      .filter((v) => v.startsWith('v'))
      .sort()
      .reverse() // newest version first
    for (const v of versions) {
      const candidate = join(nvmNodes, v, 'bin', 'npx')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // nvm not installed — nothing more to try.
  }
  return null
}
