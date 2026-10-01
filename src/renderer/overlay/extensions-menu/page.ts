// The Extensions menu: every enabled extension as a row with its icon and
// name, a pin and a "more actions" button, then a way to the extensions page.
// Main sends the rows with each show and answers each request with the menu as
// it is then; the keyboard model is here.
import { h } from '../../pages/shared/dom.js'
import { chevronRightIcon, gearIcon, moreIcon, pinIcon, puzzleIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { nextRow } from '../menu/keys.js'
import type { NavKey } from '../menu/keys.js'
import { MORE_ITEMS } from './more-items.js'
import { asPayload, jumpTo, rowLabel, siteLine, stepControl } from './model.js'
import type { MenuPayload, MenuRow } from './model.js'
import { letterTile } from '../../pages/shared/letter-tile.js'
import './extensions-menu.css'

const NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'Home', 'End']

/** The extension's own icon when main sent one, else a tile with its initial. */
function iconFor (row: MenuRow): HTMLElement {
  const box = h('span', { className: 'item-icon em-icon' })
  if (row.icon !== null && row.icon.startsWith('data:image/')) {
    const img = h('img', { alt: '', decoding: 'async', referrerPolicy: 'no-referrer' })
    img.addEventListener('error', () => { img.replaceWith(letterTile(row.name, 'em-initial')) }, { once: true })
    img.src = row.icon
    box.append(img)
  } else {
    box.append(letterTile(row.name, 'em-initial'))
  }
  return box
}

