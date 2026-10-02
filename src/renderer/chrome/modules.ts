import type { ShellEvent } from '../../main/shell/shell-events.js'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { contained } from './contain.js'
import { createAddressDisplay } from './address-display.js'
import { createAddressSuggest } from './address-suggest.js'
import { createBookmarkStar } from './bookmark-star.js'
import { createBookmarksBar } from './bookmarks-bar.js'
import { createCluster } from './cluster.js'
import { createExtensionsButton } from './extensions-button.js'
import { createDownloadsButton } from './downloads-button.js'
import { createHomeButton } from './home-button.js'
import { createNavigation } from './navigation.js'
import { createPanes } from './panes.js'
import { createPasswordKey } from './password-key.js'
import { createContentDot } from './content-dot.js'
import { createPopupsChip } from './popups-chip.js'
import { createPromptAnchor } from './prompt-anchor.js'
import { createReaderButton } from './reader-button.js'
import { createSidePanelButton } from './side-panel-button.js'
import { createSiteAccessChip } from './site-access-chip.js'
import { createSiteBadges } from './site-badges.js'
import { decorateTabBadges } from './tab-badges.js'
import { decorateTabCrashed } from './tab-crashed.js'
import { createTabGroups, decorateTabGroup, placeGroupChips } from './tab-groups.js'
import { decorateTabSleeping } from './tab-sleeping.js'
import { createTabSearchButton } from './tab-search-button.js'
import { createTabStrip } from './tab-strip.js'

const panes = createPanes()

/** Adds to a tab's element after the strip built it; one entry per feature, alphabetical by the file that draws it. The pane stops come last: they set the keyboard stop of what the others added. */
export const TAB_DECORATORS: readonly TabDecorator[] = [
  decorateTabBadges,
  decorateTabCrashed,
  decorateTabGroup,
  decorateTabSleeping,
  panes.decorator
]

/** The chrome's features, initialised and rendered in this order; one entry per feature. */
export const CHROME_MODULES: readonly ChromeModule[] = [
  createTabStrip(TAB_DECORATORS, [placeGroupChips]),
  createTabSearchButton(),
  createTabGroups(),
  createNavigation(),
  createAddressDisplay(),
  createAddressSuggest(),
  createHomeButton(),
  createSiteBadges(),
  createSiteAccessChip(),
  createPopupsChip(),
  createContentDot(),
  createPasswordKey(),
  createPromptAnchor(),
  createReaderButton(),
  createCluster(),
  createExtensionsButton(),
  createDownloadsButton(),
  createSidePanelButton(),
  createBookmarkStar(),
  createBookmarksBar(),
  panes.module
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
