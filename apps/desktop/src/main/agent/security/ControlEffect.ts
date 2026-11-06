export type ControlClass = 'ordinary' | 'ambiguous' | 'consequential' | 'sensitive'

const sensitiveText =
  /\b(password|passcode|passphrase|pin|otp|one[- ]time|cvv|cvc|security code)\b/i
const consequentialText =
  /\b(submit|send|buy|purchase|payment|delete|pay|transfer|upload|checkout)\b/i
const ambiguousName = /^(ok|okay|continue|yes|next|allow|confirm|proceed|done)$/i
const permissionContext =
  /\b(permission|accessibility|screen recording|grant access|allow access|control this (?:mac|computer))\b/i
const permissionLabel = /\b(allow|grant|ok|okay|continue|yes)\b/i

export function classifyControlLabel(input: { name?: string; contextText?: string }): {
  kind: ControlClass
  reason: string
} {
  const name = (input.name ?? '').replace(/[\r\n]+/g, ' ').trim()
  const context = (input.contextText ?? '').replace(/[\r\n]+/g, ' ').trim()
  const shown = name.slice(0, 40) || 'that control'
  if (sensitiveText.test(name) || sensitiveText.test(context)) {
    return {
      kind: 'sensitive',
      reason: "I can't type into or press a password or security code."
    }
  }
  if (permissionLabel.test(name) && permissionContext.test(`${name} ${context}`)) {
    return {
      kind: 'sensitive',
      reason: "I can't approve a permission or security prompt."
    }
  }
  if (
    consequentialText.test(name) ||
    (ambiguousName.test(name) && consequentialText.test(context))
  ) {
    return {
      kind: 'consequential',
      reason:
        "I can't press that from a generic click. Sending, buying, deleting, or uploading needs a specific action I don't have."
    }
  }
  if (ambiguousName.test(name)) {
    return {
      kind: 'ambiguous',
      reason: `I can't tell from the word ${shown} whether that is safe. Confirm this exact control?`
    }
  }
  return { kind: 'ordinary', reason: '' }
}
