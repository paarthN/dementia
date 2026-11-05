import type { ActiveTaskView, ChatMessage, PendingApproval } from './agent'
import type { Favorite } from './favorites'
import type { InspectionView } from './inspection'
import type { GuideView } from './guides'
import type { UserPreferences } from './preferences'
import type { DueReminder, Reminder } from './reminders'

export const panelViews = ['home', 'settings', 'chat', 'help'] as const
export type PanelView = (typeof panelViews)[number]

export interface SessionSnapshot {
  preferences: UserPreferences
  favorites: Favorite[]
  reminders: Reminder[]
  dueReminders: DueReminder[]
  messages: ChatMessage[]
  activeTask: ActiveTaskView | null
  pendingApproval: PendingApproval | null
  shortcutWarning: string | null
  notice: string | null
  panelView: PanelView
  screen: {
    access: 'off' | 'on'
    captureActive: boolean
    helper: 'running' | 'unavailable'
  }
  inspectionView: InspectionView | null
  guide: GuideView | null
}

export interface ActionResult {
  status: 'succeeded' | 'failed' | 'needs_confirmation'
  summary: string
}
