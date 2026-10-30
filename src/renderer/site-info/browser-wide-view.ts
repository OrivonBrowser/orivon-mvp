import { h } from '../pages/shared/dom.js'
import type { Panel } from './browser-wide-model.js'
import { createSwitch } from './switch.js'
import type { NodesModel, PromptModel } from './tunnels-model.js'

// The drawing of what the tunnels popup adds for its two panels: the control that chooses between them, the nodes switch and the
// question before a tunnel is set browser-wide. The words are `browser-wide-model.ts`'s; every title a website wrote goes in as text.

export interface PanelNames {
  readonly first: string
  readonly browser: string
}

const ORDER: readonly Panel[] = ['first', 'browser']

/** The two panels as a segmented control: tabs of one tab list, which the arrow keys, Home and End move between. */
export function renderPanelTabs (selected: Panel, names: PanelNames, onSelect: (panel: Panel) => void): HTMLElement {
  const list = h('div', { className: 'tunnel-tabs' })
  list.setAttribute('role', 'tablist')
  list.setAttribute('aria-label', 'Where the tunnel applies')
  for (const panel of ORDER) {
    const on = panel === selected
    const tab = h('button', { type: 'button', id: `tunnel-tab-${panel}`, className: on ? 'tunnel-tab selected' : 'tunnel-tab', textContent: names[panel], tabIndex: on ? 0 : -1 })
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(on))
    tab.setAttribute('aria-controls', 'tunnel-panel')
    tab.addEventListener('click', () => { onSelect(panel) })
    tab.addEventListener('keydown', (event) => {
      const next = event.key === 'Home' ? 'first' : event.key === 'End' ? 'browser' : event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? ORDER.find((one) => one !== panel) : undefined
      if (next === undefined) return
      event.preventDefault()
      onSelect(next)
    })
    list.append(tab)
  }
  return list
}

/** The switch for the IPFS and Swarm nodes, drawn like a tunnel's row without the logo. */
export function renderNodes (nodes: NodesModel, onToggle: (next: boolean) => void): HTMLElement {
  const control = createSwitch(nodes.on, nodes.disabled, onToggle)
  control.id = 'tunnel-switch-nodes'
  control.setAttribute('aria-label', nodes.label)
  return h('div', { className: 'tunnel-row tunnel-nodes' },
    h('span', { className: 'tunnel-text' }, h('span', { className: 'tunnel-label', textContent: nodes.label }), h('span', { className: 'tunnel-state', textContent: nodes.line })),
    control)
}

/** The question before a tunnel is set browser-wide: the tabs that keep their own, each with what it keeps, then Cancel and Proceed. */
export function renderPrompt (prompt: PromptModel, onCancel: () => void, onProceed: () => void): HTMLElement {
  const list = h('ul', { className: 'tunnel-kept', tabIndex: 0 })
  list.setAttribute('role', 'list')
  list.setAttribute('aria-label', 'Tabs that keep their own tunnel')
  for (const tab of prompt.tabs) {
    const title = h('span', { className: 'tunnel-kept-title', textContent: tab.title })
    title.title = tab.title
    list.append(h('li', { className: 'tunnel-kept-row' }, title, h('span', { className: 'tunnel-kept-via', textContent: tab.kept })))
  }
  const notice = h('div', { className: 'tunnel-notice' },
    h('p', { className: 'tunnel-notice-text', textContent: prompt.text }),
    list,
    h('div', { className: 'staged-buttons' },
      h('button', { type: 'button', id: 'tunnel-prompt-cancel', className: 'btn-secondary', textContent: 'Cancel', onclick: onCancel }),
      h('button', { type: 'button', id: 'tunnel-prompt-proceed', className: 'btn-primary', textContent: 'Proceed', onclick: onProceed })))
  notice.setAttribute('role', 'alertdialog')
  return notice
}
