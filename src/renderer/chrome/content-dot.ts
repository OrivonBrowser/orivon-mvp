import type { ChromeModule } from './context.js'

export const CONTENT_BLOCKED_NOTE = 'JavaScript, images or sound are blocked on this site'
export const UPDATE_OFFERED_NOTE = 'A new version of this app is available'

/** What the key says when the page in front is on the tunnel (`main/route/tunnel-mark.ts`). */
export const TUNNEL_NOTES = {
  on: 'This page goes through your tunnel',
  partial: 'Part of this page goes through your tunnel',
  down: 'Your tunnel is not answering, so this page\'s traffic is stopped'
} as const

/** Marks the address bar's key when the site in front has JavaScript, images or sound switched off (a dot after
 * the key), is an installed app with a new version offered (a dot before it), or goes through the tunnel (the key's
 * colour: `data-tunnel`). The key is `site-badges`'s own
 * button: this only sets attributes on it, so the two never fight over its label. */
export function createContentDot (): ChromeModule {
  let key: HTMLElement | null = null
  return {
    name: 'content-dot',
    init: () => { key = document.getElementById('site-permissions-btn') },
    render: (state) => {
      if (key === null) return
      const tunnel = state.tunnel ?? null
      const notes = [
        ...(state.contentBlocked ? [CONTENT_BLOCKED_NOTE] : []),
        ...(state.updateOffered ? [UPDATE_OFFERED_NOTE] : []),
        ...(tunnel === null ? [] : [TUNNEL_NOTES[tunnel]])
      ]
      if (tunnel === null) key.removeAttribute('data-tunnel')
      else key.setAttribute('data-tunnel', tunnel)
      if (state.contentBlocked) key.setAttribute('data-content-blocked', '')
      else key.removeAttribute('data-content-blocked')
      if (state.updateOffered) key.setAttribute('data-update-offered', '')
      else key.removeAttribute('data-update-offered')
      if (notes.length > 0) key.setAttribute('aria-description', notes.join('. '))
      else key.removeAttribute('aria-description')
    }
  }
}
