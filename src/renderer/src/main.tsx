import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { applyTheme, getStoredTheme } from './theme'

// Apply the persisted theme before React mounts to avoid a flash of the wrong theme.
applyTheme(getStoredTheme())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
