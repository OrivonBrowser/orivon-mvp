import type { SiteRoute, SiteTunnel } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { createSwitch } from './switch.js'
import { renderRouteLine } from './route-line.js'

// The switch that sends a website's traffic through the person's tunnel, with the line that says what it does and, the
// first time a website would move into storage of its own, the notice that comes before it. The words are composed
// here, never from anything a site wrote.

export const TUNNEL_SWITCH_LABEL = 'Use the tunnel for this site'

/** Shown before a website first moves into a profile: Confirm makes the change, Cancel leaves everything as it was. */
export function storageNotice (profile: 'tunnel' | 'direct'): string {
  return `This site moves to your ${profile} profile. You'll sign in to it again once, and what it stores stays apart from your normal browsing.`
}

/** Why the switch is fixed, or what it leaves outside the tunnel; one sentence, or undefined when there is nothing to add. */
export function tunnelHint (tunnel: SiteTunnel): string | undefined {
  if (tunnel.unreadable) return 'Orivon could not read your tunnel settings, so while a tunnel is set every site goes through it. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'
  if (tunnel.blocked === 'no-proxy' && !tunnel.on) return 'Set a tunnel under Privacy and data first.'
  if (tunnel.web3 && !tunnel.on) return 'A Web3 name\'s own files come from Orivon itself and stay outside the tunnel for now.'
  return undefined
}

/** The person's extensions run in a profile too, as far as Electron's own extension support goes; the rest stays in the default session. */
export function extensionsHint (names: readonly string[], profile: 'tunnel' | 'direct' | undefined): string | undefined {
  if (profile === undefined || names.length === 0) return undefined
  return `Your extensions run in the ${profile} profile too: ${names.join(', ')}. Their toolbar buttons and popups, and any blocker that works through the browser's request API, stay with your normal browsing.`
}

export const TUNNEL_FAILED = 'The tunnel could not be changed for this site.'

export interface TunnelCallbacks {
  readonly onToggle: (next: boolean) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export interface TunnelViewState {
  /** The notice is open, about this profile: the person moved the switch and has not yet confirmed. */
  readonly notice: 'tunnel' | 'direct' | null
  /** The state the switch was moved to while the notice is open. */
  readonly next: boolean | null
  /** The last change did not take. */
  readonly failed: boolean
}

function paragraph (className: string, text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

/** The switch row, its explanation, the status line of a site that is on, and the notice while it is open. */
export function renderTunnelSection (container: HTMLElement, tunnel: SiteTunnel, route: SiteRoute | undefined, extensions: readonly string[], view: TunnelViewState, callbacks: TunnelCallbacks, nym?: NymState): void {
  const section = document.createElement('div')
  section.className = 'tunnel-section'

  const row = document.createElement('div')
  row.className = 'tunnel-row'
  const label = document.createElement('span')
  label.className = 'tunnel-label'
  label.textContent = TUNNEL_SWITCH_LABEL
  const shownOn = view.next ?? tunnel.on
  const control = createSwitch(shownOn, tunnel.unreadable || (!tunnel.on && tunnel.blocked !== undefined), callbacks.onToggle)
  control.id = 'tunnel-switch'
  control.setAttribute('aria-label', TUNNEL_SWITCH_LABEL)
  row.append(label, control)
  section.append(row)

  const hint = tunnelHint(tunnel)
  if (hint !== undefined) section.append(paragraph(tunnel.unreadable || tunnel.blocked !== undefined ? 'route-line route-line-down' : 'route-line', hint))
  if (tunnel.on && route !== undefined) section.append(renderRouteLine(route, tunnel.web3 ? 'web3' : 'site', nym))
  const reach = extensionsHint(extensions, tunnel.profile)
  if (reach !== undefined) section.append(paragraph('route-line', reach))
  if (view.failed) section.append(paragraph('route-line route-line-down', TUNNEL_FAILED))

  if (view.notice !== null) {
    const notice = document.createElement('div')
    notice.className = 'tunnel-notice'
    notice.setAttribute('role', 'alertdialog')
    notice.append(paragraph('tunnel-notice-text', storageNotice(view.notice)))
    const buttons = document.createElement('div')
    buttons.className = 'staged-buttons'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.id = 'tunnel-notice-cancel'
    cancel.className = 'btn-secondary'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', callbacks.onCancel)
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.id = 'tunnel-notice-confirm'
    confirm.className = 'btn-primary'
    confirm.textContent = 'Confirm'
    confirm.addEventListener('click', callbacks.onConfirm)
    buttons.append(cancel, confirm)
    notice.append(buttons)
    section.append(notice)
  }

  container.append(section)
}
