// What Settings knows about the computer: whether Orivon is its default browser, and the state of a press of
// "Make default". The facts are main's; this part keeps the last answer and redraws when it changes, and reads it
// again when the page shows again: the person may have chosen in the system's own settings meanwhile. A window focus
// reads it only after a press that sent the person to the system to choose, because focus returns with every click
// from the address bar and each read costs the main process a system call on some platforms.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type DefaultBrowserView = 'loading' | 'default' | 'can-set' | 'unavailable'
export type UnavailableWhy = 'source' | 'appimage' | 'platform' | 'private'

interface StateReply { readonly state?: unknown, readonly reason?: unknown, readonly handedOff?: unknown, readonly entry?: unknown }

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

/** A desktop entry's file name, or nothing: it is shown in a command the person may paste into a terminal. */
const ENTRY_NAME = /^[a-z0-9-]+\.desktop$/

function entryOf (reply: unknown): string | undefined {
  const entry = typeof reply === 'object' && reply !== null ? (reply as StateReply).entry : undefined
  return typeof entry === 'string' && ENTRY_NAME.test(entry) ? entry : undefined
}

/** Where the person's return can be heard: a hidden page shown again, or the window focused again. */
export interface ReturnSources {
  readonly document: Pick<Document, 'addEventListener' | 'hidden'>
  readonly window: Pick<Window, 'addEventListener'>
}

/** The page showed again, or its window was focused again. */
export type ReturnCause = 'shown' | 'focus'

/** Calls `listener` each time the person comes back to the page. The system's settings or a confirmation alert usually
 * leaves the page visible, so a window focus counts as much as the page becoming visible. */
export function onPageReturn (listener: (cause: ReturnCause) => void, sources?: ReturnSources): void {
  const where = sources ?? (typeof document === 'undefined' || typeof window === 'undefined' ? undefined : { document, window })
  if (where === undefined) return
  where.document.addEventListener('visibilitychange', () => { if (!where.document.hidden) listener('shown') })
  where.window.addEventListener('focus', () => { listener('focus') })
}

export class OsPart implements SettingsPart {
  view: DefaultBrowserView = 'loading'
  /** Why `view` is `unavailable`, when main said. */
  reason: UnavailableWhy | undefined
  /** Linux: the desktop entry a choice names, when main said. */
  entry: string | undefined
  /** The button was pressed and main has not answered. */
  busy = false
  /** The last press ended with Orivon still not the default browser. */
  declined = false
  /** The last press sent the person to the system's settings, where the choice is theirs to make. */
  handedOff = false
  /** The person came back from that hand-over and the system still says another browser: a prompt it showed is gone by now. */
  returnedUndecided = false
  private watching = false
  private reading = false

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void, private readonly onReturn: (listener: (cause: ReturnCause) => void) => void = onPageReturn) {}

  async load (): Promise<void> {
    this.take(await this.bridge.request('os', { type: 'defaultBrowser' }))
    if (this.watching) return
    this.watching = true
    this.onReturn((cause) => { void this.refresh(cause) })
  }

  /** Reads the answer again on a return, and redraws when it changed. A focus alone counts only after a hand-over; one read answers the focus and the page shown that a single return sends. */
  async refresh (cause: ReturnCause): Promise<void> {
    if (this.busy || this.reading || (cause === 'focus' && !this.handedOff)) return
    this.reading = true
    const before = this.view
    const undecided = this.returnedUndecided
    try {
      this.take(await this.bridge.request('os', { type: 'defaultBrowser' }))
    } catch {
      return
    } finally {
      this.reading = false
    }
    if (this.view !== 'can-set') this.handedOff = false
    this.returnedUndecided = this.handedOff && this.view === 'can-set'
    if (this.view !== before || this.returnedUndecided !== undecided) this.notify()
  }

  async makeDefault (): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.declined = false
    this.returnedUndecided = false
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
    this.entry = entryOf(reply)
  }
}
