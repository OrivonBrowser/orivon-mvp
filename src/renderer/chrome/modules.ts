import type { ShellEvent } from '../../main/shell/shell-events.js'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { contained } from './contain.js'
import { createAddressDisplay } from './address-display.js'
import { createAddressSuggest } from './address-suggest.js'
import { createBookmarksBar } from './bookmarks-bar.js'
import { createCluster } from './cluster.js'
import { createHomeButton } from './home-button.js'
import { createNavigation } from './navigation.js'
import { createPromptAnchor } from './prompt-anchor.js'
import { createReloadStop } from './reload-stop.js'
import { createSiteBadges } from './site-badges.js'
import { decorateTabBadges } from './tab-badges.js'
import { decorateTabCrashed } from './tab-crashed.js'
import { decorateTabSleeping } from './tab-sleeping.js'
import { createTabSearchButton } from './tab-search-button.js'
import { createTabStrip } from './tab-strip.js'

/** Adds to a tab's element after the strip built it; one entry per feature, alphabetical by the file that draws it. */
export const TAB_DECORATORS: readonly TabDecorator[] = [
  decorateTabBadges,
  decorateTabCrashed,
  decorateTabSleeping
]

/** The chrome's features, initialised and rendered in this order; one entry per feature. */
export const CHROME_MODULES: readonly ChromeModule[] = [
  createTabStrip(TAB_DECORATORS),
  createTabSearchButton(),
  createNavigation(),
  createAddressDisplay(),
  createAddressSuggest(),
  createReloadStop(),
  createHomeButton(),
  createSiteBadges(),
  createPromptAnchor(),
  createCluster(),
  createBookmarksBar()
]

/** Every module's `init`, once. A module that throws is logged by name and the rest still start. */
export function initModules (ctx: ChromeContext, modules: readonly ChromeModule[] = CHROME_MODULES): void {
  for (const module of modules) contained(`${module.name} init`, () => { module.init(ctx) })
}

/** Every module's `render` for one pushed state. */
export function renderModules (state: ShellState, ctx: ChromeContext, modules: readonly ChromeModule[] = CHROME_MODULES): void {
  for (const module of modules) contained(`${module.name} render`, () => { module.render?.(state, ctx) })
}

/** Hands a main-to-chrome event to the module it is for. The three events that predate modules name their
 * module here; a module event names its own. */
export function dispatchShellEvent (event: ShellEvent, ctx: ChromeContext, modules: readonly ChromeModule[] = CHROME_MODULES): void {
  const [name, payload] = event.type === 'module'
    ? [event.module, event.payload]
    : [event.type === 'focusAddress' ? 'navigation' : 'tab-strip', event]
  const module = modules.find((candidate) => candidate.name === name)
  if (module !== undefined) contained(`${module.name} event`, () => { module.event?.(payload, ctx) })
}
