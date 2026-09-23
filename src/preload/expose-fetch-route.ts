// The preload-side wiring that installs the routed network path into a tab's
// main world. Each installer below is a payload SERIALISED into the main
// world and may reference nothing outside its own body, while this is
// ordinary preload code that imports freely -- the reason the two live in
// different files. They run in order, handing each other their work through
// a slot on the page's window that the last step removes (README.md's
// Design notes).

import { contextBridge } from 'electron'
import { installRoutedWire } from './routed-wire.js'
import { installRoutedDial } from './routed-dial.js'
import { installRoutedCore, releaseRoutedSlot } from './routed-core.js'
import { installRoutedEvents } from './routed-events.js'
import { installFetchRoute } from './fetch-route.js'
import { installXhrResponse } from './xhr-route-response.js'
import { installXhrRoute } from './xhr-route.js'
import { installEventSourceRoute } from './eventsource-route.js'
import { installWebSocketFrames } from './websocket-route-frames.js'
import { installWebSocketRoute } from './websocket-route.js'

/** The literal `webPreferences.additionalArguments` flag `src/main/
 * tab-view.ts`'s `appTabArgsFor` sets -- duplicated here rather than
 * imported (src/preload/README.md forbids importing anything under
 * src/main/ except ./channels.ts, and this is not a channel), the same
 * choice `newtab.ts`'s own `--orivon-newtab-url=` flag already made. */
const APP_TAB_FLAG = '--orivon-app-tab'

/** Dependency order: each one reads what the ones before it published. */
const INSTALLERS: ReadonlyArray<(isAppTab: boolean) => void> = [
  installRoutedWire, installRoutedDial, installRoutedCore, installRoutedEvents,
  installFetchRoute, installXhrResponse, installXhrRoute, installEventSourceRoute,
  installWebSocketFrames, installWebSocketRoute
]

/**
 * Fail-open, same shape as orivon-surface.ts's own `exposeOrivon()`:
 * `contextBridge.executeInMainWorld` is `@experimental` and may be absent
 * or throw, in which case the page keeps its native globals rather than
 * preload aborting. Reads `isAppTab` synchronously off `process.argv` --
 * available here (the isolated world), unlike inside the installers, which
 * run in the main world and have no `process` -- so it crosses as a plain
 * boolean argument instead. Each installer's trailing `target` parameter is
 * left OMITTED, so its own default (the real main-world `window`) applies.
 */
export function exposeFetchRoute (): void {
  const isAppTab = process.argv.includes(APP_TAB_FLAG)
  if (!isAppTab) return
  for (const func of INSTALLERS) {
    try {
      contextBridge.executeInMainWorld({ func, args: [isAppTab] })
    } catch (error) {
      console.error('[orivon] a routed network global was not installed', error)
    }
  }
  try {
    contextBridge.executeInMainWorld({ func: releaseRoutedSlot, args: [] })
  } catch (error) {
    console.error('[orivon] the routed network slot was not released', error)
  }
}
