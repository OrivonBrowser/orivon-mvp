import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeModule } from './context.js'
import { hasSite, must } from './context.js'

export const TUNNEL_BUTTON_LABEL = 'Tunnels'

/** What the button says when the page in front is on a tunnel (`main/route/tunnel-mark.ts`). */
export const TUNNEL_NOTES = {
  on: 'This page goes through your tunnel',
  down: 'Your tunnel is not answering, so this page\'s traffic is stopped'
} as const

export interface TunnelButtonLook {
  readonly hidden: boolean
  /** The value of `data-tunnel`, or null for a page that goes direct (the plain pill colour). */
  readonly state: 'on' | 'down' | null
  readonly label: string
}

/** The button for the tab in front: absent on the new tab and the shell's own pages, grey on a direct page, purple on a tunnelled one. */
export function tunnelButtonLook (active: TabState | undefined, tunnel: ShellState['tunnel']): TunnelButtonLook {
  if (!hasSite(active)) return { hidden: true, state: null, label: TUNNEL_BUTTON_LABEL }
  const state = tunnel ?? null
  return { hidden: false, state, label: state === null ? TUNNEL_BUTTON_LABEL : `${TUNNEL_BUTTON_LABEL}. ${TUNNEL_NOTES[state]}` }
}

/** The tunnel button in the address pill: it opens the tunnels page of the site-info popup, anchored to itself. Its colour is the page's
 * tunnel state. Press-then-click is handled as the shield's is (`site-badges.ts`). */
export function createTunnelButton (): ChromeModule {
  let button: HTMLButtonElement | undefined
  return {
    name: 'tunnel-button',
    init: (ctx) => {
      const el = must(document.querySelector<HTMLButtonElement>('#tunnel-btn'), '#tunnel-btn missing')
      button = el
      el.addEventListener('pointerdown', (event) => { if (event.button === 0) ctx.shell.press('tunnels') })
      el.addEventListener('click', () => {
        const active = ctx.activeTab()
        if (!hasSite(active)) return
        ctx.shell.openSiteInfo(ctx.anchorFor(el), 'tunnels', active.url)
      })
    },
    render: (state, ctx) => {
      if (button === undefined) return
      const look = tunnelButtonLook(ctx.activeTab(), state.tunnel)
      button.hidden = look.hidden
      if (look.state === null) button.removeAttribute('data-tunnel')
      else button.setAttribute('data-tunnel', look.state)
      button.title = look.label
      button.setAttribute('aria-label', look.label)
    }
  }
}
