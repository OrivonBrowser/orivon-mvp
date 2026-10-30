import type { SiteInfo, SiteTunnel, SiteTunnelKind, SiteTunnelProfile } from '../../main/permissions/site-info.js'
import { createSwitch } from './switch.js'
import { tunnelIcon } from './icons.js'
import { TAB_TUNNEL_FAILED } from './tab-words.js'
import { ADDRESS_PROBLEM, SETTINGS_LINK } from './tunnels-model.js'
import type { AddressModel, TunnelListModel, TunnelRowModel } from './tunnels-model.js'
import { BROWSER_FAILED } from './browser-wide-model.js'
import type { Panel } from './browser-wide-model.js'
import { renderNodes, renderPanelTabs, renderPrompt } from './browser-wide-view.js'
import type { PanelNames } from './browser-wide-view.js'

// The tunnels page of the site-info popup: a row for each tunnel with the switch that sends this website, app or tab (or, on the
// Browser-wide panel, the whole browser) through it (turning one on turns the other off, turning the lit one off sends the page
// through none), the line that says what that does and, the first time a website would move into storage of its own, the notice
// that comes before it. The rows are `tunnels-model.ts`'s. The words are composed here, never from anything a site wrote.

export const TUNNEL_PAGE_TITLE = 'Tunnels'

export const SWARM_HINT = 'Swarm content loads only from the Swarm node Orivon runs on this computer, which cannot go through your tunnel, so this address does not open while the tunnel is on for it.'

/** What a profile is called to the person: both tunnels' profiles are "the tunnel profile", whichever tunnel it is. */
const PROFILE_WORDS: Readonly<Record<SiteTunnelProfile, string>> = { nym: 'tunnel', socks5: 'tunnel', direct: 'direct' }

/** Shown before a website first moves into a profile: Confirm makes the change, Cancel leaves everything as it was. */
export function storageNotice (profile: SiteTunnelProfile): string {
  return `This site moves to your ${PROFILE_WORDS[profile]} profile. You'll sign in to it again once, and what it stores stays apart from your normal browsing.`
}

export const UNREADABLE_HINT = 'Orivon could not read your tunnel settings, so every site goes through your default tunnel, or through Nym when that has no address. Mend or remove routes.json in your profile folder and restart Orivon to choose again.'

/** Why the switch is fixed, or what it leaves outside the tunnel; one sentence, or undefined when there is nothing to add. */
export function tunnelHint (tunnel: SiteTunnel): string | undefined {
  if (tunnel.unreadable) return UNREADABLE_HINT
  if (tunnel.swarm) return SWARM_HINT
  return undefined
}

/**
 * The person's extensions run in a profile too, with their toolbar buttons, popups and request blockers. What a profile does not
 * give them is said here: a side panel and a keyboard shortcut work in the normal browsing only, each profile keeps the settings
 * of its own copy, and the direct profile's copies run only while one of its sites is open.
 */
export function extensionsHint (names: readonly string[], profile: SiteTunnelProfile | undefined): string | undefined {
  if (profile === undefined || names.length === 0) return undefined
  const when = profile === 'direct' ? ' They run only while a site of this profile is open.' : ''
  return `Your extensions run in the ${PROFILE_WORDS[profile]} profile too: ${names.join(', ')}.${when} Each profile keeps its own settings for them, and their side panels and keyboard shortcuts work only in your normal browsing.`
}

export const TUNNEL_FAILED = 'The tunnel could not be changed for this site.'

