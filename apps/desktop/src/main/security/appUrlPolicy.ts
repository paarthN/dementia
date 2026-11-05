import { join } from 'path'
import type { AppUrlPolicy } from '../../shared/navigation'

export function appUrlPolicy(): AppUrlPolicy {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  let devOrigin: string | undefined
  if (devServer) {
    try {
      devOrigin = new URL(devServer).origin
    } catch {
      devOrigin = undefined
    }
  }

  return {
    devOrigin,
    rendererDirectory: join(__dirname, '../renderer')
  }
}
