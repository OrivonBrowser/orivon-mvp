import type { TabDecorator } from './context.js'

/** A tab whose page is not loaded: the strip dims its icon and rings it, and the tooltip and the accessible name
 * say so, so the state is not told by the look alone. Runs after the tooltip and the name are set, so it adds to them. */
export const decorateTabSleeping: TabDecorator = function decorateTabSleeping (el, tab) {
  if (tab.sleeping !== true) return
  el.classList.add('sleeping')
  el.title = `${el.title}, sleeping`
  el.setAttribute('aria-label', `${el.getAttribute('aria-label') ?? (tab.title.length > 0 ? tab.title : 'New tab')}, sleeping`)
}
