// The small menu a row opens: a popover inside the page, closed by Escape, a click elsewhere, or anything that would
// leave it pointing at the wrong place. One is open at a time.
import { h } from '../shared/dom.js'

export interface MenuItem {
  readonly label: string
  readonly run: () => void
  readonly danger?: boolean
}

export interface MenuPlace {
  readonly x: number
  readonly y: number
  /** `x` is the menu's right edge (the button it opens from sits at its right end). */
  readonly alignRight: boolean
}

const EDGE = 8

let current: { readonly close: () => void } | null = null

export function closeRowMenu (): void {
  current?.close()
}

/** Opens `items` at `place`. `onClose` runs once it is gone, to put the focus back where it was. */
export function openRowMenu (items: readonly MenuItem[], place: MenuPlace, onClose: () => void): void {
  closeRowMenu()
  const buttons = items.map((item) => h('button', { className: item.danger === true ? 'row-menu-item danger' : 'row-menu-item', type: 'button', role: 'menuitem', textContent: item.label }))
  const menu = h('div', { className: 'row-menu', role: 'menu' }, ...buttons)
  menu.setAttribute('aria-label', 'Page actions')
  const listeners: Array<() => void> = []
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    for (const remove of listeners) remove()
    menu.remove()
    current = null
    onClose()
  }
  const on = (target: EventTarget, type: string, handler: (event: Event) => void, capture = false): void => {
    target.addEventListener(type, handler, capture)
    listeners.push(() => { target.removeEventListener(type, handler, capture) })
  }
  items.forEach((item, index) => {
    (buttons[index] as HTMLElement).addEventListener('click', () => {
      // Closed first: that puts the focus back on the row, which an action that moves it (the next row, the search
      // box) must be able to override.
      close()
      item.run()
    })
  })
  on(menu, 'keydown', (event) => {
    const { key } = event as KeyboardEvent
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const go = (to: number): void => { event.preventDefault(); buttons[(to + buttons.length) % buttons.length]?.focus() }
    if (key === 'ArrowDown') go(at + 1)
    else if (key === 'ArrowUp') go(at - 1)
    else if (key === 'Home') go(0)
    else if (key === 'End') go(-1)
    else if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    else if (key === 'Tab') { event.preventDefault(); close() }
  })
  on(document, 'pointerdown', (event) => { if (!menu.contains(event.target as Node)) close() }, true)
  on(window, 'blur', close)
  on(window, 'resize', close)
  on(window, 'scroll', close, true)
  document.body.append(menu)
  const { width, height } = menu.getBoundingClientRect()
  const left = Math.min(Math.max(EDGE, place.alignRight ? place.x - width : place.x), window.innerWidth - width - EDGE)
  const top = place.y + height + EDGE > window.innerHeight ? Math.max(EDGE, place.y - height - 34) : place.y
  menu.style.left = `${String(left)}px`
  menu.style.top = `${String(top)}px`
  current = { close }
  buttons[0]?.focus()
}
