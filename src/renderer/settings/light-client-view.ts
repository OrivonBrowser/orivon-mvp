// The Settings panel's "Ethereum light client" section: read-only, rendered
// from what main says (src/main/verifier/status-view.ts), with every text
// node set through textContent, never markup.

import type { LightClientView } from '../../main/verifier/status-view.js'

const STATE_LABELS: Readonly<Record<LightClientView['state'], string>> = {
  off: 'Off',
  starting: 'Starting',
  syncing: 'Syncing',
  synced: 'Synced',
  failed: 'Failed',
  down: 'Not running'
}

function element<K extends keyof HTMLElementTagNameMap> (tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function renderLightClient (section: HTMLElement, view: LightClientView | null): void {
  section.replaceChildren()
  section.hidden = view === null
  if (view === null) return
  const heading = element('div', 'light-client-heading')
  heading.append(element('h2', 'light-client-title', 'Ethereum light client'), element('span', `light-client-state state-${view.state}`, STATE_LABELS[view.state]))
  section.append(
    heading,
    element('p', 'light-client-summary', view.summary),
    element('p', 'light-client-detail', view.checkpoint),
    element('p', 'light-client-detail', view.about)
  )
  const list = element('dl', 'light-client-endpoints')
  for (const { label, urls } of view.endpoints) {
    list.append(element('dt', 'light-client-endpoint-label', label))
    for (const url of urls) list.append(element('dd', 'light-client-endpoint', url))
  }
  section.append(list)
}
