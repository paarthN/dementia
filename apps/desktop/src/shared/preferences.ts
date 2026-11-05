import { z } from 'zod'

export const textScales = ['comfortable', 'large', 'extra-large'] as const
export const themeModes = ['light', 'dark', 'high-contrast', 'system'] as const
export const mascotSizes = ['small', 'medium', 'large'] as const
export const mascotColorIds = ['teal', 'blue', 'purple', 'coral', 'neutral'] as const

const preferencesSchema = z.object({
  version: z.literal(1),
  appearance: z.object({
    textScale: z.enum(textScales),
    contentScale: z.number().min(1).max(1.6),
    theme: z.enum(themeModes),
    accentColorId: z.enum(mascotColorIds),
    mascotColorId: z.enum(mascotColorIds),
    mascotSize: z.enum(mascotSizes),
    reduceMotion: z.boolean()
  }),
  accessibility: z.object({
    extraLineSpacing: z.boolean(),
    simpleExplanations: z.boolean()
  }),
  voice: z.object({
    enabled: z.boolean(),
    readRepliesAloud: z.boolean(),
    language: z.string().min(2).max(16)
  }),
  privacy: z.object({
    saveChatHistory: z.boolean(),
    allowDiagnosticTelemetry: z.boolean(),
    cloudScreenAnalysisEnabled: z.boolean(),
    developerInspection: z.boolean().optional(),
    assistantMode: z.enum(['demo', 'cloud']).default('demo'),
    cloudConsentAtUtc: z.string().min(1).nullable().default(null),
    assistantOrigin: z.string().min(1).max(200).nullable().default(null)
  }),
  startup: z.object({
    launchAtLogin: z.boolean(),
    showNotifications: z.boolean()
  }),
  mascot: z.object({
    monitorId: z.string().nullable(),
    normalizedX: z.number().min(0).max(1),
    normalizedY: z.number().min(0).max(1),
    collapsed: z.boolean()
  })
})

export type UserPreferences = z.infer<typeof preferencesSchema>
export type TextScale = UserPreferences['appearance']['textScale']
export type MascotColorId = (typeof mascotColorIds)[number]

export const defaultPreferences: UserPreferences = {
  version: 1,
  appearance: {
    textScale: 'comfortable',
    contentScale: 1,
    theme: 'system',
    accentColorId: 'teal',
    mascotColorId: 'teal',
    mascotSize: 'medium',
    reduceMotion: false
  },
  accessibility: {
    extraLineSpacing: false,
    simpleExplanations: true
  },
  voice: {
    enabled: false,
    readRepliesAloud: false,
    language: 'en'
  },
  privacy: {
    saveChatHistory: false,
    allowDiagnosticTelemetry: false,
    cloudScreenAnalysisEnabled: false,
    developerInspection: false,
    assistantMode: 'demo',
    cloudConsentAtUtc: null,
    assistantOrigin: null
  },
  startup: {
    launchAtLogin: false,
    showNotifications: true
  },
  mascot: {
    monitorId: null,
    normalizedX: 1,
    normalizedY: 1,
    collapsed: false
  }
}

export function readPreferences(value: unknown): UserPreferences {
  const parsed = preferencesSchema.safeParse(value)
  return parsed.success ? parsed.data : defaultPreferences
}

export function resetAppearance(current: UserPreferences): UserPreferences {
  return {
    ...current,
    appearance: { ...defaultPreferences.appearance },
    accessibility: {
      ...current.accessibility,
      extraLineSpacing: defaultPreferences.accessibility.extraLineSpacing
    }
  }
}

export function nextTextScale(current: TextScale): TextScale {
  if (current === 'comfortable') {
    return 'large'
  }
  if (current === 'large') {
    return 'extra-large'
  }
  return 'extra-large'
}

export const textScalePixels: Record<TextScale, number> = {
  comfortable: 15,
  large: 18,
  'extra-large': 22
}
