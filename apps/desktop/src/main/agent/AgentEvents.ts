import type { BrowserAutomationPort } from './ports/BrowserAutomationPort'
import type { DesktopAutomationPort } from './ports/DesktopAutomationPort'
import {
  sameTargetIdentity,
  type HeldApproval,
  type TargetIdentity
} from './security/ActionApproval'

const liveTools = new Set([
  'ui.press',
  'desktop.clickElement',
  'desktop.setText',
  'browser.click',
  'browser.fill'
])

export async function readLiveTarget(
  approval: HeldApproval,
  ports: {
    desktop?: DesktopAutomationPort | null
    browser?: BrowserAutomationPort | null
  }
): Promise<TargetIdentity | null> {
  if (!liveTools.has(approval.tool)) {
    if (approval.target.name) {
      return approval.target
    }
    return approval.target.windowId ? approval.target : null
  }
  try {
    if (approval.tool.startsWith('browser.')) {
      const outcome = await ports.browser?.observe({ includeImage: false })
      const observation = outcome?.observation
      if (!observation) {
        return null
      }
      let targetId = ''
      try {
        const payload = JSON.parse(approval.payloadJson) as Record<string, unknown>
        targetId = typeof payload.targetId === 'string' ? payload.targetId : ''
      } catch {
        targetId = ''
      }
      const byId = observation.targets.find((item) => item.id === targetId)
      if (
        byId &&
        (!approval.target.name ||
          sameTargetIdentity(approval.target, {
            name: byId.name,
            role: byId.role,
            appName: approval.target.appName || 'Agent Browser',
            windowId: approval.target.windowId,
            observationId: approval.target.observationId
          }))
      ) {
        return {
          name: byId.name,
          role: byId.role,
          appName: approval.target.appName || 'Agent Browser',
          windowId: approval.target.windowId,
          observationId: observation.snapshotId
        }
      }
      return oneMatch(
        approval.target,
        observation.targets.map((item) => ({
          name: item.name,
          role: item.role,
          appName: approval.target.appName || 'Agent Browser',
          windowId: approval.target.windowId,
          observationId: observation.snapshotId
        }))
      )
    }
    const windowId = approval.target.windowId || undefined
    const outcome = await ports.desktop?.observe({
      includeImage: false,
      ...(windowId ? { windowId } : {})
    })
    const observation = outcome?.observation
    if (!observation) {
      return null
    }
    return oneMatch(
      approval.target,
      observation.targets.map((item) => ({
        name: item.name,
        role: item.role,
        appName: observation.app.name,
        windowId: observation.window.id,
        observationId: observation.snapshotId
      }))
    )
  } catch {
    return null
  }
}

function oneMatch(approved: TargetIdentity, seen: TargetIdentity[]): TargetIdentity | null {
  const matches = seen.filter((item) => sameTargetIdentity(approved, item))
  return matches.length === 1 ? matches[0] : null
}
