import type { ShellEvent } from '../../main/shell/shell-events.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { createBookmarksBar } from './bookmarks-bar.js'
import { createCluster } from './cluster.js'
import { createNavigation } from './navigation.js'
import { createSiteBadges } from './site-badges.js'
import { createTabStrip } from './tab-strip.js'

/** Adds to a tab's element after the strip built it; one entry per feature, alphabetical by the file that draws it. */
export const TAB_DECORATORS: readonly TabDecorator[] = []

/** The chrome's features, initialised and rendered in this order; one entry per feature. */
export const CHROME_MODULES: readonly ChromeModule[] = [
  createTabStrip(TAB_DECORATORS),
  createNavigation(),
  createSiteBadges(),
  createCluster(),
  createBookmarksBar()
]

/** Hands a main-to-chrome event to the module it is for. The three events that predate modules name their
 * module here; a module event names its own. */
export function dispatchShellEvent (event: ShellEvent, ctx: ChromeContext, modules: readonly ChromeModule[] = CHROME_MODULES): void {
  const [name, payload] = event.type === 'module'
    ? [event.module, event.payload]
    : [event.type === 'focusAddress' ? 'navigation' : 'tab-strip', event]
  modules.find((module) => module.name === name)?.event?.(payload, ctx)
}
