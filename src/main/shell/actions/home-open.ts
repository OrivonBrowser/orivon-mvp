import type { ChromeAction } from '../chrome-actions.js'
import { goHome } from '../home.js'

/** `{ newTab }`: the Home button's click (false) or its middle or Mod click (true). */
export const homeOpen: ChromeAction = (payload, { window, services }) => {
  const newTab = (payload as { newTab?: unknown } | null)?.newTab
  if (typeof newTab !== 'boolean') return
  goHome(window.tabs, services.settings, { newTab })
}
