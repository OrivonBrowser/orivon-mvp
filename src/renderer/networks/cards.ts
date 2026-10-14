// Draws the Available networks cards from the view main sends, and nothing else. Each card is built once and
// updated in place on every push (main sends one every two seconds for the figures), so a switch that has the
// keyboard keeps it and nothing flickers. Every text goes in through textContent, never markup.

import type { NetworkCard, NetworksView } from '../../main/networks/networks-view.js'
import { createSwitch } from '../site-info/switch.js'

interface Drawn {
  readonly root: HTMLElement
  readonly status: HTMLElement
  readonly control: HTMLButtonElement
  readonly note: HTMLElement
  readonly metrics: HTMLElement
  /** What the metrics list holds now, so an unchanged list is not drawn again. */
  shown: string
}

function element<K extends keyof HTMLElementTagNameMap> (tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export interface NetworkCards {
  update: (view: NetworksView) => void
}

export function createNetworkCards (container: HTMLElement, onSwitch: (id: string, on: boolean) => void): NetworkCards {
  const drawn = new Map<string, Drawn>()

  function build (card: NetworkCard): Drawn {
    const root = element('section', 'card')
    root.setAttribute('role', 'listitem')
    root.dataset['id'] = card.id
    const status = element('span', 'card-status')
    const control = createSwitch(card.on, card.disabled, (next) => { onSwitch(card.id, next) })
    control.setAttribute('aria-label', card.name)
    const head = element('div', 'card-head')
    head.append(element('h2', 'card-name', card.name), status, control)
    const note = element('p', 'card-note')
    const metrics = element('dl', 'metrics')
    root.append(head, element('p', 'card-does', card.does), note, metrics)
    return { root, status, control, note, metrics, shown: '' }
  }

  function fill (entry: Drawn, card: NetworkCard): void {
    entry.status.textContent = card.status
    entry.status.dataset['tone'] = card.tone
    entry.control.disabled = card.disabled
    entry.control.setAttribute('aria-checked', String(card.on))
    entry.control.classList.toggle('on', card.on)
    entry.note.hidden = card.note === undefined
    entry.note.textContent = card.note ?? ''
    const key = JSON.stringify(card.metrics)
    if (key === entry.shown) return
    entry.shown = key
    entry.metrics.replaceChildren(...card.metrics.flatMap((metric) => [element('dt', '', metric.label), element('dd', '', metric.value)]))
  }

  return {
    update: (view) => {
      for (const card of view.cards) {
        let entry = drawn.get(card.id)
        if (entry === undefined) {
          entry = build(card)
          drawn.set(card.id, entry)
        }
        fill(entry, card)
      }
      // Appending a node that is already a child moves it, so this puts the cards in the order main sent without drawing any again.
      container.append(...view.cards.flatMap((card) => drawn.get(card.id)?.root ?? []))
    }
  }
}