export interface TunnelCallbacks {
  /** A switch was moved: `next` is the position of the switch of `kind`. */
  readonly onToggle: (kind: SiteTunnelKind, next: boolean) => void
  /** The address field changed: the page keeps the text so a redraw puts it back. */
  readonly onAddressInput: (text: string) => void
  /** Save was pressed with this text. */
  readonly onSaveAddress: (text: string) => void
  /** Change was pressed: the field opens with the saved address. */
  readonly onChangeAddress: () => void
  /** The question before an address others use is changed was answered. */
  readonly onConfirmAddress: () => void
  readonly onCancelAddress: () => void
  /** Test was pressed on the row of this tunnel. */
  readonly onTest: (kind: SiteTunnelKind) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  /** A link to Settings > Tunnels; `everywhere` lands on the browser-wide switch. */
  readonly onOpenSettings: (everywhere: boolean) => void
  /** A panel was chosen. */
  readonly onPanel: (panel: Panel) => void
  /** The nodes switch was moved: `next` is its position. */
  readonly onNodes: (next: boolean) => void
}

export interface TunnelViewState {
  /** The notice is open, about this profile: the person moved a switch and has not yet confirmed. */
  readonly notice: SiteTunnelProfile | null
  /** The tunnel the switches were moved to while the notice is open (null: none), undefined while it is not. */
  readonly pending: SiteTunnelKind | null | undefined
  /** The last change did not take. */
  readonly failed: boolean
  /** The panel drawn. */
  readonly panel: Panel
  /** The names of the two panels, or null while there is nothing to choose between (routes are not running). */
  readonly panels: PanelNames | null
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

function button (id: string, className: string, text: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.id = id
  el.className = className
  el.textContent = text
  el.addEventListener('click', onClick)
  return el
}

/** The proxy row's address: the field and Save while none is saved or Change was pressed, else the address and Change; and the question before a change others feel. */
function renderAddress (address: AddressModel, callbacks: TunnelCallbacks): HTMLElement {
  const box = document.createElement('div')
  box.className = 'tunnel-address'
  if (address.confirm !== null) {
    const asking = document.createElement('div')
    asking.className = 'tunnel-notice'
    asking.setAttribute('role', 'alertdialog')
    asking.append(paragraph('tunnel-notice-text', address.confirm))
    const buttons = document.createElement('div')
    buttons.className = 'staged-buttons'
    buttons.append(button('tunnel-proxy-cancel', 'btn-secondary', 'Cancel', callbacks.onCancelAddress), button('tunnel-proxy-confirm', 'btn-primary', 'Confirm', callbacks.onConfirmAddress))
    asking.append(buttons)
    box.append(asking)
    return box
  }
  if (!address.editing) {
    box.append(paragraph('route-line', `Address: ${address.saved}`), link('tunnel-proxy-change', 'Change', callbacks.onChangeAddress))
    return box
  }
  const field = document.createElement('input')
  field.type = 'text'
  field.id = 'tunnel-proxy-address'
  field.className = 'tunnel-address-field'
  field.placeholder = '127.0.0.1:9050'
  field.value = address.text
  field.setAttribute('aria-label', 'Address of your proxy')
  field.setAttribute('autocomplete', 'off')
  field.spellcheck = false
  field.addEventListener('input', () => { callbacks.onAddressInput(field.value) })
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') callbacks.onSaveAddress(field.value) })
  const save = button('tunnel-proxy-save', 'btn-secondary', 'Save', () => { callbacks.onSaveAddress(field.value) })
  const line = document.createElement('div')
  line.className = 'tunnel-address-line'
  const label = document.createElement('label')
  label.htmlFor = field.id
  label.className = 'tunnel-address-label'
  label.textContent = 'Address'
  line.append(label, field, save)
  box.append(line)
  if (address.error !== null) {
    const problem = paragraph('route-line route-line-down', address.error === ADDRESS_PROBLEM ? ADDRESS_PROBLEM : address.error)
    problem.setAttribute('role', 'alert')
    box.append(problem)
  }
  return box
}

function renderRow (row: TunnelRowModel, scope: string, callbacks: TunnelCallbacks): HTMLElement {
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
  control.setAttribute('aria-label', `Use ${row.kind.who} for ${scope}`)
  el.append(renderLogo(row), text, control)
  return el
}

/** The page: the title, the two panels to choose between, the row of each tunnel, what else the person should know, the question while it is open, and the link to Settings. */
export function renderTunnelsPage (container: HTMLElement, info: SiteInfo, model: TunnelListModel, view: TunnelViewState, callbacks: TunnelCallbacks): void {
  container.replaceChildren()
  const header = document.createElement('header')
  header.className = 'site-header'
  const title = document.createElement('div')
  title.className = 'site-origin'
  title.textContent = TUNNEL_PAGE_TITLE
  header.append(title)
  // A tab is its own name on the first panel; a website or an app is named under the title. The whole browser has no name to give.
  if (view.panel === 'first' && info.tunnel?.subject !== 'tab') {
    const origin = document.createElement('div')
    origin.className = 'site-claim'
    origin.textContent = info.displayOrigin
    header.append(origin)
  }
  container.append(header)
  if (view.panels !== null) container.append(renderPanelTabs(view.panel, view.panels, callbacks.onPanel))

  const section = document.createElement('div')
  section.className = 'tunnel-section'
  section.id = 'tunnel-panel'
  section.setAttribute('role', 'tabpanel')
  if (view.panels !== null) section.setAttribute('aria-labelledby', `tunnel-tab-${view.panel}`)
  const noun = info.tunnel?.subject ?? 'site'
  const scope = view.panel === 'browser' ? 'the whole browser' : `this ${noun}`
  for (const row of model.rows) {
    section.append(renderRow(row, scope, callbacks))
    if (row.address !== null) section.append(renderAddress(row.address, callbacks))
    if (row.canTest) section.append(button(`tunnel-test-${row.kind.id}`, 'link-button', row.testLine?.busy === true ? 'Testing…' : 'Test', () => { callbacks.onTest(row.kind.id) }))
    if (row.testLine !== null) {
      const answer = paragraph(row.testLine.down ? 'route-line route-line-down' : 'route-line', row.testLine.text)
      answer.id = `tunnel-test-result-${row.kind.id}`
      answer.setAttribute('role', row.testLine.down ? 'alert' : 'status')
      section.append(answer)
    }
    if (row.settingsLink !== null) section.append(link(`tunnel-settings-link-${row.kind.id}`, row.settingsLink, () => { callbacks.onOpenSettings(false) }))
  }
  if (model.nodes !== null) section.append(renderNodes(model.nodes, callbacks.onNodes))
  for (const note of model.notes) section.append(paragraph(note.down ? 'route-line route-line-down' : 'route-line', note.text))
  if (model.empty !== null) section.append(paragraph('route-line', model.empty))
  if (view.failed) section.append(paragraph('route-line route-line-down', view.panel === 'browser' ? BROWSER_FAILED : noun === 'tab' ? TAB_TUNNEL_FAILED : TUNNEL_FAILED))

  if (view.notice !== null) {
    const notice = document.createElement('div')
    notice.className = 'tunnel-notice'
    notice.setAttribute('role', 'alertdialog')
    notice.append(paragraph('tunnel-notice-text', storageNotice(view.notice)))
    const buttons = document.createElement('div')
    buttons.className = 'staged-buttons'
    buttons.append(button('tunnel-notice-cancel', 'btn-secondary', 'Cancel', callbacks.onCancel), button('tunnel-notice-confirm', 'btn-primary', 'Confirm', callbacks.onConfirm))
    notice.append(buttons)
    section.append(notice)
  }
  if (model.prompt !== null) section.append(renderPrompt(model.prompt, callbacks.onCancel, callbacks.onConfirm))
  container.append(section)

  container.append(document.createElement('hr'))
  const hint = document.createElement('div')
  hint.className = 'tunnel-hint'
  if (model.hint.text !== '') hint.append(paragraph('route-line', model.hint.text))
  hint.append(link('tunnel-settings-open', SETTINGS_LINK, () => { callbacks.onOpenSettings(view.panel === 'browser') }))
  container.append(hint)
}
