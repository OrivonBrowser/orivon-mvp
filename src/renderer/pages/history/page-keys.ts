// Reads the keyboard for the History page and turns it into calls on what the page offers.
import { intentFor } from './keys.js'

export interface KeyTargets {
  readonly search: HTMLInputElement
  readonly mac: boolean
  clearSearch: () => void
  clearSelection: () => void
  hasSelection: () => boolean
  focusSearch: () => void
  move: (id: number, to: 'up' | 'down' | 'first' | 'last', extend: boolean) => void
  open: (id: number, disposition: 'tab' | 'background') => void
  toggle: (id: number) => void
  selectAll: () => void
  remove: (id: number) => void
}

const isField = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement

export function installKeys (targets: KeyTargets): void {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return
    const row = event.target instanceof HTMLElement && event.target.classList.contains('entry') ? event.target : null
    const intent = intentFor({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, inField: isField(event.target), onRow: row !== null, mac: targets.mac })
    if (intent === null) return
    const id = Number(row?.dataset['id'])
    switch (intent.kind) {
      case 'escape':
        if (event.target === targets.search && targets.search.value !== '') targets.clearSearch()
        else if (targets.hasSelection()) targets.clearSelection()
        else return
        break
      case 'search': targets.focusSearch(); break
      case 'all': targets.selectAll(); break
      case 'move': targets.move(id, intent.to, intent.extend); break
      case 'open': targets.open(id, intent.disposition); break
      case 'toggle': targets.toggle(id); break
      case 'delete': targets.remove(id); break
    }
    event.preventDefault()
  })
}
