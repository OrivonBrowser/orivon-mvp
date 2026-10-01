import { focusPage, leaveChrome } from '../../focus/pane-cycle.js'
import type { ChromeAction } from '../chrome-actions.js'

/** `{ direction: 1 | -1 }`: the chrome's keyboard stepped past its first or last pane, so the next pane outside it
 * takes the keyboard. `{ to: 'page' }`: Escape in a chrome pane gives it back to the page. A page can only ask
 * for focus to move, never where: the destinations are main's. */
export const paneLeave: ChromeAction = (payload, ctx) => {
  const { direction, to } = (typeof payload === 'object' && payload !== null ? payload : {}) as { direction?: unknown, to?: unknown }
  if (direction === 1 || direction === -1) leaveChrome(ctx, direction)
  else if (to === 'page') focusPage(ctx)
}
