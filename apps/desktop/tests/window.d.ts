import type { createCompanionApi } from '../src/shared/preloadApi'

type CompanionApi = ReturnType<typeof createCompanionApi>

declare global {
  interface Window {
    companion: CompanionApi
  }
}

export {}
