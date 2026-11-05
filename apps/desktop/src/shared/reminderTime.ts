export interface LocalDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export type ZonedResolution =
  { kind: 'exact'; utc: Date } | { kind: 'ambiguous' } | { kind: 'skipped' }

export type ReminderParse =
  | {
      status: 'resolved'
      title: string
      triggerAtUtc: string
      timezone: string
      certain: boolean
      localLabel: string
    }
  | { status: 'needs_input'; question: string }
  | { status: 'ambiguous'; question: string }
  | { status: 'past'; question: string }

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const hourWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  midnight: 0,
  noon: 12
}

export function parseReminderRequest(
  raw: string,
  now: Date,
  timeZone: string
): ReminderParse | null {
  const text = raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/, '')
  const lower = text.toLowerCase()
  if (!isReminderUtterance(lower)) {
    return null
  }
  if (/^set a reminder$/.test(lower) || /^remind me$/.test(lower)) {
    return {
      status: 'needs_input',
      question: 'What should I remind you about, and when?'
    }
  }

  let working = lower.replace(/^remind me\s+/, '')
  const day = takeDay(working)
  working = day.rest
  const clock = takeClock(working)
  working = clock.rest
  const period = takePeriod(working)
  working = period.rest
  const title = cleanupTitle(working)

  if (!title) {
    return { status: 'needs_input', question: 'What should I remind you about, and when?' }
  }
  if (!clock.found && period.value !== 'noon') {
    return { status: 'needs_input', question: 'What time should I remind you?' }
  }

  const interpreted = interpretClock(clock, period.value)
  if (interpreted.status === 'needs_input') {
    return interpreted
  }

  const date = calendarDate(now, timeZone, day.value, interpreted.hour, interpreted.minute)
  const resolved = resolveZonedLocalTime(
    { ...date, hour: interpreted.hour, minute: interpreted.minute },
    timeZone
  )
  if (resolved.kind === 'ambiguous') {
    return {
      status: 'ambiguous',
      question:
        'That time happens twice when the clocks change. Do you mean before or after the change?'
    }
  }
  if (resolved.kind === 'skipped') {
    return {
      status: 'ambiguous',
      question: "That time doesn't happen when the clocks change. What time should I use?"
    }
  }
  if (resolved.utc.getTime() <= now.getTime()) {
    return { status: 'past', question: 'That time has passed. When should I remind you?' }
  }

  return {
    status: 'resolved',
    title,
    triggerAtUtc: resolved.utc.toISOString(),
    timezone: timeZone,
    certain: interpreted.certain,
    localLabel: formatLocalLabel(resolved.utc, timeZone)
  }
}

export function resolveZonedLocalTime(local: LocalDateTime, timeZone: string): ZonedResolution {
  if (!isRealDate(local.year, local.month, local.day)) {
    return { kind: 'skipped' }
  }
  const desired = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0)
  let utc = desired - offsetMs(desired, timeZone)
  utc = desired - offsetMs(utc, timeZone)
  const matches = sameLocal(new Date(utc), local, timeZone)
  const hour = 60 * 60 * 1000
  const twin = [utc - hour, utc + hour].some(
    (candidate) => candidate !== utc && sameLocal(new Date(candidate), local, timeZone)
  )
  if (twin) {
    return { kind: 'ambiguous' }
  }
  if (!matches) {
    return { kind: 'skipped' }
  }
  return { kind: 'exact', utc: new Date(utc) }
}

export function formatLocalLabel(utc: Date, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(utc)
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(utc)
  return `${weekday} at ${time}`
}

export function zonedParts(date: Date, timeZone: string): LocalDateTime & { weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date)
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday ?? '')
  let hour = Number(map.hour)
  if (hour === 24) {
    hour = 0
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: weekday < 0 ? 0 : weekday
  }
}

function isReminderUtterance(lower: string): boolean {
  return (
    /^remind me\b/.test(lower) ||
    /^set a reminder\b/.test(lower) ||
    /\bmy reminders\b/.test(lower) ||
    /^cancel (?:the )?reminder\b/.test(lower) ||
    /^what reminders\b/.test(lower)
  )
}

function takeDay(input: string): { value: string | null; rest: string } {
  const match =
    /\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(input)
  if (!match || match.index === undefined) {
    return { value: null, rest: input }
  }
  return { value: match[1]?.toLowerCase() ?? null, rest: cut(input, match.index, match[0].length) }
}

function takePeriod(input: string): { value: string | null; rest: string } {
  const match = /\b(morning|afternoon|evening|night|noon)\b/i.exec(input)
  if (!match || match.index === undefined) {
    return { value: null, rest: input }
  }
  return { value: match[1]?.toLowerCase() ?? null, rest: cut(input, match.index, match[0].length) }
}

function takeClock(input: string): {
  found: boolean
  hour: number
  minute: number
  meridiem: 'am' | 'pm' | null
  named: 'noon' | 'midnight' | null
  rest: string
} {
  const hits = [
    ...clockHits(
      input,
      /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi,
      (match) => ({
        hour: Number(match[1]),
        minute: Number(match[2] ?? '0'),
        meridiem: meridiem(match[3]),
        named: null
      })
    ),
    ...clockHits(
      input,
      /\b(?:at\s+)?(midnight|noon|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:\s*(a\.?m\.?|p\.?m\.?))?/gi,
      (match) => {
        const name = match[1]?.toLowerCase() ?? ''
        const named = name === 'noon' || name === 'midnight' ? name : null
        return {
          hour: hourWords[name] ?? 0,
          minute: 0,
          meridiem: meridiem(match[2]),
          named
        }
      }
    )
  ]
  const chosen = hits
    .filter((hit) => hit.hour <= 23 && hit.minute <= 59)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]
  if (!chosen) {
    return { found: false, hour: 0, minute: 0, meridiem: null, named: null, rest: input }
  }
  return {
    found: true,
    hour: chosen.hour,
    minute: chosen.minute,
    meridiem: chosen.meridiem,
    named: chosen.named,
    rest: cut(input, chosen.index, chosen.length)
  }
}

