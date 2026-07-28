import { useCallback, useEffect, useState } from 'react'

// Light/dark theme preference. 'system' follows the OS-level colour scheme.
export type ThemePref = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'botspector.theme'
const LIGHT_MQ = '(prefers-color-scheme: light)'

export function getStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // localStorage may be unavailable; fall through to default.
  }
  return 'system'
}

function resolveEffective(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref
  return window.matchMedia(LIGHT_MQ).matches ? 'light' : 'dark'
}

// Apply the effective theme to the document root. Safe to call before React mounts.
export function applyTheme(pref: ThemePref): void {
  document.documentElement.setAttribute('data-theme', resolveEffective(pref))
}

export function useTheme(): {
  theme: ThemePref
  effective: 'light' | 'dark'
  setTheme: (pref: ThemePref) => void
} {
  const [theme, setThemeState] = useState<ThemePref>(() => getStoredTheme())
  const [effective, setEffective] = useState<'light' | 'dark'>(() => resolveEffective(theme))

  useEffect(() => {
    applyTheme(theme)
    setEffective(resolveEffective(theme))
    if (theme !== 'system') return
    const mq = window.matchMedia(LIGHT_MQ)
    const onChange = (): void => {
      applyTheme('system')
      setEffective(resolveEffective('system'))
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((pref: ThemePref) => {
    try {
      localStorage.setItem(STORAGE_KEY, pref)
    } catch {
      // ignore write failures
    }
    setThemeState(pref)
  }, [])

  return { theme, effective, setTheme }
}
