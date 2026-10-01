// The lines of an extension's "More actions" list, in `order`. A feature adds
// its own here (site access, for one) and the page draws it; nothing else in
// the page changes. `send` makes a request of the menu's handler in main and
// redraws the menu from its reply.
import { h } from '../../pages/shared/dom.js'
import type { MenuRow } from './model.js'

export type Send = (command: Record<string, unknown>) => Promise<unknown>

export interface MoreItem {
  /** Ascending. Options, pin, manage and remove are 40 to 70. */
  readonly order: number
  /** The line for `row`, or null when it has none (no options page, say). */
  readonly render: (row: MenuRow, send: Send) => HTMLElement | null
}

const ARM_MS = 4_000

/** A row of the list: a button the arrow keys reach. */
export function moreButton (label: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const button = h('button', { type: 'button', className: `listbox-item em-more-item ${extra}`.trim(), role: 'menuitem', onclick: onClick }, h('span', { className: 'item-title' }, label))
  button.dataset['nav'] = 'more'
  return button
}

const optionsItem: MoreItem = {
  order: 40,
  render: (row, send) => row.hasOptions ? moreButton('Options', () => { void send({ type: 'options', id: row.id }) }) : null
}

const pinItem: MoreItem = {
  order: 50,
  render: (row, send) => row.hasAction
    ? moreButton(row.pinned ? 'Unpin from toolbar' : 'Pin to toolbar', () => { void send({ type: 'pin', id: row.id }) })
    : null
}

const manageItem: MoreItem = {
  order: 60,
  render: (row, send) => moreButton('Manage extension', () => { void send({ type: 'manage', id: row.id }) })
}

/** Two clicks: the first arms it for a few seconds, the second removes. */
const removeItem: MoreItem = {
  order: 70,
  render: (row, send) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const button = moreButton('Remove from Orivon', () => {
      if (timer === undefined) {
        button.classList.add('armed')
        const label = button.querySelector('.item-title')
        if (label !== null) label.textContent = 'Click again to remove'
        button.setAttribute('aria-label', `Confirm removing ${row.name}`)
        timer = setTimeout(() => {
          timer = undefined
          button.classList.remove('armed')
          const title = button.querySelector('.item-title')
          if (title !== null) title.textContent = 'Remove from Orivon'
          button.removeAttribute('aria-label')
        }, ARM_MS)
        return
      }
      clearTimeout(timer)
      void send({ type: 'remove', id: row.id })
    }, 'danger')
    return button
  }
}

export const MORE_ITEMS: readonly MoreItem[] = [optionsItem, pinItem, manageItem, removeItem]
