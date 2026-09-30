// What a cold start opens. The one place that decides it: a feature that changes the first window
// (a session to restore, a home page, an address on the command line) is a line here, not in index.ts.
import { urlsFromArgv } from '../launch/launch-context.js'
import { placementFor } from '../window-state/placement.js'
import type { Rect } from '../window-state/placement.js'
import { homeAddress } from './home.js'
import type { ShellServices } from './shell-services.js'
import type { ShellWindowOptions } from './window-options.js'

export interface FirstWindowInput {
  readonly services: ShellServices
  readonly isPrivate: boolean
  /** The process's own command line. */
  readonly argv: readonly string[]
  /** The screens the window may open on; needed only to restore the window's last place. */
  readonly displays?: readonly { readonly bounds: Rect }[]
}

export function firstWindowOptions ({ services, isPrivate, argv, displays = [] }: FirstWindowInput): ShellWindowOptions {
  const options: { -readonly [K in keyof ShellWindowOptions]: ShellWindowOptions[K] } = {}

  // A private session records no place, so it has none to restore; a kiosk fills the screen whatever was saved.
  if (!isPrivate && !services.kiosk) {
    const { place, maximized } = placementFor(services.windowState.get(), displays)
    if (place !== undefined) options.place = place
    if (maximized) options.maximized = true
  }

  // Addresses on the command line open as this window's tabs, the first in front. A kiosk with none shows the home page.
  const given = urlsFromArgv(argv)
  const home = services.kiosk ? homeAddress(services.settings) : null
  const addresses = given.length > 0 ? given : home === null ? [] : [home]
  if (addresses.length > 0) {
    options.first = (tabs) => { addresses.forEach((address, index) => { tabs.createTab(address, index === 0) }) }
  }
  return options
}
