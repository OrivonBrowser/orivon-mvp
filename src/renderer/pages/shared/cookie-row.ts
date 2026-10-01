// One cookie as a row, for the site-info popover and the Settings list: its name, where it applies and when it
// goes, its flags, and a button that deletes it. The name and the domain are text a website chose, so they go in
// as text, never as markup. A page styles `.cookie-row` itself: this only builds the elements.
import type { CookieView } from '../../../main/privacy/cookie-list.js'
import { h } from './dom.js'
import { trashIcon } from './icons.js'
import { cookieMeta, flagsOf, shownOf } from './cookie-text.js'

export function cookieRow (cookie: CookieView, onRemove: (key: string) => void): HTMLElement {
  const label = `Delete cookie ${cookie.name}`
  const remove = h('button', { className: 'btn icon icon-btn', type: 'button', title: label, onclick: () => { onRemove(cookie.key) } }, trashIcon())
  remove.setAttribute('aria-label', label)
  return h('li', { className: 'cookie-row' },
    h('span', { className: 'cookie-text' },
      h('span', { className: 'cookie-name', textContent: cookie.name, title: cookie.name }),
      h('span', { className: 'cookie-meta' },
        h('span', { className: 'cookie-where', textContent: cookieMeta(cookie) }),
        ...flagsOf(cookie).map((flag) => h('span', { className: 'badge', textContent: flag })))),
    remove)
}

/** The rows of a list, and "and 12 more" after the first fifty. */
export function cookieRows (cookies: readonly CookieView[], onRemove: (key: string) => void): HTMLElement[] {
  const { shown, more } = shownOf(cookies)
  return [...shown.map((cookie) => cookieRow(cookie, onRemove)), ...(more === null ? [] : [h('li', { className: 'cookie-more', textContent: more })])]
}
