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

export async function planIntro (envValue: string | undefined, userDataDir: string, offerDefault = false): Promise<IntroPlan | undefined> {
  const mode = introMode(envValue)
  if (envValue !== undefined && envValue !== '' && envValue !== mode) {
    console.warn(`[orivon] intro: ORIVON_INTRO=${envValue} is not always, once or off; using once`)
  }
  if (!shouldShowIntro(mode, await readIntroSeen(userDataDir))) return undefined
  return { offerDefault, onEntered: mode === 'once' ? () => markIntroSeen(userDataDir) : async () => {} }
}
