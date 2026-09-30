// The main menu page: rows of commands under their keys, a zoom row, and
// submenus that replace the list under a row that goes back. Choosing a row
// asks main to run it; the zoom row keeps the menu open and shows the new level.
import type { MenuItemView } from '../../../main/shell/menu-layout.js'
import { h } from '../../pages/shared/dom.js'
import { checkIcon, chevronRightIcon, maximizeIcon, minusIcon, plusIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { formatKeys, nextRow } from './keys.js'
import type { NavKey } from './keys.js'
import './menu.css'

const NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End']

const isItems = (value: unknown): value is MenuItemView[] => Array.isArray(value)

/** The list one level down `path` (submenu labels), or the root when the path no longer leads anywhere. */
function levelAt (root: readonly MenuItemView[], path: readonly string[]): { items: readonly MenuItemView[], path: string[] } {
  let items = root
  const kept: string[] = []
  for (const label of path) {
    const next = items.find((item): item is Extract<MenuItemView, { kind: 'submenu' }> => item.kind === 'submenu' && item.label === label)
    if (next === undefined) break
    items = next.items
    kept.push(label)
  }
  return { items, path: kept }
}

export const menuPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let root: readonly MenuItemView[] = []
    let path: string[] = []
    /** Each row's focusable buttons: one for most rows, four for the zoom row. */
    let rows: HTMLElement[][] = []
    const list = h('div', { className: 'menu', role: 'menu', ariaLabel: 'Main menu' })
    content.append(list)

    function run (id: string, stay: boolean): void {
      void overlay.request<unknown>({ type: 'run', id, ...(stay ? { stay: true } : {}) }).then((reply) => {
        if (stay && isItems(reply)) { root = reply; render() }
      })
    }

    function commandRow (item: Extract<MenuItemView, { kind: 'command' }>): HTMLElement {
      const tick = item.checked !== null
      const button = h('button', {
        type: 'button', className: 'menu-row', role: tick ? 'menuitemcheckbox' : 'menuitem',
        onclick: () => { if (item.disabled !== true) run(item.id, false) }
      },
      h('span', { className: 'menu-label' }, item.label),
      item.hint !== null && h('span', { className: 'menu-hint' }, item.hint),
      item.hint === null && item.keys !== null && h('span', { className: 'menu-keys' }, formatKeys(item.keys, overlay.platform)),
      item.checked === true && h('span', { className: 'menu-check' }, checkIcon()))
      button.dataset['key'] = `cmd:${item.id}`
      if (tick) button.setAttribute('aria-checked', String(item.checked))
      // Greyed but still reachable by the arrow keys, so moving down the list never stops at it.
      if (item.disabled === true) button.setAttribute('aria-disabled', 'true')
      return button
    }

    function submenuRow (item: Extract<MenuItemView, { kind: 'submenu' }>): HTMLElement {
      const button = h('button', {
        type: 'button', className: 'menu-row', role: 'menuitem',
        onclick: () => { drill(item.label) }
      }, h('span', { className: 'menu-label' }, item.label), h('span', { className: 'menu-chevron' }, chevronRightIcon()))
      button.dataset['key'] = `sub:${item.label}`
      button.setAttribute('aria-haspopup', 'menu')
      return button
    }

    function zoomRow (item: Extract<MenuItemView, { kind: 'zoom' }>): { row: HTMLElement, buttons: HTMLElement[] } {
      const control = (id: string, label: string, child: Node | string, className: string, stay: boolean): HTMLButtonElement => {
        const button = h('button', {
          type: 'button', className: `zoom-btn ${className}`, role: 'menuitem', ariaLabel: label, title: label,
          disabled: !item.zoomable && id !== 'window.fullscreen',
          onclick: () => { run(id, stay) }
        }, child)
        button.dataset['key'] = `zoom:${id}`
        return button
      }
      const buttons = [
        control('zoom.out', 'Zoom out', minusIcon(), '', true),
        control('zoom.reset', `Reset zoom, now ${String(item.percent)} percent`, `${String(item.percent)}%`, 'zoom-pct', true),
        control('zoom.in', 'Zoom in', plusIcon(), '', true),
        control('window.fullscreen', 'Full screen', maximizeIcon(), 'zoom-full', false)
      ]
      const row = h('div', { className: 'menu-zoom', role: 'group', ariaLabel: 'Zoom' },
        h('span', { className: 'menu-label' }, 'Zoom'),
        h('div', { className: 'zoom-controls' }, ...buttons.slice(0, 3), h('span', { className: 'zoom-sep', role: 'separator' }), buttons[3]))
      return { row, buttons }
    }

    function render (): void {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['key'] : undefined
      const level = levelAt(root, path)
      path = level.path
      rows = []
      const children: Node[] = []
      if (path.length > 0) {
        const back = h('button', { type: 'button', className: 'menu-row menu-back', role: 'menuitem', onclick: goBack },
          h('span', { className: 'menu-chevron' }, chevronRightIcon()), h('span', { className: 'menu-label' }, path[path.length - 1]))
        back.dataset['key'] = 'back'
        back.setAttribute('aria-label', `Back to ${path.length > 1 ? String(path[path.length - 2]) : 'the menu'}`)
        rows.push([back])
        children.push(back, h('div', { className: 'menu-separator', role: 'separator' }))
      }
      for (const item of level.items) {
        if (item.kind === 'separator') { children.push(h('div', { className: 'menu-separator', role: 'separator' })); continue }
        if (item.kind === 'zoom') {
          const { row, buttons } = zoomRow(item)
          rows.push(buttons)
          children.push(row)
          continue
        }
        const row = item.kind === 'command' ? commandRow(item) : submenuRow(item)
        rows.push([row])
        children.push(row)
      }
      list.replaceChildren(...children)
      if (focused !== undefined) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]:not([disabled])`)?.focus()
    }

    function drill (label: string): void {
      path = [...path, label]
      render()
      // The first entry, not the back row: a keyboard user came here to choose.
      rows[1]?.[0]?.focus()
    }

    function goBack (): void {
      const from = path.at(-1)
      path = path.slice(0, -1)
      render()
      if (from !== undefined) list.querySelector<HTMLElement>(`[data-key="${CSS.escape(`sub:${from}`)}"]`)?.focus()
    }

    const rowOf = (element: Element | null): number => rows.findIndex((row) => element !== null && row.includes(element as HTMLElement))

    document.addEventListener('keydown', (event) => {
      const at = rowOf(document.activeElement)
      if (NAV_KEYS.includes(event.key)) {
        event.preventDefault()
        const target = rows[nextRow(rows.length, at, event.key as NavKey)]
        target?.find((button) => !(button as HTMLButtonElement).disabled)?.focus()
        return
      }
      const inRow = at < 0 ? [] : rows[at] ?? []
      const column = inRow.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (inRow.length > 1) inRow.slice(column + 1).find((button) => !(button as HTMLButtonElement).disabled)?.focus()
        else if ((document.activeElement as HTMLElement | null)?.getAttribute('aria-haspopup') === 'menu') (document.activeElement as HTMLElement).click()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (inRow.length > 1) inRow.slice(0, column).reverse().find((button) => !(button as HTMLButtonElement).disabled)?.focus()
        else if (path.length > 0) goBack()
      } else if (event.key === 'Escape' && path.length > 0) {
        // One level up first; the kit closes the menu only from the top.
        event.preventDefault()
        goBack()
      }
    })

    return {
      shown (payload) {
        root = isItems(payload) ? payload : []
        path = []
        render()
        // Opened by a click a highlighted first row would read as already chosen; the arrow keys reach the first or last row from nothing.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
        content.parentElement?.scrollTo({ top: 0 })
      }
    }
  }
}
