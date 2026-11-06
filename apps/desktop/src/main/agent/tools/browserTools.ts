import type { RiskLevel, ToolResult } from '../../../shared/agent'
import type { BrowserAutomationPort, BrowserOutcome } from '../ports/BrowserAutomationPort'

interface BrowserContext {
  signal: AbortSignal
  browser?: BrowserAutomationPort
}

export function browserToolDefinitions(): Array<{
  name: string
  risk: RiskLevel
  execute: (input: Record<string, unknown>, context: BrowserContext) => Promise<ToolResult>
}> {
  return [
    {
      name: 'browser.launch',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (browser) => browser.launch(input, { signal: context.signal }))
      }
    },
    {
      name: 'browser.open',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.open(
            { url: typeof input.url === 'string' ? input.url : '' },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'browser.observe',
      risk: 'R0',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.observe(
            { includeImage: input.includeImage === true, consent: input.consent === true },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'browser.back',
      risk: 'R1',
      async execute(_input, context) {
        return run(context, (browser) => browser.back({ signal: context.signal }))
      }
    },
    {
      name: 'browser.listTabs',
      risk: 'R0',
      async execute(_input, context) {
        return run(context, (browser) => browser.listTabs({ signal: context.signal }))
      }
    },
    {
      name: 'browser.selectTab',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.selectTab(
            { index: typeof input.index === 'number' ? input.index : -1 },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'browser.scroll',
      risk: 'R1',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.scroll(
            {
              direction: typeof input.direction === 'string' ? input.direction : '',
              amount: typeof input.amount === 'number' ? input.amount : 0
            },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'browser.close',
      risk: 'R1',
      async execute(_input, context) {
        return run(context, (browser) => browser.close())
      }
    },
    {
      name: 'browser.click',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.click(elementInput(input), { signal: context.signal })
        )
      }
    },
    {
      name: 'browser.fill',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.fill(
            {
              ...elementInput(input),
              text: typeof input.text === 'string' ? input.text : ''
            },
            { signal: context.signal }
          )
        )
      }
    },
    {
      name: 'browser.press',
      risk: 'R2',
      async execute(input, context) {
        return run(context, (browser) =>
          browser.press(
            { chord: typeof input.chord === 'string' ? input.chord : '' },
            { signal: context.signal }
          )
        )
      }
    }
  ]
}

function elementInput(input: Record<string, unknown>): { snapshotId: string; targetId: string } {
  return {
    snapshotId: typeof input.snapshotId === 'string' ? input.snapshotId : '',
    targetId: typeof input.targetId === 'string' ? input.targetId : ''
  }
}

async function run(
  context: BrowserContext,
  body: (browser: BrowserAutomationPort) => Promise<BrowserOutcome>
): Promise<ToolResult> {
  if (!context.browser) {
    return {
      status: 'unsupported',
      summary: "Agent Browser isn't available yet.",
      errorCode: 'unavailable',
      verification: { method: 'none', passed: false }
    }
  }
  return toToolResult(await body(context.browser))
}

function toToolResult(outcome: BrowserOutcome): ToolResult {
  const data = {
    actionOutcome: outcome.status,
    ...(outcome.observation
      ? {
          snapshotId: outcome.observation.snapshotId,
          url: outcome.observation.url,
          title: outcome.observation.title,
          imageIncluded: outcome.observation.imageIncluded,
          agentMarked: outcome.observation.agentMarked
        }
      : {}),
    ...(outcome.tabs ? { tabCount: outcome.tabs.length } : {})
  }
  if (outcome.status === 'success_verified') {
    return {
      status: 'succeeded',
      summary: outcome.summary,
      data,
      verification: { method: 'local_state', passed: true }
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
      verification: { method: 'none', passed: false }
    }
  }
  return {
    status: 'failed',
    summary: outcome.summary,
    data,
    errorCode: outcome.errorCode ?? outcome.status,
    verification: { method: 'local_state', passed: false }
  }
}
