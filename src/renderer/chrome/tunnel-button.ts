import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

export const TUNNEL_BUTTON_LABEL = 'Tunnels'

/** What the button says when the page in front is on a tunnel (`main/route/tunnel-mark.ts`), naming the tunnel when it is known. */
export const TUNNEL_NOTES = {
  on: 'This page goes through your tunnel',
  down: 'Your tunnel is not answering, so this page\'s traffic is stopped'
} as const

const TUNNEL_NOTES_VIA = {
  nym: { on: 'This page goes through Nym', down: 'Nym is not answering, so this page\'s traffic is stopped' },
  socks5: { on: 'This page goes through your proxy', down: 'Your proxy is not answering, so this page\'s traffic is stopped' }
} as const

export function tunnelNote (state: 'on' | 'down', via: 'nym' | 'socks5' | null): string {
  return (via === null ? TUNNEL_NOTES : TUNNEL_NOTES_VIA[via])[state]
}

/** What the button says on a new tab, which shows no page: the tunnel the sites opened in the tab will go through. Your own tunnel is not named. */
export const TAB_TUNNEL_NOTES = {
  on: 'Sites you open in this tab go through your tunnel',
  down: 'Your tunnel is not answering, so this tab\'s traffic is stopped',
  direct: 'Sites you open in this tab go direct'
} as const

const TAB_NOTES_NYM = { on: 'Sites you open in this tab go through Nym', down: 'Nym is not answering, so this tab\'s traffic is stopped' } as const

export function tabTunnelNote (state: 'on' | 'down', via: 'nym' | 'socks5' | null): string {
  return via === 'nym' ? TAB_NOTES_NYM[state] : TAB_TUNNEL_NOTES[state]
}

/** Said after the page's own words when its tab carries the choice, so the person knows the button sets more than this page. */
export const TAB_CHOICE_NOTE = 'Set for this tab'

export interface TunnelButtonLook {
  readonly hidden: boolean
  /** The value of `data-tunnel`, or null for a page that goes direct (the plain pill colour). */
  readonly state: 'on' | 'down' | null
  readonly label: string
}

/** Whether the tab in front has the button: the new tab and every website have it; the shell's own pages and a blank page in a tab that is not the dashboard's (a popup opened with no address) do not. */
function hasButton (tab: TabState | undefined): tab is TabState {
  return tab !== undefined && !tab.isInternal && tab.blankPage !== true
}

/**
 * The words after the page's own, when the button opens the tab's list (`byTab`, from main) and the tunnel the page goes through is
 * the one its tab was told: the person knows the button sets more than this page. A direct tab, a page that goes through a tunnel the
 * tab did not choose (a website's own entry, which a direct choice leaves it), and an app's page or a page in a session an app made
 * for it, which the button opens no list of the tab for, say nothing: the button does not set that tunnel.
 */
function choiceSuffix (tab: TabState, via: ShellState['tunnelVia'], byTab: boolean): string {
  return byTab && tab.tunnelChoice !== undefined && tab.tunnelChoice !== 'direct' && via === tab.tunnelChoice ? `. ${TAB_CHOICE_NOTE}` : ''
}

/**
 * The button for the tab in front: absent on the shell's own pages, grey on a direct page, purple on a tunnelled one. On a new tab
 * it is about the tab, whose sites go where the tab's choice (else the browser's) sends them; on a website in a tab with a choice
 * it still colours the page, and speaks of the tab only when the button is about the tab (`byTab`): that a direct choice sends its sites
 * direct, and that the tunnel the page is on is the one the choice named.
 */
export function tunnelButtonLook (active: TabState | undefined, tunnel: ShellState['tunnel'], via: ShellState['tunnelVia'] = null, byTab = false): TunnelButtonLook {
  if (!hasButton(active)) return { hidden: true, state: null, label: TUNNEL_BUTTON_LABEL }
  const state = tunnel ?? null
  if (active.isNewTab) {
    const note = state === null ? active.tunnelChoice === 'direct' ? TAB_TUNNEL_NOTES.direct : undefined : tabTunnelNote(state, via)
    return { hidden: false, state, label: note === undefined ? TUNNEL_BUTTON_LABEL : `${TUNNEL_BUTTON_LABEL}. ${note}` }
  }
  if (state === null) return { hidden: false, state, label: byTab && active.tunnelChoice === 'direct' ? `${TUNNEL_BUTTON_LABEL}. ${TAB_TUNNEL_NOTES.direct}` : TUNNEL_BUTTON_LABEL }
  return { hidden: false, state, label: `${TUNNEL_BUTTON_LABEL}. ${tunnelNote(state, via)}${choiceSuffix(active, via, byTab)}` }
}

/** The tunnel button in the address pill: it opens the tunnels page of the site-info popup, anchored to itself. Its colour is the page's
 * tunnel state (a new tab's, the tunnel its first address will leave by). On a new tab it sends no address: main sees the tab has none
 * and opens the popup for the tab. Press-then-click is handled as the shield's is (`site-badges.ts`). */
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
        if (!hasButton(active)) return
        if (active.isNewTab) ctx.shell.openSiteInfo(ctx.anchorFor(el), 'tunnels')
        else ctx.shell.openSiteInfo(ctx.anchorFor(el), 'tunnels', active.url)
      })
    },
    render: (state, ctx) => {
      if (button === undefined) return
      const look = tunnelButtonLook(ctx.activeTab(), state.tunnel, state.tunnelVia, state.tunnelByTab)
      button.hidden = look.hidden
      if (look.state === null) button.removeAttribute('data-tunnel')
      else button.setAttribute('data-tunnel', look.state)
      button.title = look.label
      button.setAttribute('aria-label', look.label)
    }
  }
}
