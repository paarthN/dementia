/// <reference types="vite/client" />

import type { createCompanionApi } from '../shared/preloadApi'

type CompanionApi = ReturnType<typeof createCompanionApi>

declare global {
  interface Window {
    companion: CompanionApi
  }
}
