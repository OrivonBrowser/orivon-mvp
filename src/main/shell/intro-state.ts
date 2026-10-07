// Whether this launch opens on the welcome screen, decided before the window
// exists. No Electron here: the view that shows it is ./intro-view.ts.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MODES = ['always', 'once', 'off'] as const

/** `once` is the default: the screen shows until the person has clicked through it, then never again. */
export type IntroMode = typeof MODES[number]

export interface IntroPlan {
  /** The welcome page comes first. False when only the telemetry question is due, on a screen already seen: the popup shows alone. */
  readonly welcome: boolean
  /** "Enter Orivon" opens the telemetry popup over the browser before it lets the person in: they have not chosen yet, and telemetry runs in this process. */
  readonly offerTelemetry: boolean
  /** What changed in the telemetry notice since the person agreed, one sentence each; empty unless the question is a renewal. */
  readonly changes: readonly string[]
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

/** What the page reports when it is left: `#leaving`, or `#leaving?telemetry=0|1` when it asked the telemetry question. */
export interface LeavingReport {
  /** The button pressed, or undefined when the page asked no telemetry question. */
  readonly telemetry: boolean | undefined
}

export function parseLeaving (hash: string): LeavingReport | undefined {
  if (hash === '#leaving') return { telemetry: undefined }
  if (!hash.startsWith('#leaving?')) return undefined
  const telemetry = new URLSearchParams(hash.slice('#leaving?'.length)).get('telemetry')
  return { telemetry: telemetry === '1' ? true : telemetry === '0' ? false : undefined }
}

/** The address of the welcome page: what main offers it travels in the query, since the page has no bridge. */
export function introPageUrl (page: string, plan: Pick<IntroPlan, 'offerTelemetry'> & { readonly welcome?: boolean, readonly changes?: readonly string[] }): string {
  const query = new URLSearchParams()
  if (plan.welcome === false) query.set('welcome', '0')
  if (plan.offerTelemetry) query.set('telemetry', '1')
  for (const line of plan.changes ?? []) query.append('changed', line)
  const text = query.toString()
  return text === '' ? page : `${page}?${text}`
}

/** What the telemetry question needs from outside: whether it is to be asked, asked only when the screen shows, and where the answer goes. */
export interface TelemetryQuestion {
  readonly offered: () => Promise<boolean>
  readonly choose: (on: boolean) => Promise<void>
  /** The change lines when an acceptance given under an older notice is due to be asked again, else undefined. */
  readonly renewal?: () => Promise<readonly string[] | undefined>
}

export async function planIntro (envValue: string | undefined, userDataDir: string, telemetry?: TelemetryQuestion): Promise<IntroPlan | undefined> {
  const mode = introMode(envValue)
  if (envValue !== undefined && envValue !== '' && envValue !== mode) {
    console.warn(`[orivon] intro: ORIVON_INTRO=${envValue} is not always, once or off; using once`)
  }
  if (mode === 'off') return undefined
  const show = shouldShowIntro(mode, await readIntroSeen(userDataDir))
  // The first window waits on both questions: a telemetry failure must cost the question, never the window.
  const renewal = await telemetry?.renewal?.().catch((error: unknown) => {
    console.error('[orivon] intro: could not tell whether the telemetry notice changed; not asking again:', error)
    return undefined
  })
  const chooseTelemetry = telemetry?.choose ?? (async () => {})
  if (!show) {
    if (renewal === undefined) return undefined
    // The screen was seen: the popup asks alone, and answering it marks nothing.
    return { welcome: false, offerTelemetry: true, changes: renewal, chooseTelemetry, onEntered: async () => {} }
  }
  const offered = telemetry !== undefined && await telemetry.offered().catch((error: unknown) => {
    console.error('[orivon] intro: could not tell whether to ask about telemetry; not asking:', error)
    return false
  })
  return {
    welcome: true,
    offerTelemetry: offered || renewal !== undefined,
    changes: renewal ?? [],
    chooseTelemetry,
    onEntered: mode === 'once' ? () => markIntroSeen(userDataDir) : async () => {}
  }
}
