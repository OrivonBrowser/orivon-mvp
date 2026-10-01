// A view whose feature has not landed: its title and a line saying what will be here.
import { h, replaceChildren } from '../../shared/dom.js'
import { puzzleIcon } from '../../shared/icons.js'
import type { ExtensionView } from '../types.js'

export function stubView (title: string, line: string): ExtensionView {
  return {
    render: (root) => {
      replaceChildren(root, h('div', { className: 'empty-state' }, puzzleIcon(), h('strong', { textContent: title }), h('p', { textContent: line })))
    }
  }
}
