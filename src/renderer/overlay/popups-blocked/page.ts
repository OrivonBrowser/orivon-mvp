// The bubble under the pop-up chip. Main sends the site, the addresses the
// page tried to open and whether the site is allowed now; the page names a row
// by position and a choice by value, and main decides what each does.
import type { PopupsView } from '../../../main/site-settings/popups-view.js'
import { h, replaceChildren } from '../../pages/shared/dom.js'
import { step } from '../../pages/shared/list-selection.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { isPopupsView, moreText } from './view.js'
import './popups-blocked.css'

export const popupsBlockedPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const card = h('div', { className: 'popups-bubble', role: 'dialog' })
    card.setAttribute('aria-labelledby', 'pb-title')
    content.append(card)

    function draw (view: PopupsView): void {
      let selected = 0
      const indexes = view.rows.map((_, index) => index)
      const rows = view.rows.map((row, index) => {
        const item = h('li', { className: 'listbox-item', role: 'option', id: `pb-row-${String(index)}`, title: row.url },
          h('span', { className: 'item-title' }, row.host),
          h('span', { className: 'item-sub' }, row.url))
        item.addEventListener('click', () => { select(index); open() })
        return item
      })
      const list = h('ul', { className: 'listbox', role: 'listbox', tabIndex: 0 }, ...rows)
      list.setAttribute('aria-label', 'Blocked pop-ups')

      const choice = (value: 'block' | 'allow', label: string): { label: HTMLElement, input: HTMLInputElement } => {
        const input = h('input', { type: 'radio', name: 'pb-choice', value, checked: (value === 'allow') === view.allowed })
        return { input, label: h('label', { className: 'check' }, input, h('span', null, label)) }
      }
      const keep = choice('block', 'Keep blocking pop-ups')
      const allow = choice('allow', `Always allow pop-ups from ${view.origin}`)
      const group = h('div', { className: 'pb-choices', role: 'radiogroup' }, keep.label, allow.label)
      group.setAttribute('aria-label', 'Pop-ups from this site')

      const done = h('button', { type: 'button', className: 'btn primary' }, 'Done')
      done.addEventListener('click', () => { void overlay.request({ type: 'apply', allow: allow.input.checked }) })

      function select (index: number): void {
        selected = index
        rows.forEach((row, at) => { row.setAttribute('aria-selected', String(at === index)) })
        const row = rows[index]
        if (row !== undefined) {
          list.setAttribute('aria-activedescendant', row.id)
          row.scrollIntoView({ block: 'nearest' })
        }
      }
      function open (): void {
        void overlay.request({ type: 'open', index: selected })
      }

      list.addEventListener('keydown', (event) => {
        const how = ({ ArrowUp: 'up', ArrowDown: 'down', Home: 'first', End: 'last' } as const)[event.key as 'ArrowUp']
        if (how !== undefined) {
          event.preventDefault()
          select(step(indexes, selected, how) ?? 0)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          open()
        }
      })

      replaceChildren(card,
        h('h1', { className: 'sheet-title', id: 'pb-title' }, 'Pop-ups blocked'),
        h('p', { className: 'origin', title: view.origin }, view.origin),
        h('div', { className: 'pb-list' }, list),
        view.more > 0 && h('p', { className: 'pb-more' }, moreText(view.more)),
        group,
        h('div', { className: 'btn-row pb-foot' },
          view.settingsLink && h('button', { type: 'button', className: 'link-btn', onclick: () => { void overlay.request({ type: 'settings' }) } }, 'Site settings'),
          done)
      )
      select(0)
      list.focus()
    }

    return {
      shown (payload) {
        if (!isPopupsView(payload)) { overlay.close(); return }
        draw(payload)
      }
    }
  }
}
