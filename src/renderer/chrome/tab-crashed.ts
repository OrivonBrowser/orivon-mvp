import { warningIcon } from '../pages/shared/icons.js'
import type { TabDecorator } from './context.js'

/** A tab whose page died: the warning shape replaces its icon, so the state is not told by colour alone, and the
 * tooltip and the accessible name say so. The title stays. Runs after the tooltip is set, so the line is appended. */
export const decorateTabCrashed: TabDecorator = function decorateTabCrashed (el, tab) {
  if (tab.crashed === null) return
  el.classList.add('crashed')
  const fav = el.querySelector('.fav')
  if (fav !== null) {
    fav.classList.remove('loading', 'newtab')
    fav.replaceChildren(warningIcon())
  }
  el.title = el.title === '' ? 'This tab crashed' : `${el.title}\nThis tab crashed`
  el.setAttribute('aria-label', `${tab.title.length > 0 ? tab.title : 'New Tab'}, crashed`)
}
