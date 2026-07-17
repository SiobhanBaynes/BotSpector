import { execFileSync } from 'child_process'
import { delimiter } from 'path'

/**
 * A GUI app launched from Finder/Dock inherits a minimal PATH (roughly
 * `/usr/bin:/bin:/usr/sbin:/sbin`) that omits Node version managers (nvm, fnm,
 * Volta) and Homebrew. That makes spawning `npx` fail with `spawn npx ENOENT`.
 *
 * Ask the user's login+interactive shell for its real PATH (so nvm/fnm init in
 * ~/.zshrc is applied) and merge it into process.env.PATH. Runs once at startup.
 */
export function fixEnvPath(): void {
  if (process.platform === 'win32') return

  const marker = '__BOTSPECTOR_PATH__'
  const shell = process.env.SHELL || '/bin/zsh'
  let shellPath = ''
  try {
    const out = execFileSync(
      shell,
      ['-ilc', `echo ${marker}; echo -n "$PATH"; echo ${marker}`],
      { encoding: 'utf8', timeout: 5000 }
    )
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
}