function clockHits(
  input: string,
  pattern: RegExp,
  read: (match: RegExpExecArray) => {
    hour: number
    minute: number
    meridiem: 'am' | 'pm' | null
    named: 'noon' | 'midnight' | null
  }
): Array<{
  hour: number
  minute: number
  meridiem: 'am' | 'pm' | null
  named: 'noon' | 'midnight' | null
  index: number
  length: number
  score: number
}> {
  const hits: Array<{
    hour: number
    minute: number
    meridiem: 'am' | 'pm' | null
    named: 'noon' | 'midnight' | null
    index: number
    length: number
    score: number
  }> = []
  pattern.lastIndex = 0
  let match = pattern.exec(input)
  while (match) {
    const parsed = read(match)
    const length = match[0].length
    let score = 0
    if (parsed.meridiem || parsed.named) {
      score += 4
    }
    if (/^at\s/i.test(match[0])) {
      score += 2
    }
    hits.push({ ...parsed, index: match.index, length, score })
    if (length === 0) {
      pattern.lastIndex += 1
    }
    match = pattern.exec(input)
  }
  return hits
}

function interpretClock(
  clock: {
    found: boolean
    hour: number
    minute: number
    meridiem: 'am' | 'pm' | null
    named: 'noon' | 'midnight' | null
  },
  period: string | null
):
  | { status: 'ok'; hour: number; minute: number; certain: boolean }
  | { status: 'needs_input'; question: string } {
  if (clock.named === 'noon') {
    return { status: 'ok', hour: 12, minute: 0, certain: true }
  }
  if (clock.named === 'midnight') {
    return { status: 'ok', hour: 0, minute: 0, certain: true }
  }
  if (period === 'noon' && !clock.found) {
    return { status: 'ok', hour: 12, minute: 0, certain: true }
  }
  if (!clock.found || clock.hour > 23 || clock.minute > 59) {
    return { status: 'needs_input', question: 'What time should I remind you?' }
  }
  if (clock.hour === 12 && !clock.meridiem && !period) {
    return { status: 'needs_input', question: 'Do you mean noon or midnight?' }
  }

  let hour = clock.hour
  let certain = clock.meridiem !== null || period !== null || hour >= 13
  if (clock.meridiem === 'pm' && hour < 12) {
    hour += 12
  }
  if (clock.meridiem === 'am' && hour === 12) {
    hour = 0
  }
  if (!clock.meridiem && period === 'morning') {
    certain = true
    if (hour === 12) {
      hour = 0
    }
  }
  if (!clock.meridiem && (period === 'afternoon' || period === 'evening' || period === 'night')) {
    certain = true
    if (hour < 12) {
      hour += 12
    }
  }
  if (!clock.meridiem && period === 'noon') {
    hour = 12
    certain = true
  }
  if (!certain && hour > 0 && hour < 12) {
    hour += 12
  }
  return { status: 'ok', hour, minute: clock.minute, certain }
}

function calendarDate(
  now: Date,
  timeZone: string,
  day: string | null,
  hour: number,
  minute: number
): { year: number; month: number; day: number } {
  const today = zonedParts(now, timeZone)
  if (!day || day === 'today') {
    return { year: today.year, month: today.month, day: today.day }
  }
  if (day === 'tomorrow') {
    return addDays(today.year, today.month, today.day, 1)
  }
  const target = weekdays.indexOf(day)
  let delta = (target - today.weekday + 7) % 7
  if (delta === 0) {
    const passed = hour < today.hour || (hour === today.hour && minute <= today.minute)
    if (passed) {
      delta = 7
    }
  }
  return addDays(today.year, today.month, today.day, delta)
}

function addDays(
  year: number,
  month: number,
  day: number,
  days: number
): {
  year: number
  month: number
  day: number
} {
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  }
}

function cleanupTitle(input: string): string {
  let title = input
  for (let pass = 0; pass < 3; pass += 1) {
    title = title
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(to|at|on)\s+/i, '')
      .trim()
  }
  return title
}

function cut(input: string, index: number, length: number): string {
  return `${input.slice(0, index)} ${input.slice(index + length)}`
}

function meridiem(value: string | undefined): 'am' | 'pm' | null {
  if (!value) {
    return null
  }
  return value.toLowerCase().startsWith('p') ? 'pm' : 'am'
}

function sameLocal(date: Date, local: LocalDateTime, timeZone: string): boolean {
  const parts = zonedParts(date, timeZone)
  return (
    parts.year === local.year &&
    parts.month === local.month &&
    parts.day === local.day &&
    parts.hour === local.hour &&
    parts.minute === local.minute
  )
}

function offsetMs(utcMs: number, timeZone: string): number {
  const local = zonedParts(new Date(utcMs), timeZone)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0) - utcMs
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}
