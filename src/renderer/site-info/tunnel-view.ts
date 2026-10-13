import type { SiteRoute, SiteTunnel } from '../../main/permissions/site-info.js'
import type { NymState } from '../../main/route/nym-status.js'
import { createSwitch } from './switch.js'
import { renderRouteLine } from './route-line.js'

// The switch that sends a website's traffic through the person's tunnel, with the line that says what it does and, the
// first time a website would move into storage of its own, the notice that comes before it. The words are composed
// here, never from anything a site wrote.

export const TUNNEL_SWITCH_LABEL = 'Use the tunnel for this site'

/** Shown before a website first moves into storage of its own: Confirm turns the tunnel on, Cancel leaves everything as it was. */
export const STORAGE_NOTICE = 'This site gets its own storage. You\'ll sign in to it again once, and what it stores stays apart from the rest of your browsing.'

/** Why the switch is fixed, or what it leaves outside the tunnel; one sentence, or undefined when there is nothing to add. */
export function tunnelHint (tunnel: SiteTunnel): string | undefined {
  if (tunnel.unreadable) return 'Orivon could not read your tunnel settings, so while a tunnel is set every site goes through it. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'
  if (tunnel.blocked === 'no-proxy' && !tunnel.on) return 'Set a tunnel under Privacy and data first.'
  if (tunnel.web3 && !tunnel.on) return 'A Web3 name\'s own files come from Orivon itself and stay outside the tunnel for now.'
  return undefined
}

/** Extensions load into the shared session, so one that reaches this site stops working on it while it has storage of its own. */
export function extensionsHint (names: readonly string[]): string | undefined {
  return names.length === 0 ? undefined : `Extensions do not run on a site that goes through the tunnel: ${names.join(', ')}.`
}

export const TUNNEL_FAILED = 'The tunnel could not be changed for this site.'

export interface TunnelCallbacks {
  readonly onToggle: (next: boolean) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export interface TunnelViewState {
  /** The notice is open: the person moved the switch on and has not yet confirmed. */
  readonly notice: boolean
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
  const shownOn = tunnel.on || view.notice
  const control = createSwitch(shownOn, tunnel.unreadable || (!tunnel.on && tunnel.blocked !== undefined), callbacks.onToggle)
  control.id = 'tunnel-switch'
  control.setAttribute('aria-label', TUNNEL_SWITCH_LABEL)
  row.append(label, control)
  section.append(row)

  const hint = tunnelHint(tunnel)
  if (hint !== undefined) section.append(paragraph(tunnel.unreadable || tunnel.blocked !== undefined ? 'route-line route-line-down' : 'route-line', hint))
  if (tunnel.on && route !== undefined) section.append(renderRouteLine(route, tunnel.web3 ? 'web3' : 'site', nym))
  const loses = extensionsHint(extensions)
  if (loses !== undefined) section.append(paragraph('route-line', loses))
  if (view.failed) section.append(paragraph('route-line route-line-down', TUNNEL_FAILED))

  if (view.notice) {
    const notice = document.createElement('div')
    notice.className = 'tunnel-notice'
    notice.setAttribute('role', 'alertdialog')
    notice.append(paragraph('tunnel-notice-text', STORAGE_NOTICE))
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
