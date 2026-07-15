import { secrets } from '../secrets'
import type { DeviceCodeInfo } from '../../shared/types'

/**
 * GitHub Copilot authentication.
 *
 * Flow:
 *   1. GitHub OAuth device flow (using the public editor client id) to obtain a
 *      long-lived GitHub OAuth token.
 *   2. Exchange that token at copilot_internal/v2/token for a short-lived Copilot
 *      bearer token, refreshed automatically before it expires.
 *
 * Note: this uses GitHub's editor Copilot endpoints, which are undocumented.
 * Keep usage user-initiated (per-PR) to stay within normal Copilot use.
 */

// Public client id used by GitHub's own editor integrations for Copilot.
const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

const EDITOR_VERSION = 'BotSpector/0.1.0'
const USER_AGENT = 'BotSpector/0.1.0'

interface CopilotToken {
  token: string
  expiresAt: number // epoch seconds
}

let cachedCopilotToken: CopilotToken | null = null
let activeDeviceCode: string | null = null
let cancelRequested = false

function jsonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'Editor-Version': EDITOR_VERSION
  }
}

/** Begin the device-flow login. Returns the code/URL the user must enter. */
export async function startDeviceLogin(): Promise<DeviceCodeInfo> {
  cancelRequested = false
  const res = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' })
  })
  if (!res.ok) {
    throw new Error(`Device code request failed (${res.status})`)
  }
  const data = (await res.json()) as {
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
  }
  activeDeviceCode = data.device_code
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
    interval: data.interval
  }
}

export function cancelDeviceLogin(): void {
  cancelRequested = true
  activeDeviceCode = null
}

/**
 * Poll GitHub until the user authorizes the device. Resolves once a GitHub
 * OAuth token is obtained and stored. Throws on timeout/denial/cancel.
 */
export async function pollForToken(intervalSeconds: number): Promise<void> {
  if (!activeDeviceCode) throw new Error('No active device login')
  let interval = Math.max(intervalSeconds, 1) * 1000

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (cancelRequested) throw new Error('Login cancelled')
    await sleep(interval)
    if (cancelRequested) throw new Error('Login cancelled')

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: activeDeviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    })
    const data = (await res.json()) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (data.access_token) {
      secrets.setGithubToken(data.access_token)
      cachedCopilotToken = null
      activeDeviceCode = null
      // Validate we can actually mint a Copilot token.
      await getCopilotToken()
      return
    }

    switch (data.error) {
      case 'authorization_pending':
        break
      case 'slow_down':
        interval += 5000
        break
      case 'expired_token':
        throw new Error('The device code expired. Please try signing in again.')
      case 'access_denied':
        throw new Error('Access was denied.')
      default:
        if (data.error) throw new Error(`Login failed: ${data.error}`)
    }
  }
}

/** True if we have a stored GitHub token (i.e. the user has signed in). */
export function isSignedIn(): boolean {
  return !!secrets.getGithubToken()
}

export function signOut(): void {
  secrets.setGithubToken(null)
  cachedCopilotToken = null
}

/**
 * Return a valid Copilot bearer token, refreshing from the stored GitHub token
 * when needed.
 */
export async function getCopilotToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cachedCopilotToken && cachedCopilotToken.expiresAt - 60 > now) {
    return cachedCopilotToken.token
  }
  const githubToken = secrets.getGithubToken()
  if (!githubToken) throw new Error('Not signed in to GitHub Copilot')

  const res = await fetch(COPILOT_TOKEN_URL, {
    method: 'GET',
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      'Editor-Version': EDITOR_VERSION
    }
  })
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('GitHub Copilot access denied. Check your Copilot subscription.')
    }
    throw new Error(`Failed to get Copilot token (${res.status})`)
  }
  const data = (await res.json()) as { token: string; expires_at: number }
  cachedCopilotToken = { token: data.token, expiresAt: data.expires_at }
  return data.token
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
