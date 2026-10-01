// The "Permissions" section of the site-info popover: one row per kind the site has an answer for or asked about,
// each with a select that changes it at once, and "Add a permission" for the rest. Text only ever goes in as text,
// and every label comes from main's table of kinds.
import type { SiteKind } from '../../main/site-settings/kinds.js'
import type { SiteKindRow } from '../../main/site-settings/site-settings-controller.js'
import type { SitePermissionsView } from '../../main/site-settings/site-permissions-view.js'
import { h } from '../pages/shared/dom.js'
import { SITE_KIND_ICONS } from '../pages/shared/site-kind-icons.js'
import { chevronIcon } from './icons.js'
import { splitRows } from './permissions-model.js'

export interface PermissionsModel {
  readonly view: SitePermissionsView
  /** Kinds the person changed in this visit. */
  readonly touched: ReadonlySet<SiteKind>
  readonly moreOpen: boolean
  /** An answer changed: the page in front still runs on the old one until it reloads. */
  readonly changed: boolean
}

export interface PermissionsCallbacks {
  readonly onChoose: (kind: SiteKind, value: string) => void
  readonly onToggleMore: () => void
  readonly onReload: () => void
}

/** The kind whose select had the keyboard when the section was last drawn, so it keeps it across the redraw. */
let focusKind: SiteKind | null = null

function permissionRow (row: SiteKindRow, callbacks: PermissionsCallbacks): HTMLElement {
  const icon = SITE_KIND_ICONS[row.kind]()
  icon.classList.add('grant-icon')
  const select = h('select', { className: 'perm-select' })
  for (const option of row.options) select.append(h('option', { value: option.value, textContent: option.label }))
  select.value = row.value
  select.dataset['kind'] = row.kind
  select.setAttribute('aria-label', `${row.label} for this site`)
  select.addEventListener('change', () => {
    focusKind = row.kind
    callbacks.onChoose(row.kind, select.value)
  })
  if (focusKind === row.kind) queueMicrotask(() => { select.focus(); focusKind = null })
  return h('li', { className: 'row perm-row' }, icon, h('span', { className: 'row-message', textContent: row.label }), h('span', { className: 'select-wrap' }, select, chevronIcon()))
}

function rowList (rows: readonly SiteKindRow[], callbacks: PermissionsCallbacks, className = 'row-list'): HTMLElement {
  return h('ul', { className }, ...rows.map((row) => permissionRow(row, callbacks)))
}

export function renderSitePermissions (model: PermissionsModel, callbacks: PermissionsCallbacks): HTMLElement {
  const { listed, more } = splitRows(model.view, model.touched)
  const section = h('section', { className: 'permissions' }, h('p', { className: 'section-heading', textContent: 'Permissions' }))
  section.setAttribute('aria-label', 'Permissions')
  if (listed.length === 0) section.append(h('p', { className: 'empty-state', textContent: 'This site has not asked for anything.' }))
  else section.append(rowList(listed, callbacks))
  if (more.length > 0) {
    const toggle = h('button', { type: 'button', className: `nav-row add-permission${model.moreOpen ? ' open' : ''}`, onclick: callbacks.onToggleMore }, h('span', { textContent: 'Add a permission…' }), chevronIcon())
    toggle.setAttribute('aria-expanded', String(model.moreOpen))
    section.append(toggle)
    if (model.moreOpen) section.append(rowList(more, callbacks, 'row-list more-list'))
  }
  if (model.changed) {
    section.append(h('div', { className: 'reload-banner', role: 'status' },
      h('span', { textContent: 'Reload the page to apply your changes.' }),
      h('button', { type: 'button', className: 'btn-secondary', textContent: 'Reload', onclick: callbacks.onReload })))
  }
  if (model.view.isPrivate) section.append(h('p', { className: 'empty-state', textContent: 'Forgotten when this private window closes.' }))
  return section
}
