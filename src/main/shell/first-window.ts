// What a cold start opens. The one place that decides it: a feature that changes the first window
// (a session to restore, a home page, an address on the command line) is a line here, not in index.ts.
import { urlsFromArgv } from '../launch/launch-context.js'
import { placementFor } from '../window-state/placement.js'
import type { Rect } from '../window-state/placement.js'
import { fillFirst, restoreWindows, takeOffStack } from '../startup/startup-open.js'
import { planStartup } from '../startup/startup-plan.js'
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
  /** Opens a window; needed only to bring back the windows after the first one. */
  readonly openWindow?: (options: ShellWindowOptions) => void
}

export function firstWindowOptions ({ services, isPrivate, argv, displays = [], openWindow }: FirstWindowInput): ShellWindowOptions {
  const options: { -readonly [K in keyof ShellWindowOptions]: ShellWindowOptions[K] } = {}

  // A private session records no place, so it has none to restore; a kiosk fills the screen whatever was saved.
  if (!isPrivate && !services.kiosk) {
    const { place, maximized } = placementFor(services.windowState.get(), displays)
    if (place !== undefined) options.place = place
    if (maximized) options.maximized = true
  }

  // What the start-up choice opens, with the addresses on the command line after it: a person who clicked a link
  // wants that page in front, however the last session ended. A kiosk shows the launch address or the home page instead.
  const given = urlsFromArgv(argv)
  if (services.kiosk) {
    const home = homeAddress(services.settings)
    const addresses = given.length > 0 ? given : home === null ? [] : [home]
    if (addresses.length > 0) options.first = (tabs) => { addresses.forEach((address, index) => { tabs.createTab(address, index === 0) }) }
    return options
  }
  const plan = planStartup({
    mode: services.settings.get('startup.mode'),
    pages: services.settings.get('startup.pages'),
    argvUrls: given,
    previous: services.session.previous(),
    isPrivate
  })
  const { first } = plan
  if (first.tabs.length > 0 || first.urls.length > 0) options.first = fillFirst(first)
  if (first.saved !== undefined) {
    // The saved window's own size and place replace the last-used window's: they are the ones the session had.
    const saved = placementFor({ bounds: first.saved.bounds, maximized: first.saved.maximized }, displays)
    if (saved.place !== undefined) options.place = saved.place
    options.maximized = saved.maximized
    takeOffStack(services.closedTabs, openWindow === undefined ? [first.saved] : [first.saved, ...plan.more])
  }
  if (plan.more.length > 0 && openWindow !== undefined) {
    // A person who clicked a link wants that page in front: the other windows come up behind it, and it gets the
    // focus back once they are all there.
    options.after = (first) => {
      restoreWindows(plan.more, openWindow, displays, { allShown: () => { if (!first.isDestroyed()) first.focus() } })
    }
  }
  return options
}
