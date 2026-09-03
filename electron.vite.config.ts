import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

interface EmbeddedBuildInfo {
  version: string
  buildNumber: string
  buildId: string | null
  commit: string
  dirty: boolean
  builtAt: string
}

function readGitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}

function readGitDirty(): boolean {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim().length > 0
    )
  } catch {
    return false
  }
}

function readBuildInfo(): EmbeddedBuildInfo {
  const packageJson = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as {
    version?: string
  }
  if (!packageJson.version) throw new Error('package.json does not define a version')

  const builtAt = process.env.BOTSPECTOR_BUILD_TIMESTAMP || new Date().toISOString()
  const localTimestamp = builtAt.replace(/\D/g, '').slice(0, 14)
  return {
    version: packageJson.version,
    buildNumber:
      process.env.BOTSPECTOR_BUILD_NUMBER ||
      process.env.BUILD_BUILDNUMBER ||
      `local-${localTimestamp}`,
    buildId: process.env.BUILD_BUILDID || null,
    commit:
      process.env.BOTSPECTOR_SOURCE_COMMIT ||
      process.env.SYSTEM_PULLREQUEST_SOURCECOMMITID ||
      process.env.BUILD_SOURCEVERSION ||
      readGitCommit(),
    dirty: readGitDirty(),
    builtAt
  }
}

const buildInfo = readBuildInfo()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    define: {
      __BOTSPECTOR_BUILD_INFO__: JSON.stringify(buildInfo)
    },
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    plugins: [react()]
  }
})
