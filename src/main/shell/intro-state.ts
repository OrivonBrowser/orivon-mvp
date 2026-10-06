// Whether this launch opens on the welcome screen, decided before the window
// exists. No Electron here: the view that shows it is ./intro-view.ts.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MODES = ['always', 'once', 'off'] as const

/** `once` is the default: the screen shows until the person has clicked through it, then never again. */
export type IntroMode = typeof MODES[number]

export interface IntroPlan {
  /** The screen offers to make Orivon the default browser, a box left unticked: decided from facts alone, since asking the system would delay the first window. */
  readonly offerDefault: boolean
  /** The screen puts the telemetry question in place of its single Enter button: the person has not chosen yet, and telemetry runs in this process. */
  readonly offerTelemetry: boolean
  /** Records the answer to that question, for the whole computer. Called once, with the button the person pressed. */
  readonly chooseTelemetry: (on: boolean) => Promise<void>
  /**
   * Called when the person clicks through. Only `once` remembers it: a launch
   * in `always` mode (`npm run dev`) must not use up the one-time showing a
   * later `npm run start` on the same profile is owed.
   */
  readonly onEntered: () => Promise<void>
}

export function introMode (value: string | undefined): IntroMode {
  return MODES.find((mode) => mode === value) ?? 'once'
}

export function shouldShowIntro (mode: IntroMode, seen: boolean): boolean {
  return mode === 'always' || (mode === 'once' && !seen)
}

function seenPath (userDataDir: string): string {
  return join(userDataDir, 'intro.json')
}

/** A missing or corrupt file reads as "not seen": the worst case is one more showing, never a crash. */
export async function readIntroSeen (userDataDir: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(seenPath(userDataDir), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['seen'] === true
  } catch {
    return false
  }
}

/** Best effort: a lost write costs one more showing, not worth failing the click for. */
export async function markIntroSeen (userDataDir: string): Promise<void> {
  try {
    await writeFile(seenPath(userDataDir), JSON.stringify({ seen: true }), 'utf8')
  } catch (error) {
    console.error('[orivon] intro: failed to remember that it was seen:', error)
  }
}

/** What the page reports when it is left: `#leaving`, `#leaving-default`, or `#leaving?default=0|1&telemetry=0|1` when the telemetry question was on it. */
export interface LeavingReport {
  readonly makeDefault: boolean
  /** The button pressed, or undefined when the page asked no telemetry question. */
  readonly telemetry: boolean | undefined
}

export function parseLeaving (hash: string): LeavingReport | undefined {
  if (hash === '#leaving') return { makeDefault: false, telemetry: undefined }
  if (hash === '#leaving-default') return { makeDefault: true, telemetry: undefined }
  if (!hash.startsWith('#leaving?')) return undefined
  const params = new URLSearchParams(hash.slice('#leaving?'.length))
  const telemetry = params.get('telemetry')
  return { makeDefault: params.get('default') === '1', telemetry: telemetry === '1' ? true : telemetry === '0' ? false : undefined }
}

/** The address of the welcome page: what main offers it travels in the query, since the page has no bridge. */
export function introPageUrl (page: string, plan: Pick<IntroPlan, 'offerDefault' | 'offerTelemetry'>): string {
  const query = new URLSearchParams()
  if (plan.offerDefault) query.set('default', '1')
  if (plan.offerTelemetry) query.set('telemetry', '1')
  const text = query.toString()
  return text === '' ? page : `${page}?${text}`
}

/** What the telemetry question needs from outside: whether it is to be asked, asked only when the screen shows, and where the answer goes. */
export interface TelemetryQuestion {
  readonly offered: () => Promise<boolean>
  readonly choose: (on: boolean) => Promise<void>
}

export async function planIntro (envValue: string | undefined, userDataDir: string, offerDefault = false, telemetry?: TelemetryQuestion): Promise<IntroPlan | undefined> {
  const mode = introMode(envValue)
  if (envValue !== undefined && envValue !== '' && envValue !== mode) {
    console.warn(`[orivon] intro: ORIVON_INTRO=${envValue} is not always, once or off; using once`)
  }
  if (!shouldShowIntro(mode, await readIntroSeen(userDataDir))) return undefined
  const offerTelemetry = telemetry !== undefined && await telemetry.offered()
  return {
    offerDefault,
    offerTelemetry,
    chooseTelemetry: telemetry?.choose ?? (async () => {}),
    onEntered: mode === 'once' ? () => markIntroSeen(userDataDir) : async () => {}
  }
}