export const extensionsMenuPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let payload: MenuPayload = { site: null, activatable: true, rows: [] }
    /** The extension whose "More actions" list replaces the rows, or null for the rows. */
    let moreId: string | null = null
    /** Each focusable control, grouped by line: the arrow keys move between lines and Left and Right along one. */
    let lines: HTMLElement[][] = []
    const root = h('div', { className: 'em' })
    content.append(root)

    async function send (command: Record<string, unknown>): Promise<unknown> {
      const reply = await overlay.request(command)
      const next = asPayload(reply)
      if (next !== undefined) {
        payload = next
        if (moreId !== null && !next.rows.some((row) => row.id === moreId)) moreId = null
        render()
      }
      return reply
    }

    const control = (key: string, kind: 'main' | 'pin' | 'more' | 'back' | 'manage' | 'store', element: HTMLElement): HTMLElement => {
      element.dataset['key'] = key
      element.dataset['nav'] = kind
      return element
    }

    function rowElement (row: MenuRow): { li: HTMLElement, controls: HTMLElement[] } {
      const dim = row.hasAction && !payload.activatable
      const main = control(`main:${row.id}`, 'main', h('button', {
        type: 'button',
        className: 'em-main',
        role: 'menuitem',
        ariaLabel: rowLabel(row),
        title: !row.hasAction ? `${row.name} has no toolbar button` : !payload.activatable ? `${row.name} cannot run on this page` : row.name,
        onclick: () => { void send({ type: 'activate', id: row.id }) }
      },
      iconFor(row),
      h('span', { className: dim ? 'item-title muted' : 'item-title' }, row.name),
      row.badge === '' ? null : h('span', { className: 'badge em-badge' }, row.badge)))
      if (!row.hasAction || !payload.activatable) main.setAttribute('aria-disabled', row.hasAction ? 'true' : 'false')
      const controls = [main]
      const actions = h('span', { className: 'em-actions' })
      if (row.hasAction) {
        const pin = control(`pin:${row.id}`, 'pin', h('button', {
          type: 'button',
          className: 'btn icon em-pin',
          role: 'menuitemcheckbox',
          title: row.pinned ? `Unpin ${row.name} from the toolbar` : `Pin ${row.name} to the toolbar`,
          ariaLabel: row.pinned ? `Unpin ${row.name} from the toolbar` : `Pin ${row.name} to the toolbar`,
          onclick: () => { void send({ type: 'pin', id: row.id }) }
        }, pinIcon()))
        pin.setAttribute('aria-checked', String(row.pinned))
        controls.push(pin)
        actions.append(pin)
      }
      const more = control(`more:${row.id}`, 'more', h('button', {
        type: 'button',
        className: 'btn icon em-more',
        role: 'menuitem',
        title: `More actions for ${row.name}`,
        ariaLabel: `More actions for ${row.name}`,
        onclick: () => { moreId = row.id; render(); lines[0]?.[0]?.focus() }
      }, moreIcon()))
      more.setAttribute('aria-haspopup', 'menu')
      controls.push(more)
      actions.append(more)
      const li = h('li', { className: 'listbox-item em-row', role: 'none' }, main, actions)
      li.dataset['id'] = row.id
      return { li, controls }
    }

    function footer (): HTMLElement {
      const manage = control('manage', 'manage', h('button', {
        type: 'button', className: 'listbox-item em-manage', role: 'menuitem', onclick: () => { void send({ type: 'manage-all' }) }
      }, h('span', { className: 'item-icon' }, gearIcon()), h('span', { className: 'item-title' }, 'Manage extensions')))
      lines.push([manage])
      return h('div', { className: 'em-foot' }, h('hr', { className: 'em-rule' }), manage)
    }

    function listView (): Node[] {
      const head = h('div', { className: 'em-head' }, h('h2', { className: 'em-title' }, 'Extensions'), h('span', { className: 'item-sub em-site' }, siteLine(payload.site)))
      if (payload.rows.length === 0) {
        const store = control('store', 'store', h('button', { type: 'button', className: 'link-btn', onclick: () => { void send({ type: 'store' }) } }, 'Get extensions from the Chrome Web Store'))
        lines.push([store])
        return [head, h('div', { className: 'empty-state compact' }, puzzleIcon(), h('span', null, 'Extensions you add appear here.'), store), footer()]
      }
      const list = h('ul', { className: 'listbox em-list', role: 'menu', ariaLabel: 'Extensions' })
      for (const row of payload.rows) {
        const { li, controls } = rowElement(row)
        lines.push(controls)
        list.append(li)
      }
      return [head, list, footer()]
    }

    function moreView (row: MenuRow): Node[] {
      const back = control('back', 'back', h('button', {
        type: 'button', className: 'listbox-item em-back', role: 'menuitem', ariaLabel: 'Back to the extensions', onclick: goBack
      }, h('span', { className: 'em-back-arrow' }, chevronRightIcon()), h('span', { className: 'item-title' }, row.name)))
      lines.push([back])
      const list = h('ul', { className: 'listbox em-list', role: 'menu', ariaLabel: `More actions for ${row.name}` })
      for (const item of [...MORE_ITEMS].sort((a, b) => a.order - b.order)) {
        const el = item.render(row, send)
        if (el === null) continue
        control(`more-item:${item.order}`, 'main', el)
        lines.push([el])
        list.append(h('li', { role: 'none' }, el))
      }
      return [back, h('hr', { className: 'em-rule' }), list]
    }

    function render (): void {
      const active = document.activeElement
      const focused = active instanceof HTMLElement ? active.dataset['key'] : undefined
      lines = []
      const row = moreId === null ? undefined : payload.rows.find((candidate) => candidate.id === moreId)
      root.replaceChildren(...(row === undefined ? listView() : moreView(row)))
      if (focused !== undefined) root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus()
    }

    function goBack (): void {
      const from = moreId
      moreId = null
      render()
      if (from !== null) root.querySelector<HTMLElement>(`[data-key="more:${CSS.escape(from)}"]`)?.focus()
    }

    const lineOf = (element: Element | null): number => lines.findIndex((line) => element !== null && line.includes(element as HTMLElement))

    document.addEventListener('keydown', (event) => {
      const at = lineOf(document.activeElement)
      if (NAV_KEYS.includes(event.key)) {
        event.preventDefault()
        const to = lines[nextRow(lines.length, at, event.key as NavKey)]
        const kind = at < 0 ? undefined : (document.activeElement as HTMLElement).dataset['nav']
        // Down and Up keep the column (pin stays pin) where the next line has it.
        to?.find((element) => element.dataset['nav'] === kind)?.focus()
        if (to !== undefined && !to.some((element) => element === document.activeElement)) to[0]?.focus()
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const here = document.activeElement as HTMLElement | null
        const line = at < 0 ? [] : lines[at] ?? []
        if (here === null || line.length < 2) {
          if (event.key === 'ArrowLeft' && moreId !== null) { event.preventDefault(); goBack() }
          return
        }
        event.preventDefault()
        line[stepControl(line.length, line.indexOf(here), event.key === 'ArrowRight' ? 1 : -1)]?.focus()
        return
      }
      if (event.key === 'Escape' && moreId !== null) {
        // One level up first; the kit closes the menu only from the rows.
        event.preventDefault()
        goBack()
        return
      }
      if (moreId === null && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== ' ') {
        const names = payload.rows.map((row) => row.name)
        const from = at >= 0 && at < names.length ? at : -1
        const to = jumpTo(names, from, event.key)
        if (to >= 0) { event.preventDefault(); lines[to]?.[0]?.focus() }
      }
    })

    return {
      shown (opened) {
        payload = asPayload(opened) ?? { site: null, activatable: true, rows: [] }
        moreId = null
        render()
        // Opened by a click, a highlighted first row would read as already chosen; the arrow keys reach it from nothing.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      }
    }
  }
}
