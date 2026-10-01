import type { ChromeAction } from '../chrome-actions.js'
import { toggleMute } from '../tab-commands.js'

/** `{ id }`: switches that tab's sound off, or back on. Sent by the speaker badge on a tab; the id is the chrome's,
 * so it must name a tab this window holds. */
export const tabMute: ChromeAction = (payload, { window }) => {
  const id = (payload as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !window.tabs.ids().includes(id)) return
  toggleMute(window.tabs, id)
}
