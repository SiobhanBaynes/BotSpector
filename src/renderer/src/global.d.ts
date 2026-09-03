import type { PreloadApi } from '../../preload/index'
import type { BuildInfo } from './buildInfo'

declare global {
  const __BOTSPECTOR_BUILD_INFO__: BuildInfo

  interface Window {
    api: PreloadApi
  }
}

export {}
