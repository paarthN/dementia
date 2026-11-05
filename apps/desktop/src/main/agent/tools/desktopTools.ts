import type { RiskLevel, ToolResult } from '../../../shared/agent'
import { HelperCallError } from '../../services/osBridge'
import type { DesktopAutomationPort, DesktopOutcome } from '../ports/DesktopAutomationPort'

interface DesktopContext {
  signal: AbortSignal
  desktop?: DesktopAutomationPort
}

export function desktopToolDefinitions(): Array<{
  name: string
  risk: RiskLevel
  execute: (input: Record<string, unknown>, context: DesktopContext) => Promise<ToolResult>
}> {
  return [
    {
      name: 'desktop.listWindows',
      risk: 'R0',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.listWindows(
            { bundleId: typeof input.bundleId === 'string' ? input.bundleId : undefined },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'desktop.observe',
      risk: 'R0',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.observe(
            {
              ...(typeof input.windowId === 'string' ? { windowId: input.windowId } : {}),
              includeImage: input.includeImage === true
            },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'desktop.focusWindow',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.focusWindow(
            {
              windowId: typeof input.windowId === 'string' ? input.windowId : '',
              bundleId: typeof input.bundleId === 'string' ? input.bundleId : ''
            },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'desktop.scroll',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.scroll(
            {
              direction: typeof input.direction === 'string' ? input.direction : '',
              amount: typeof input.amount === 'number' ? input.amount : 0,
              windowId: typeof input.windowId === 'string' ? input.windowId : '',
              bundleId: typeof input.bundleId === 'string' ? input.bundleId : '',
              processId: typeof input.processId === 'number' ? input.processId : 0
            },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'desktop.clickElement',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.clickElement(elementInput(input), { signal: context.signal })
        )
      }
    },
    {
      name: 'desktop.setText',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.setText(
            { ...elementInput(input), text: typeof input.text === 'string' ? input.text : '' },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'desktop.keyPress',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (desktop) =>
          desktop.keyPress(
            {
              chord: typeof input.chord === 'string' ? input.chord : '',
              windowId: typeof input.windowId === 'string' ? input.windowId : '',
              bundleId: typeof input.bundleId === 'string' ? input.bundleId : '',
              processId: typeof input.processId === 'number' ? input.processId : 0
            },
            { signal: context.signal }
          )
        )
      }
    }
  ]
}

function elementInput(input: Record<string, unknown>): {
  snapshotId: string
  targetId: string
  windowId: string
  bundleId: string
  name: string
  role: string
} {
  return {
    snapshotId: typeof input.snapshotId === 'string' ? input.snapshotId : '',
    targetId: typeof input.targetId === 'string' ? input.targetId : '',
    windowId: typeof input.windowId === 'string' ? input.windowId : '',
    bundleId: typeof input.bundleId === 'string' ? input.bundleId : '',
    name: typeof input.name === 'string' ? input.name : '',
    role: typeof input.role === 'string' ? input.role : ''
  }
}

async function run(
  context: DesktopContext,
  body: (desktop: DesktopAutomationPort) => Promise<DesktopOutcome>
): Promise<ToolResult> {
  if (!context.desktop) {
    return {
      status: 'unsupported',
      summary: "Controlling other apps this way isn't available yet.",
      errorCode: 'unavailable',
      verification: { method: 'none', passed: false }
    }
  }
  const outcome = await body(context.desktop)
  if (outcome.status === 'uncertain_after_timeout') {
    throw new HelperCallError(
      'aborted',
      'I asked it to stop, but I could not confirm the action finished.',
      true
    )
  }
  return toToolResult(outcome)
}

function toToolResult(outcome: DesktopOutcome): ToolResult {
  const data = {
    actionOutcome: outcome.status,
    ...(outcome.observation
      ? {
          snapshotId: outcome.observation.snapshotId,
          windowId: outcome.observation.window.id,
          appName: outcome.observation.app.name
        }
      : {}),
    ...(outcome.windows ? { windowCount: outcome.windows.length } : {})
  }
  if (outcome.status === 'success_verified') {
    return {
      status: 'succeeded',
      summary: outcome.summary,
      data,
      verification: { method: 'accessibility', passed: true }
    }
  }
  if (outcome.status === 'needs_permission') {
    return {
      status: 'requires_permission',
      summary: outcome.summary,
      errorCode: outcome.errorCode,
      verification: { method: 'none', passed: false }
    }
  }
  if (outcome.status === 'cancelled') {
    return {
      status: 'cancelled',
      summary: outcome.summary,
      verification: { method: 'local_state', passed: true }
    }
  }
  if (outcome.status === 'unsupported') {
    return {
      status: 'unsupported',
      summary: outcome.summary,
      errorCode: outcome.errorCode ?? 'unsupported',
      verification: { method: 'accessibility', passed: false }
    }
  }
  return {
    status: 'failed',
    summary: outcome.summary,
    data,
    errorCode: outcome.errorCode ?? outcome.status,
    verification: { method: 'accessibility', passed: false }
  }
}
