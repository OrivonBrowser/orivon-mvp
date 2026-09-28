// Draws one row and its control. A control changes a setting through the
// state, which asks main; main's answer, not the control, decides what the
// value is.
import { h } from '../shared/dom.js'
import { renderClearData } from './clear-data.js'
import type { Control, Row } from './model.js'
import type { SettingsState } from './state.js'

let controlCount = 0

function choiceOptions (control: Extract<Control, { type: 'choice' }>, state: SettingsState): Array<{ value: string, label: string }> {
  if (control.options !== undefined) return [...control.options]
  const description = state.description(control.key)
  if (description?.kind !== 'enum') return []
  return description.options.map((value) => ({ value, label: description.labels[value] ?? value }))
}

function renderChoice (control: Extract<Control, { type: 'choice' }>, state: SettingsState, id: string): HTMLElement {
  const select = h('select', { className: 'select', id })
  for (const option of choiceOptions(control, state)) select.append(h('option', { value: option.value, textContent: option.label }))
  select.value = String(state.value(control.key))
  select.addEventListener('change', () => { void state.set(control.key, select.value) })
  return select
}

function renderToggle (control: Extract<Control, { type: 'toggle' }>, state: SettingsState, id: string): HTMLElement {
  const input = h('input', { type: 'checkbox', id, checked: state.value(control.key) === true })
  input.addEventListener('change', () => { void state.set(control.key, input.checked) })
  return h('span', { className: 'switch' }, input, h('span', { className: 'track' }))
}

function renderText (control: Extract<Control, { type: 'text' }>, state: SettingsState, id: string): HTMLElement {
  const maxLength = state.description(control.key)?.kind === 'text' ? (state.description(control.key) as { maxLength: number }).maxLength : 2048
  const input = h('input', { className: 'text', type: 'text', id, placeholder: control.placeholder, maxLength, value: String(state.value(control.key) ?? '') })
  const problem = h('p', { className: 'problem', role: 'alert' })
  // Saved when the person is done (Enter or leaving the box), not on every key:
  // a half-typed address is not a value.
  input.addEventListener('change', () => {
    void state.set(control.key, input.value.trim()).then((error) => {
      input.setAttribute('aria-invalid', error === null ? 'false' : 'true')
      problem.textContent = error === null ? '' : 'That is not an address this can search with. It must start with https:// and contain %s where the search goes.'
    })
  })
  return h('div', { className: 'text-control' }, input, problem)
}

function renderAction (control: Extract<Control, { type: 'action' }>, state: SettingsState): HTMLElement {
  const button = h('button', { className: control.danger === true ? 'btn danger' : 'btn', type: 'button', textContent: control.label })
  let disarm: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    if (control.confirm !== undefined && disarm === undefined) {
      button.textContent = control.confirm
      button.classList.add('armed')
      disarm = setTimeout(() => {
        disarm = undefined
        button.textContent = control.label
        button.classList.remove('armed')
      }, 4000)
      return
    }
    if (disarm !== undefined) clearTimeout(disarm)
    disarm = undefined
    button.textContent = control.label
    button.classList.remove('armed')
    void control.run(state)
  })
  return button
}

function caps (keys: readonly string[]): HTMLElement {
  return h('span', { className: 'keys' }, ...keys.map((key) => h('kbd', { textContent: key })))
}

function renderShortcut (control: Extract<Control, { type: 'shortcut' }>, state: SettingsState): HTMLElement {
  const shortcuts = state.shortcuts
  const shortcut = shortcuts.rows.find((candidate) => candidate.id === control.id)
  if (shortcut === undefined) return h('span')
  const button = (label: string, onclick: () => void, title?: string): HTMLElement =>
    h('button', { className: 'link-btn', type: 'button', textContent: label, title: title ?? '', onclick })
  const mode = shortcuts.modeOf(control.id)

  if (mode.mode === 'recording') {
    return h('div', { className: 'shortcut' },
      h('span', { className: 'listening', textContent: 'Press the new shortcut…', role: 'status' }),
      button('Cancel', () => { void shortcuts.cancel(control.id) }))
  }
  if (mode.mode === 'conflict') {
    return h('div', { className: 'shortcut stacked' },
      h('p', { className: 'problem', role: 'alert', textContent: `That combination already belongs to "${mode.withLabel}".` }),
      h('div', { className: 'shortcut' },
        mode.canSwap ? button('Swap', () => { void shortcuts.swap(control.id) }, `"${mode.withLabel}" gets the keys "${shortcut.label}" has now`) : null,
        button('Cancel', () => { shortcuts.dismiss(control.id) })))
  }
  return h('div', { className: 'shortcut stacked' },
    mode.mode === 'problem' ? h('p', { className: 'problem', role: 'alert', textContent: mode.message }) : null,
    h('div', { className: 'shortcut' },
      shortcut.keys === null ? h('span', { className: 'muted', textContent: 'Not set' }) : caps(shortcut.keys),
      shortcut.aliases.length === 0 ? null : h('span', { className: 'muted also' }, 'Also ', ...shortcut.aliases.map((alias) => caps(alias))),
      button('Change', () => { void shortcuts.record(control.id) }),
      shortcut.keys === null ? null : button('Clear', () => { void shortcuts.clear(control.id) }),
      shortcut.isDefault ? null : button('Reset', () => { void shortcuts.reset(control.id) })))
}

export function renderRow (row: Row, state: SettingsState): HTMLElement {
  controlCount += 1
  const controlId = `control-${String(controlCount)}`
  const { control } = row
  let field: HTMLElement
  switch (control.type) {
    case 'choice': field = renderChoice(control, state, controlId); break
    case 'toggle': field = renderToggle(control, state, controlId); break
    case 'text': field = renderText(control, state, controlId); break
    case 'action': field = renderAction(control, state); break
    case 'shortcut': field = renderShortcut(control, state); break
    case 'clearData': field = renderClearData(state); break
    case 'info': field = h('span', { className: 'value', textContent: control.text(state) }); break
  }

  const changed = 'key' in control && state.isChanged(control.key)
  const reset = changed
    ? h('button', {
      className: 'link-btn',
      type: 'button',
      textContent: 'Reset',
      title: 'Back to the default',
      onclick: () => { void state.reset(control.key) }
    })
    : null
  const labelsControl = control.type === 'choice' || control.type === 'toggle' || control.type === 'text'
  return h('div', { className: 'row', id: `row-${row.id}` },
    h('div', { className: 'row-text' },
      labelsControl
        ? h('label', { className: 'row-label', htmlFor: controlId, textContent: row.label })
        : h('span', { className: 'row-label', textContent: row.label }),
      changed ? h('span', { className: 'changed', title: 'Changed from the default', textContent: 'Changed' }) : null,
      row.help === undefined ? null : h('p', { className: 'row-help', textContent: row.help })),
    h('div', { className: 'row-control' }, field, reset))
}
