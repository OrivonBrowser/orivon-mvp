// What Settings knows about the computer: whether Orivon is its default browser, and the state of a press of
// "Make default". The facts are main's; this part keeps the last answer and redraws when it changes.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type DefaultBrowserView = 'loading' | 'default' | 'can-set' | 'unavailable'

interface StateReply { readonly state?: unknown }

const VIEWS: readonly DefaultBrowserView[] = ['default', 'can-set', 'unavailable']

/** An answer that is not one of main's three is read as "cannot be done here": never a button that may do nothing. */
function viewOf (reply: unknown): DefaultBrowserView {
  const state = typeof reply === 'object' && reply !== null ? (reply as StateReply).state : undefined
  return VIEWS.find((view) => view === state) ?? 'unavailable'
}

export class OsPart implements SettingsPart {
  view: DefaultBrowserView = 'loading'
  /** The button was pressed and main has not answered. */
  busy = false
  /** The last press ended with Orivon still not the default browser. */
  declined = false

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    this.view = viewOf(await this.bridge.request('os', { type: 'defaultBrowser' }))
  }

  async makeDefault (): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.declined = false
    this.notify()
    try {
      this.view = viewOf(await this.bridge.request('os', { type: 'makeDefault' }))
    } catch {
      // Main failed to answer: the row keeps what it knew and says the change did not happen.
    } finally {
      this.busy = false
      this.declined = this.view !== 'default'
      this.notify()
    }
  }
}
