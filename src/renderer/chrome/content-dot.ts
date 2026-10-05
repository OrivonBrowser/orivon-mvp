import type { ChromeModule } from './context.js'

export const CONTENT_BLOCKED_NOTE = 'JavaScript, images or sound are blocked on this site'
export const UPDATE_OFFERED_NOTE = 'A new version of this app is available'

/** Marks the address bar's key when the site in front has JavaScript, images or sound switched off (a dot after
 * the key), or is an installed app with a new version offered (a dot before it). The key is `site-badges`'s own
 * button: this only sets attributes on it, so the two never fight over its label. */
export function createContentDot (): ChromeModule {
  let key: HTMLElement | null = null
  return {
    name: 'content-dot',
    init: () => { key = document.getElementById('site-permissions-btn') },
    render: (state) => {
      if (key === null) return
      const notes = [
        ...(state.contentBlocked ? [CONTENT_BLOCKED_NOTE] : []),
        ...(state.updateOffered ? [UPDATE_OFFERED_NOTE] : [])
      ]
      if (state.contentBlocked) key.setAttribute('data-content-blocked', '')
      else key.removeAttribute('data-content-blocked')
      if (state.updateOffered) key.setAttribute('data-update-offered', '')
      else key.removeAttribute('data-update-offered')
      if (notes.length > 0) key.setAttribute('aria-description', notes.join('. '))
      else key.removeAttribute('aria-description')
    }
  }
}
