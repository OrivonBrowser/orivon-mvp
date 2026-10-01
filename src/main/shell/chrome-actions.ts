import { bookmarkEdit } from './bookmark-bubble/edit-action.js'
import { barFolder, barItems, barMenu, barMove, barOpen } from './bookmarks-bar/bar-actions.js'
import { omniboxClose, omniboxPick, omniboxQuery, omniboxSelect } from '../omnibox/omnibox-actions.js'
import { homeOpen } from './actions/home-open.js'
import { groupMenu, groupMove, groupToggle } from './actions/tab-group.js'
import { overlayClose, overlayToggle } from './actions/overlay.js'
import { paneLeave } from './actions/pane-leave.js'
import { promptAnchorReport } from './actions/prompt-anchor.js'
import { tabMute } from './actions/tab-mute.js'
import type { WindowContext } from './window-context.js'

/** A call from the chrome that carries arguments and is not a command. `payload` comes from a renderer:
 * validate every field before using it. */
export type ChromeAction = (payload: unknown, ctx: WindowContext) => unknown

/** One entry per action, alphabetical by name. */
export const CHROME_ACTIONS: Readonly<Record<string, ChromeAction>> = {
  'bookmarks.bar': barItems,
  'bookmarks.edit': bookmarkEdit,
  'bookmarks.folder': barFolder,
  'bookmarks.menu': barMenu,
  'bookmarks.move': barMove,
  'bookmarks.open': barOpen,
  'group.menu': groupMenu,
  'group.move': groupMove,
  'group.toggle': groupToggle,
  'home.open': homeOpen,
  'omnibox.close': omniboxClose,
  'omnibox.pick': omniboxPick,
  'omnibox.query': omniboxQuery,
  'omnibox.select': omniboxSelect,
  'overlay.close': overlayClose,
  'overlay.toggle': overlayToggle,
  'pane.leave': paneLeave,
  'prompt.anchor': promptAnchorReport,
  'tab.mute': tabMute
}

/** Runs the action called `name`. Own keys only: `constructor` or `__proto__` from a renderer must not
 * reach a member of Object.prototype. An unknown name does nothing. */
export function runChromeAction (name: unknown, payload: unknown, ctx: WindowContext): unknown {
  if (typeof name !== 'string' || !Object.hasOwn(CHROME_ACTIONS, name)) return undefined
  return CHROME_ACTIONS[name]?.(payload, ctx)
}
