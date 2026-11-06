import { canonicalJson, type RiskLevel } from '../../shared/agent'
import {
  isConsequentialBrowserControl,
  isSensitiveBrowserField
} from '../agent/ports/browserSafety'
import { pressPreview } from '../../shared/controls'
import type { ToolRegistry } from './toolRegistry'

export interface PolicyApproval {
  tool: string
  payloadJson: string
  expiresAtUtc: string
}

export interface PolicyRequest {
  tool: string
  input: Record<string, unknown>
  source: 'user' | 'observed'
  now: Date
  screenPermission: boolean
  claimedRisk?: RiskLevel
  approval?: PolicyApproval | null
}

export type PolicyDecision =
  | { effect: 'allow'; risk: RiskLevel }
  | { effect: 'confirm'; risk: RiskLevel; reason: string }
  | { effect: 'permission'; risk: RiskLevel; reason: string }
  | { effect: 'deny'; risk: RiskLevel; reason: string }

const screenTools = new Set([
  'screen.inspect',
  'screen.captureOnce',
  'guidance.start',
  'guidance.point',
  'ui.press',
  'desktop.observe',
  'desktop.focusWindow',
  'desktop.clickElement',
  'desktop.setText',
  'desktop.keyPress',
  'desktop.scroll'
])

export function decidePolicy(registry: ToolRegistry, request: PolicyRequest): PolicyDecision {
  if (request.source !== 'user') {
    return {
      effect: 'deny',
      risk: 'R4',
      reason: "I won't act on instructions from the page."
    }
  }

  if (registry.isBlocked(request.tool)) {
    return {
      effect: 'deny',
      risk: 'R4',
      reason: "I can't run commands or use an unknown action."
    }
  }

  const risk = registry.riskOf(request.tool)
  if (!risk) {
    return {
      effect: 'deny',
      risk: 'R4',
      reason: "I can't do that."
    }
  }

  if (risk === 'R4') {
    return {
      effect: 'deny',
      risk,
      reason: "I can't do that automatically. I can explain the safe choice instead."
    }
  }

  if (
    (request.tool === 'browser.fill' || request.tool === 'browser.click') &&
    isSensitiveBrowserField({
      name: textField(request.input, 'name'),
      role: textField(request.input, 'role'),
      inputType: textField(request.input, 'inputType'),
      autocomplete: textField(request.input, 'autocomplete')
    })
  ) {
    return {
      effect: 'deny',
      risk: 'R4',
      reason: "I can't type into or press a password or security code."
    }
  }

  if (screenTools.has(request.tool) && !request.screenPermission) {
    return {
      effect: 'permission',
      risk,
      reason:
        "I can't see the screen without permission. You can describe the message, or turn on screen access for this request."
    }
  }

  if (risk === 'R3' && !approvalMatches(request)) {
    return {
      effect: 'deny',
      risk,
      reason: 'That needs approval for this exact action, and there is no matching approval.'
    }
  }

  if (request.tool === 'ui.press' && !approvalMatches(request)) {
    return {
      effect: 'confirm',
      risk,
      reason: pressPreview(request.input)
    }
  }

  if (
    (request.tool === 'desktop.clickElement' ||
      request.tool === 'desktop.setText' ||
      request.tool === 'desktop.keyPress') &&
    !approvalMatches(request)
  ) {
    return {
      effect: 'confirm',
      risk,
      reason: desktopActionPreview(request.tool, request.input)
    }
  }

  if (
    (request.tool === 'browser.click' ||
      request.tool === 'browser.fill' ||
      request.tool === 'browser.press') &&
    !approvalMatches(request)
  ) {
    return {
      effect: 'confirm',
      risk,
      reason: browserActionPreview(request.tool, request.input)
    }
  }

  if (risk === 'R2' && !approvalMatches(request)) {
    return {
      effect: 'confirm',
      risk,
      reason: 'This action needs a preview and your approval.'
    }
  }

  if (
    request.tool === 'browser.openUrl' &&
    request.input.trusted !== true &&
    !approvalMatches(request)
  ) {
    const domain =
      typeof request.input.displayName === 'string' ? request.input.displayName : 'that website'
    return {
      effect: 'confirm',
      risk,
      reason: `This opens ${domain}. Open it only if you recognize the address.`
    }
  }

  if (
    request.tool === 'reminders.create' &&
    request.input.certain !== true &&
    !approvalMatches(request)
  ) {
    const when =
      typeof request.input.localLabel === 'string' ? request.input.localLabel : 'that time'
    const title = typeof request.input.title === 'string' ? request.input.title : 'that'
    return {
      effect: 'confirm',
      risk,
      reason: `I'll remind you ${when} to ${title}. Should I set that?`
    }
  }

  if (
    request.tool === 'reminders.cancel' &&
    request.input.ambiguous === true &&
    !approvalMatches(request)
  ) {
    return {
      effect: 'confirm',
      risk,
      reason: 'More than one reminder matches. I need you to confirm which one to cancel.'
    }
  }

  return { effect: 'allow', risk }
}

function browserActionPreview(tool: string, input: Record<string, unknown>): string {
  const name = controlName(input)
  if (tool === 'browser.fill') {
    return `I am about to type into ${name}. Type it?`
  }
  if (tool === 'browser.press') {
    const chord = textField(input, 'chord').slice(0, 40) || 'a key'
    return `I am about to press the ${chord} key. Press it?`
  }
  if (isConsequentialBrowserControl(name)) {
    return `I am about to press ${name}. This can send or change something. Press it?`
  }
  return `I am about to press ${name}. Press it?`
}

function controlName(input: Record<string, unknown>): string {
  return (
    textField(input, 'name')
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 80) || 'that control'
  )
}

function textField(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === 'string' ? input[key] : ''
}

function desktopActionPreview(tool: string, input: Record<string, unknown>): string {
  const rawName = typeof input.name === 'string' ? input.name : 'that control'
  const name =
    rawName
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 80) || 'that control'
  if (tool === 'desktop.clickElement') {
    return `I am about to press ${name}. Press it?`
  }
  if (tool === 'desktop.setText') {
    return `I am about to type into ${name}. Type it?`
  }
  const chord = typeof input.chord === 'string' ? input.chord.slice(0, 40) : 'a key'
  return `I am about to press the ${chord} key. Press it?`
}

function approvalMatches(request: PolicyRequest): boolean {
  const approval = request.approval
  if (!approval) {
    return false
  }
  if (approval.tool !== request.tool) {
    return false
  }
  if (approval.payloadJson !== canonicalJson(request.input)) {
    return false
  }
  return new Date(approval.expiresAtUtc).getTime() > request.now.getTime()
}
