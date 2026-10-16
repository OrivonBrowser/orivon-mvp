import type { SiteInfo, SiteTunnel, SiteTunnelKind } from '../../main/permissions/site-info.js'
import { createSwitch } from './switch.js'
import { tunnelIcon } from './icons.js'
import type { TunnelListModel, TunnelRowModel } from './tunnels-model.js'

// The tunnels page of the site-info popup: a row for each tunnel with the switch that sends this website or app through it
// (turning one on turns the other off, turning the lit one off sends the page through none), the line that says what that does
// and, the first time a website would move into storage of its own, the notice that comes before it. The rows are
// `tunnels-model.ts`'s. The words are composed here, never from anything a site wrote.

export const TUNNEL_PAGE_TITLE = 'Tunnels'

export const SWARM_HINT = 'Swarm content loads only from the Swarm node Orivon runs on this computer, which cannot go through your tunnel, so this address does not open while the tunnel is on for it.'

/** Shown before a website first moves into a profile: Confirm makes the change, Cancel leaves everything as it was. */
export function storageNotice (profile: 'tunnel' | 'direct'): string {
  return `This site moves to your ${profile} profile. You'll sign in to it again once, and what it stores stays apart from your normal browsing.`
}

/** Why the switch is fixed, or what it leaves outside the tunnel; one sentence, or undefined when there is nothing to add. */
export function tunnelHint (tunnel: SiteTunnel): string | undefined {
  if (tunnel.unreadable) return 'Orivon could not read your tunnel settings, so while a tunnel is set every site goes through it. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'
  if (tunnel.swarm) return SWARM_HINT
  return undefined
}

/**
 * The person's extensions run in a profile too, with their toolbar buttons, popups and request blockers. What a profile does not
 * give them is said here: a side panel and a keyboard shortcut work in the normal browsing only, each profile keeps the settings
 * of its own copy, and the direct profile's copies run only while one of its sites is open.
 */
export function extensionsHint (names: readonly string[], profile: 'tunnel' | 'direct' | undefined): string | undefined {
  if (profile === undefined || names.length === 0) return undefined
  const when = profile === 'direct' ? ' They run only while a site of this profile is open.' : ''
  return `Your extensions run in the ${profile} profile too: ${names.join(', ')}.${when} Each profile keeps its own settings for them, and their side panels and keyboard shortcuts work only in your normal browsing.`
}

export const TUNNEL_FAILED = 'The tunnel could not be changed for this site.'

export interface TunnelCallbacks {
  /** A switch was moved: `next` is the position of the switch of `kind`. */
  readonly onToggle: (kind: SiteTunnelKind, next: boolean) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  /** A link to Settings > Tunnels; `everywhere` lands on the browser-wide switch. */
  readonly onOpenSettings: (everywhere: boolean) => void
}

export interface TunnelViewState {
  /** The notice is open, about this profile: the person moved a switch and has not yet confirmed. */
  readonly notice: 'tunnel' | 'direct' | null
  /** The tunnel the switches were moved to while the notice is open (null: none), undefined while it is not. */
  readonly pending: SiteTunnelKind | null | undefined
  /** The last change did not take. */
  readonly failed: boolean
}

function paragraph (className: string, text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

function link (id: string, text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.id = id
  button.className = 'link-button'
  button.textContent = text
  button.addEventListener('click', onClick)
  return button
}

function renderLogo (row: TunnelRowModel): HTMLElement {
  if (row.kind.logo === null) {
    const holder = document.createElement('span')
    holder.className = 'tunnel-logo tunnel-logo-generic'
    holder.append(tunnelIcon())
    return holder
  }
  const img = document.createElement('img')
  img.className = 'tunnel-logo'
  img.src = row.kind.logo
  img.alt = ''
  img.width = 20
  img.height = 20
  return img
}

function renderRow (row: TunnelRowModel, noun: 'site' | 'app', callbacks: TunnelCallbacks): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tunnel-row'
  el.dataset['tunnel'] = row.kind.id
  const text = document.createElement('span')
  text.className = 'tunnel-text'
  const name = document.createElement('span')
  name.className = 'tunnel-label'
  name.textContent = row.kind.name
  const state = document.createElement('span')
  state.className = row.state.down ? 'tunnel-state tunnel-state-down' : 'tunnel-state'
  state.textContent = row.state.text
  text.append(name, state)
  const control = createSwitch(row.on, row.disabled, (next) => { callbacks.onToggle(row.kind.id, next) })
  control.id = `tunnel-switch-${row.kind.id}`
  control.setAttribute('aria-label', `Use ${row.kind.who} for this ${noun}`)
  el.append(renderLogo(row), text, control)
  return el
}

/** The page: the title, the row of the tunnel in use, what else the person should know, the notice while it is open, and the hint to enforce a tunnel for the whole browser. */
export function renderTunnelsPage (container: HTMLElement, info: SiteInfo, model: TunnelListModel, view: TunnelViewState, callbacks: TunnelCallbacks): void {
  container.replaceChildren()
  const header = document.createElement('header')
  header.className = 'site-header'
  const title = document.createElement('div')
  title.className = 'site-origin'
  title.textContent = TUNNEL_PAGE_TITLE
  const origin = document.createElement('div')
  origin.className = 'site-claim'
  origin.textContent = info.displayOrigin
  header.append(title, origin)
  container.append(header)

  const section = document.createElement('div')
  section.className = 'tunnel-section'
  const noun = info.tunnel?.subject === 'app' ? 'app' : 'site'
  for (const row of model.rows) {
    section.append(renderRow(row, noun, callbacks))
    if (row.settingsLink !== null) section.append(link(`tunnel-settings-link-${row.kind.id}`, row.settingsLink, () => { callbacks.onOpenSettings(false) }))
  }
  for (const note of model.notes) section.append(paragraph(note.down ? 'route-line route-line-down' : 'route-line', note.text))
  if (model.empty !== null) section.append(paragraph('route-line', model.empty))
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

  container.append(document.createElement('hr'))
  const hint = document.createElement('div')
  hint.className = 'tunnel-hint'
  if (model.hint.text !== '') hint.append(paragraph('route-line', model.hint.text))
  hint.append(link('tunnel-enforce', model.hint.link, () => { callbacks.onOpenSettings(model.hint.everywhere) }))
  container.append(hint)
}
