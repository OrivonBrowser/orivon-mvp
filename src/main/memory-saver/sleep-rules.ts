// When a tab may go to sleep, and when it is due. Pure: the facts come from sleep-facts.ts, the settings from the store.

/** Everything the rules read about one tab. Each is true when it keeps the tab awake. */
export interface SleepFacts {
  /** The tab the person is in. */
  active: boolean
  /** The tab shown beside the one the person is in, in a split. */
  splitPartner: boolean
  pinned: boolean
  audible: boolean
  /** The page is being captured, or is capturing the screen. */
  capturing: boolean
  /** The page uses the camera, the microphone, a screen share or a chosen device. */
  mediaInUse: boolean
  /** A permission prompt, a sign-in or a chooser is shown or waiting for this tab. */
  pendingAsk: boolean
  crashed: boolean
  devtools: boolean
  /** The new-tab page, a blank page, or a tab that has not committed an address. */
  newTab: boolean
  /** One of the shell's own pages. */
  internal: boolean
  /** A registered app's tab: its grants and sockets belong to the page that is running. */
  app: boolean
  /** Not the default session. */
  partitioned: boolean
  loading: boolean
  /** The address is not one a page can be restored from. */
  unrestorable: boolean
  keepAwakeHost: boolean
  /** Something the person typed would be lost. */
  unsaved: boolean
}

export type SleepWhy =
  | 'active' | 'split' | 'pinned' | 'sound' | 'media' | 'ask' | 'unsaved'
  | 'crashed' | 'devtools' | 'new-tab' | 'internal' | 'app' | 'partition' | 'loading' | 'address' | 'kept'
  | 'asleep' | 'gone'

export type SleepVerdict = { readonly ok: true } | { readonly ok: false, readonly why: SleepWhy }

/** The first reason that applies, in the order the person would want to hear it: what they chose, then what is
 * playing, then what is asked, then what is only a rule of the browser. */
const ORDER: ReadonlyArray<readonly [keyof SleepFacts, SleepWhy]> = [
  ['active', 'active'],
  ['splitPartner', 'split'],
  ['pinned', 'pinned'],
  ['audible', 'sound'],
  ['capturing', 'media'],
  ['mediaInUse', 'media'],
  ['pendingAsk', 'ask'],
  ['unsaved', 'unsaved'],
  ['crashed', 'crashed'],
  ['devtools', 'devtools'],
  ['newTab', 'new-tab'],
  ['internal', 'internal'],
  ['app', 'app'],
  ['partitioned', 'partition'],
  ['loading', 'loading'],
  ['unrestorable', 'address'],
  ['keepAwakeHost', 'kept']
]

export function canSleep (facts: SleepFacts): SleepVerdict {
  for (const [fact, why] of ORDER) if (facts[fact]) return { ok: false, why }
  return { ok: true }
}

/** Whether `host` is one of the listed sites or a subdomain of one. */
export function hostKept (host: string, list: string): boolean {
  const name = host.toLowerCase()
  if (name === '') return false
  return list.split('\n').map((line) => line.trim().toLowerCase()).filter((line) => line !== '')
    .some((entry) => name === entry || name.endsWith(`.${entry}`))
}

const MINUTE = 60_000

/** How long a tab may sit unused before it sleeps, for each `performance.sleepAfter` value. */
export const SLEEP_AFTER_MS: Readonly<Record<string, number>> = {
  '15m': 15 * MINUTE, '30m': 30 * MINUTE, '1h': 60 * MINUTE, '2h': 120 * MINUTE, '4h': 240 * MINUTE
}

/** The wait on battery with the energy saver on. */
export const BATTERY_SLEEP_MS = 5 * MINUTE

export interface SleepSettings {
  readonly memorySaver: boolean
  readonly sleepAfter: string
  readonly energySaver: string
}

/** How long a tab may sit unused, or null while nothing puts tabs to sleep. The energy saver works on its own:
 * it asks for sleep on battery whether or not the memory saver is on, and never lengthens the wait. */
export function delayFor (settings: SleepSettings, onBattery: boolean): number | null {
  const base = settings.memorySaver ? SLEEP_AFTER_MS[settings.sleepAfter] ?? SLEEP_AFTER_MS['30m'] ?? null : null
  if (settings.energySaver === 'battery' && onBattery) return base === null ? BATTERY_SLEEP_MS : Math.min(base, BATTERY_SLEEP_MS)
  return base
}

/** Whether a tab last in front at `lastActiveAt` has been idle for `delay`. A tab never seen in front is not due. */
export function dueToSleep (lastActiveAt: number | undefined, now: number, delay: number): boolean {
  return lastActiveAt !== undefined && now - lastActiveAt >= delay
}
