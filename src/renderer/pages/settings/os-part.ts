// What Settings knows about the computer: whether Orivon is its default browser, and the state of a press of
// "Make default". The facts are main's; this part keeps the last answer and redraws when it changes, and reads
// it again when the person comes back to the page (it shows again, or the window is focused again): they may have
// chosen in the system's own settings meanwhile.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type DefaultBrowserView = 'loading' | 'default' | 'can-set' | 'unavailable'
export type UnavailableWhy = 'source' | 'appimage' | 'platform' | 'private'

interface StateReply { readonly state?: unknown, readonly reason?: unknown, readonly handedOff?: unknown }

const VIEWS: readonly DefaultBrowserView[] = ['default', 'can-set', 'unavailable']
const REASONS: readonly UnavailableWhy[] = ['source', 'appimage', 'platform', 'private']

/** An answer that is not one of main's three is read as "cannot be done here": never a button that may do nothing. */
function viewOf (reply: unknown): DefaultBrowserView {
  const state = typeof reply === 'object' && reply !== null ? (reply as StateReply).state : undefined
  return VIEWS.find((view) => view === state) ?? 'unavailable'
}

function reasonOf (reply: unknown): UnavailableWhy | undefined {
  const reason = typeof reply === 'object' && reply !== null ? (reply as StateReply).reason : undefined
  return REASONS.find((known) => known === reason)
}

/** Where the person's return can be heard: a hidden page shown again, or the window focused again. */
export interface ReturnSources {
  readonly document: Pick<Document, 'addEventListener' | 'hidden'>
  readonly window: Pick<Window, 'addEventListener'>
}

/** Calls `listener` each time the person comes back to the page. The system's settings or a confirmation alert usually
 * leaves the page visible, so a window focus counts as much as the page becoming visible. */
export function onPageReturn (listener: () => void, sources?: ReturnSources): void {
  const where = sources ?? (typeof document === 'undefined' || typeof window === 'undefined' ? undefined : { document, window })
  if (where === undefined) return
  where.document.addEventListener('visibilitychange', () => { if (!where.document.hidden) listener() })
  where.window.addEventListener('focus', () => { listener() })
}

export class OsPart implements SettingsPart {
  view: DefaultBrowserView = 'loading'
  /** Why `view` is `unavailable`, when main said. */
  reason: UnavailableWhy | undefined
  /** The button was pressed and main has not answered. */
  busy = false
  /** The last press ended with Orivon still not the default browser. */
  declined = false
  /** The last press sent the person to the system's settings, where the choice is theirs to make. */
  handedOff = false
  private watching = false

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void, private readonly onReturn: (listener: () => void) => void = onPageReturn) {}

  async load (): Promise<void> {
    this.take(await this.bridge.request('os', { type: 'defaultBrowser' }))
    if (this.watching) return
    this.watching = true
    this.onReturn(() => { void this.refresh() })
  }

  /** Reads the answer again, and redraws when it changed. */
  async refresh (): Promise<void> {
    if (this.busy) return
    const before = this.view
    try {
      this.take(await this.bridge.request('os', { type: 'defaultBrowser' }))
    } catch {
      return
    }
    if (this.view === 'default') this.handedOff = false
    if (this.view !== before) this.notify()
  }

  async makeDefault (): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.declined = false
    this.notify()
    try {
      const reply = await this.bridge.request('os', { type: 'makeDefault' })
      this.take(reply)
      this.handedOff = typeof reply === 'object' && reply !== null && (reply as StateReply).handedOff === true
    } catch {
      // Main failed to answer: the row keeps what it knew and says the change did not happen.
    } finally {
      this.busy = false
      this.declined = this.view !== 'default' && !this.handedOff
      this.notify()
    }
  }

  private take (reply: unknown): void {
    this.view = viewOf(reply)
    this.reason = this.view === 'unavailable' ? reasonOf(reply) : undefined
  }
}
