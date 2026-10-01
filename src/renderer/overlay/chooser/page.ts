// The chooser sheet: a question, a list of rows and one button to take the selected one. Main sends the whole
// question on each show and checks the row that comes back against the ones it offered.
import type { ChooserView } from '../../../main/auth/chooser-store.js'
import { h, replaceChildren } from '../../pages/shared/dom.js'
import { lockIcon } from '../../pages/shared/icons.js'
import { step } from '../../pages/shared/list-selection.js'
import type { Overlay, OverlayPage } from '../kit.js'
import './chooser.css'

const EXPIRED_TEXT = 'This certificate has expired. The site will probably refuse it.'

const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'

export function isChooserView (value: unknown): value is ChooserView {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v['id'] === 'string' && typeof v['title'] === 'string' && isTextOrNull(v['origin']) && isTextOrNull(v['line']) &&
    isTextOrNull(v['warning']) && typeof v['preselect'] === 'boolean' && typeof v['confirm'] === 'string' && typeof v['empty'] === 'string' && Array.isArray(v['items']) &&
    v['items'].every((item) => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' && typeof (item as { title?: unknown }).title === 'string')
}

export const chooserPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'chooser', role: 'dialog' })
    content.append(card)

    function build (view: ChooserView): void {
      const ids = view.items.map((_, index) => index)
      let selected: number | null = view.items.length === 1 && view.preselect ? 0 : null
      const confirm = h('button', { type: 'button', className: 'btn primary' }, view.confirm)
      const cancel = h('button', { type: 'button', className: 'btn' }, view.items.length === 0 ? 'Close' : 'Cancel')
      const rows = view.items.map((item, index) => {
        const row = h('li', { className: 'listbox-item', role: 'option', id: `chooser-row-${String(index)}` },
          h('span', { className: 'item-title', title: item.title }, item.title),
          item.sub === undefined ? null : h('span', { className: 'item-sub', title: item.sub }, item.sub),
          item.meta === undefined ? null : h('span', item.expired === true ? { className: 'badge danger item-meta' } : { className: 'item-meta' }, item.meta))
        row.addEventListener('click', () => { select(index) })
        row.addEventListener('dblclick', () => { select(index); choose() })
        return row
      })
      const list = h('ul', { className: 'listbox', role: 'listbox', tabIndex: 0 }, ...rows)
      list.setAttribute('aria-label', view.title)
      const caution = h('p', { className: 'chooser-caution', role: 'status', hidden: true }, EXPIRED_TEXT)

      function select (index: number | null): void {
        selected = index
        rows.forEach((row, at) => { row.setAttribute('aria-selected', String(at === index)) })
        const row = index === null ? undefined : rows[index]
        if (row === undefined) list.removeAttribute('aria-activedescendant')
        else { list.setAttribute('aria-activedescendant', row.id); row.scrollIntoView({ block: 'nearest' }) }
        confirm.disabled = index === null
        caution.hidden = !(index !== null && view.items[index]?.expired === true)
      }
      function choose (): void {
        const item = selected === null ? undefined : view.items[selected]
        if (item === undefined) return
        confirm.disabled = true
        void overlay.request({ type: 'choose', id: view.id, item: item.id }).finally(() => { confirm.disabled = selected === null })
      }

      list.addEventListener('keydown', (event) => {
        const how = ({ ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' } as const)[event.key as 'ArrowUp']
        if (how !== undefined) {
          event.preventDefault()
          select(step(ids, selected, how))
        } else if (event.key === 'Enter' && selected !== null) {
          event.preventDefault()
          choose()
        }
      })
      confirm.addEventListener('click', choose)
      cancel.addEventListener('click', () => { void overlay.request({ type: 'cancel', id: view.id }) })

      card.setAttribute('aria-labelledby', 'chooser-title')
      replaceChildren(card,
        h('h1', { className: 'sheet-title', id: 'chooser-title' }, view.title),
        view.origin === null ? null : h('p', { className: 'origin', title: view.origin }, view.origin),
        view.line === null ? null : h('p', { className: 'chooser-line' }, view.line),
        view.warning === null ? null : h('p', { className: 'banner warn chooser-warning', role: 'alert' }, view.warning),
        view.items.length === 0
          ? h('div', { className: 'empty-state compact', role: 'status' }, lockIcon(), h('p', null, view.empty))
          : h('div', { className: 'chooser-list' }, list),
        view.items.length === 0 ? null : caution,
        h('div', { className: 'btn-row' }, cancel, view.items.length === 0 ? null : confirm)
      )
      select(selected)
      if (view.items.length === 0) cancel.focus()
      else list.focus()
    }

    return {
      shown (payload) {
        if (!isChooserView(payload)) { overlay.close(); return }
        build(payload)
      }
    }
  }
}
