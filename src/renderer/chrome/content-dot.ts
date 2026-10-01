import type { ChromeModule } from './context.js'

export const CONTENT_BLOCKED_NOTE = 'JavaScript, images or sound are blocked on this site'

/** Marks the address bar's key when the site in front has JavaScript, images or sound switched off. The key is
 * `site-badges`'s own button: this only sets an attribute on it, so the two never fight over its label. */
export function createContentDot (): ChromeModule {
  let key: HTMLElement | null = null
  return {
    name: 'content-dot',
    init: () => { key = document.getElementById('site-permissions-btn') },
    render: (state) => {
      if (key === null) return
      if (state.contentBlocked) {
        key.setAttribute('data-content-blocked', '')
        key.setAttribute('aria-description', CONTENT_BLOCKED_NOTE)
      } else {
        key.removeAttribute('data-content-blocked')
        key.removeAttribute('aria-description')
      }
    }
  }
}
