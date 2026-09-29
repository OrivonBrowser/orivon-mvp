// Renders the extensions page from its state: nothing here calls the
// bridge directly, and nothing in state.ts touches the DOM.
import { h, replaceChildren } from '../shared/dom.js'
import type { ExtensionDetails, ExtensionRow, ExtensionsState } from './state.js'

function detailRow (label: string, value: string): HTMLElement {
  return h('div', { className: 'detail-row' },
    h('span', { className: 'detail-label', textContent: label }),
    h('span', { className: 'detail-value', textContent: value }))
}

function detailsPanel (state: ExtensionsState, ext: ExtensionRow): HTMLElement {
  const details = state.details.get(ext.id)
  if (details === undefined) return h('div', { className: 'ext-details' }, h('p', { className: 'muted', textContent: 'Loading…' }))

  const rows: HTMLElement[] = [
    detailRow('Id', details.id),
    detailRow('Source', details.source),
    detailRow('Updates', details.updates)
  ]
  if (details.siteAccess !== undefined) rows.push(detailRow('Site access', details.siteAccess))
  rows.push(detailRow('Where it runs', details.whereItRuns))

  const stripped: ExtensionDetails['stripped'] = details.stripped
  const strippedBlock = stripped.length === 0 ? null : h('div', { className: 'detail-block' },
    h('span', { className: 'detail-label', textContent: 'What this extension asked for that Orivon does not run yet' }),
    h('ul', { className: 'stripped-list' }, ...stripped.map((line) => h('li', { textContent: line }))))

  const reload = state.developerMode && details.reloadable
    ? h('button', { className: 'btn small', type: 'button', textContent: 'Reload', onclick: () => { void state.reload(ext.id) } })
    : null
  const checkForUpdates = details.isStoreManaged
    ? h('button', { className: 'btn small', type: 'button', textContent: 'Check for updates', onclick: () => { void state.checkForUpdates() } })
    : null
  const update = details.updateAvailable
    ? h('button', { className: 'btn small primary', type: 'button', textContent: 'Update', onclick: () => { void state.updateNow(ext.id) } })
    : null

  return h('div', { className: 'ext-details' }, ...rows, strippedBlock, checkForUpdates, update, reload)
}

function removeButton (state: ExtensionsState, ext: ExtensionRow): HTMLElement {
  const armed = state.armedRemoveId === ext.id
  const button = h('button', {
    className: armed ? 'btn danger small armed' : 'btn danger small',
    type: 'button',
    textContent: armed ? 'Click again to remove' : 'Remove',
    onclick: () => { if (armed) void state.remove(ext.id); else state.armRemove(ext.id) }
  })
  button.setAttribute('aria-label', armed ? `Confirm removing ${ext.name}` : `Remove ${ext.name}`)
  return button
}

function extensionCard (state: ExtensionsState, ext: ExtensionRow): HTMLElement {
  const expanded = state.expandedId === ext.id
  const icon = ext.iconDataUrl === undefined
    ? h('div', { className: 'ext-icon placeholder' })
    : h('img', { className: 'ext-icon', src: ext.iconDataUrl, alt: '' })
  const toggle = h('label', { className: 'switch' },
    h('input', {
      type: 'checkbox',
      checked: ext.enabled,
      onchange: (event) => { void state.setEnabled(ext.id, (event.target as HTMLInputElement).checked) }
    }),
    h('span', { className: 'track' }))
  toggle.querySelector('input')?.setAttribute('aria-label', `Turn ${ext.name} ${ext.enabled ? 'off' : 'on'}`)
  const detailsToggle = h('button', {
    className: 'link-btn',
    type: 'button',
    textContent: expanded ? 'Hide details' : 'Details',
    onclick: () => { void state.toggleExpand(ext.id) }
  })

  const row = h('div', { className: 'ext-row' },
    icon,
    h('div', { className: 'ext-main' },
      h('div', { className: 'ext-name-line' },
        h('strong', { className: 'ext-name', textContent: ext.name }),
        h('span', { className: 'ext-version', textContent: ext.version })),
      ext.description === '' ? null : h('p', { className: 'ext-desc', textContent: ext.description }),
      detailsToggle),
    toggle,
    removeButton(state, ext))

  return h('section', { className: 'ext-card' }, row, expanded ? detailsPanel(state, ext) : null)
}

function header (state: ExtensionsState): HTMLElement {
  const devInput = h('input', {
    type: 'checkbox',
    checked: state.developerMode,
    onchange: (event) => { void state.setDeveloperMode((event.target as HTMLInputElement).checked) }
  })
  devInput.setAttribute('aria-label', 'Developer mode')
  const devToggle = h('label', { className: 'switch' }, devInput, h('span', { className: 'track' }))

  const loadUnpacked = h('button', {
    className: 'btn',
    type: 'button',
    textContent: 'Load unpacked',
    hidden: !state.developerMode,
    onclick: () => { void state.loadUnpacked() }
  })
  const installFile = h('button', {
    className: 'btn primary',
    type: 'button',
    textContent: 'Install from file…',
    onclick: () => { void state.installFromFile() }
  })
  const storeLink = h('a', {
    className: 'link-btn',
    href: 'https://chromewebstore.google.com/category/extensions',
    target: '_blank',
    rel: 'noopener',
    textContent: 'Get more extensions from the Chrome Web Store'
  })

  return h('header', { className: 'head' },
    h('h1', { textContent: 'Extensions' }),
    h('div', { className: 'dev-mode-row' }, h('span', { textContent: 'Developer mode' }), devToggle),
    loadUnpacked,
    installFile,
    storeLink)
}

export function renderPage (state: ExtensionsState): void {
  const root = document.getElementById('app')
  if (root === null) return
  if (!state.loaded) {
    replaceChildren(root, h('main', { className: 'page' }, h('p', { className: 'muted', textContent: 'Loading…' })))
    return
  }
  const banner = state.message === null ? null : h('div', { className: 'banner', role: 'alert' }, h('span', { textContent: state.message }))
  const list = state.rows.length === 0
    ? h('p', { className: 'empty', textContent: 'No extensions installed.' })
    : h('div', { className: 'ext-list' }, ...state.rows.map((ext) => extensionCard(state, ext)))
  replaceChildren(root, h('main', { className: 'page' }, header(state), banner, list))
}
