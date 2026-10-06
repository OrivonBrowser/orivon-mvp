// A stand-in for the screen-share picker, so an e2e spec can drive a share without a person to pick. Reachable only
// from Node code already in the process (Playwright's `evaluate()`), and compiled out of an ordinary build: the same
// flag and reasoning as ./dev-grant.ts. scripts/check-dev-grant-absent.mjs looks for `__orivonDevDisplayChooser`.
import type { WebContents } from 'electron'
import { bindDisplayChooser, shareRegistry } from '../display-capture/bindings.js'
import type { ChooseDisplaySource, DisplayChoice, DisplayHints } from '../display-capture/types.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** What the stand-in picks. `delayMs` holds the answer open, so a spec can make a second call while the first waits. */
export type DevChooserMode =
  | { readonly kind: 'screen', readonly delayMs?: number }
  | { readonly kind: 'tab', /** A tab whose address contains this. */ readonly url: string, readonly audio?: boolean, readonly delayMs?: number }
  | { readonly kind: 'cancel', readonly delayMs?: number }

/** One call of the picker, as the spec reads it back. */
export interface DevChooserCall {
  readonly origin: string
  readonly isApp: boolean
  readonly audio: boolean
  readonly hints: DisplayHints
}

export interface DevChooserDeps {
  /** The first screen `desktopCapturer` lists. */
  firstScreen: () => Promise<{ id: string, name: string } | undefined>
  findTab: (url: string) => WebContents | undefined
}

export interface DevChooser {
  chooser: ChooseDisplaySource
  use: (mode: DevChooserMode) => void
  calls: DevChooserCall[]
  reset: () => void
}

export function createDevChooser (deps: DevChooserDeps): DevChooser {
  let mode: DevChooserMode = { kind: 'cancel' }
  const calls: DevChooserCall[] = []

  async function pick (current: DevChooserMode, audio: boolean): Promise<DisplayChoice | null> {
    if (current.kind === 'cancel') return null
    if (current.kind === 'screen') {
      const source = await deps.firstScreen()
      return source === undefined ? null : { kind: 'screen', source, systemAudio: audio, label: source.name }
    }
    const tab = deps.findTab(current.url)
    return tab === undefined ? null : { kind: 'tab', tab, audio: current.audio ?? audio, label: tab.getTitle() }
  }

  const chooser: ChooseDisplaySource = async (request, signal) => {
    calls.push({ origin: request.origin, isApp: request.isApp, audio: request.audio, hints: request.hints })
    const current = mode
    if (current.delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, current.delayMs)
        signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      if (signal.aborted) return null
    }
    return await pick(current, request.audio)
  }

  return {
    chooser,
    use (next) { mode = next; bindDisplayChooser(chooser) },
    calls,
    reset () { mode = { kind: 'cancel' }; calls.length = 0 }
  }
}

/** A running share, as a spec reads it. */
export interface DevShare {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly origin: string
  readonly audio: boolean
}

export interface DevDisplayHook extends Pick<DevChooser, 'use' | 'calls' | 'reset'> {
  /** The shares the registry holds now. */
  shares: () => DevShare[]
  /** The registry's Stop, as the indicators call it. */
  stop: (id: string) => void
}

declare global {
  var __orivonDevDisplayChooser: DevDisplayHook | undefined
}

/** Exposes the stand-in, and the registry's list and Stop, on `globalThis` in a build that carries the seam. `use` binds the stand-in over any real picker. */
export function exposeDisplayChooserForTests (deps: DevChooserDeps): void {
  if (!SEAM_ENABLED) return
  const { use, calls, reset } = createDevChooser(deps)
  globalThis.__orivonDevDisplayChooser = {
    use,
    calls,
    reset,
    shares: () => shareRegistry().list().map(({ id, kind, label, origin, audio }) => ({ id, kind, label, origin, audio })),
    stop: (id) => { shareRegistry().stop(id) }
  }
}
