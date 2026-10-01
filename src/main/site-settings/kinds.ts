// Every kind of thing a site can be asked about or told it may not do, in one
// table. The prompt, the site-info rows, the Settings section and the stores
// all read it, so a kind exists in all of them or none. `available` is false
// until the feature that enforces the kind exists: the pages list only what is
// available, so a kind never appears in a control that does nothing.
import type { SettingKey } from '../settings/schema.js'

export type SiteKind =
  | 'camera' | 'microphone' | 'location' | 'clipboardRead' | 'midi' | 'idle' | 'windowManagement' | 'notifications'
  | 'popups' | 'javascript' | 'images' | 'sound' | 'autoDownloads'
  | 'devices' | 'screenShare'

/** What a site's answer is stored as. `ask` is only ever a default: a site has no stored `ask`. */
export type SiteValue = 'ask' | 'allow' | 'block'

export interface SiteKindDef {
  readonly id: SiteKind
  /** Sentence case: shown in the prompt, the site-info rows and Settings. */
  readonly label: string
  /** `permission` a site asks for, `content` a site is allowed or blocked from, `device` picked from a list. */
  readonly group: 'permission' | 'content' | 'device'
  /** The choices for the kind's default, the first being what it starts as. */
  readonly values: readonly SiteValue[]
  readonly settingKey: SettingKey
  /** False until the kind's feature enforces it. */
  readonly available: boolean
}

export const SITE_KINDS: readonly SiteKindDef[] = [
  { id: 'camera', label: 'Camera', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.camera', available: true },
  { id: 'microphone', label: 'Microphone', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.microphone', available: true },
  { id: 'location', label: 'Location', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.location', available: true },
  { id: 'clipboardRead', label: 'Clipboard', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.clipboardRead', available: true },
  { id: 'midi', label: 'MIDI devices', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.midi', available: true },
  { id: 'idle', label: 'Idle detection', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.idle', available: true },
  { id: 'windowManagement', label: 'Window management', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.windowManagement', available: true },
  { id: 'notifications', label: 'Notifications', group: 'permission', values: ['ask', 'block'], settingKey: 'sites.notifications', available: true },
  { id: 'popups', label: 'Pop-ups and redirects', group: 'content', values: ['block', 'allow'], settingKey: 'sites.popups', available: false },
  { id: 'javascript', label: 'JavaScript', group: 'content', values: ['allow', 'block'], settingKey: 'sites.javascript', available: false },
  { id: 'images', label: 'Images', group: 'content', values: ['allow', 'block'], settingKey: 'sites.images', available: false },
  { id: 'sound', label: 'Sound', group: 'content', values: ['allow', 'block'], settingKey: 'sites.sound', available: false },
  { id: 'autoDownloads', label: 'Automatic downloads', group: 'content', values: ['ask', 'block'], settingKey: 'sites.autoDownloads', available: false },
  { id: 'devices', label: 'USB and HID devices', group: 'device', values: ['ask', 'block'], settingKey: 'sites.devices', available: false },
  { id: 'screenShare', label: 'Screen sharing', group: 'device', values: ['ask', 'block'], settingKey: 'sites.screenShare', available: false }
]

const BY_ID: ReadonlyMap<string, SiteKindDef> = new Map(SITE_KINDS.map((kind) => [kind.id, kind]))

export function siteKindById (id: unknown): SiteKindDef | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined
}
