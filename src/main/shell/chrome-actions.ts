import { overlayClose, overlayToggle } from './actions/overlay.js'
import type { WindowContext } from './window-context.js'

/** A call from the chrome that carries arguments and is not a command. `payload` comes from a renderer:
 * validate every field before using it. */
export type ChromeAction = (payload: unknown, ctx: WindowContext) => unknown

/** One entry per action, alphabetical by name. */
export const CHROME_ACTIONS: Readonly<Record<string, ChromeAction>> = {
  'overlay.close': overlayClose,
  'overlay.toggle': overlayToggle
}

/** Runs the action called `name`. Own keys only: `constructor` or `__proto__` from a renderer must not
 * reach a member of Object.prototype. An unknown name does nothing. */
export function runChromeAction (name: unknown, payload: unknown, ctx: WindowContext): unknown {
  if (typeof name !== 'string' || !Object.hasOwn(CHROME_ACTIONS, name)) return undefined
  return CHROME_ACTIONS[name]?.(payload, ctx)
}
