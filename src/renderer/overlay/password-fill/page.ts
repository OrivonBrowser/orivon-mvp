// The chooser: the accounts saved for this site, and for a sign-up form a strong password to use. It lists
// usernames and dots, never a password: a choice goes to main, which reads the password itself and fills
// the page only if the page is still where the login belongs.
import { h } from '../../pages/shared/dom.js'
import { keyIcon, refreshIcon } from '../../pages/shared/icons.js'
import { step } from '../../pages/shared/list-selection.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { chooserFrom, DOTS, selectionFrom, stepFor } from './model.js'
import type { Chooser } from './model.js'
import './password-fill.css'

type Choice = { kind: 'login', id: string } | { kind: 'generate' }

export const passwordFillPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let choices: Choice[] = []
    let selected = 0
    let field = false
    const rows: HTMLElement[] = []

    const list = h('ul', { className: 'listbox', role: 'listbox', ariaLabel: 'Saved passwords for this site', id: 'pf-list' })
    list.tabIndex = 0
    const manage = h('button', { type: 'button', className: 'link-btn', textContent: 'Manage passwords' })
    manage.addEventListener('click', () => { void overlay.request({ type: 'manage' }) })
    content.append(h('div', { className: 'pf' }, list, h('div', { className: 'pf-foot' }, manage)))

    function select (index: number, scroll: boolean): void {
      selected = index
      rows.forEach((row, at) => { row.setAttribute('aria-selected', String(at === index)) })
      const row = rows[index]
      if (row === undefined) list.removeAttribute('aria-activedescendant')
      else {
        list.setAttribute('aria-activedescendant', row.id)
        if (scroll) row.scrollIntoView({ block: 'nearest' })
      }
    }

    function choose (index: number): void {
      const choice = choices[index]
      if (choice === undefined) return
      void overlay.request(choice.kind === 'login' ? { type: 'fill', id: choice.id } : { type: 'generate' })
    }

    function row (index: number, icon: Node, title: Node | string, sub: Node | string): HTMLElement {
      const el = h('li', { className: 'listbox-item', id: `pf-option-${String(index)}`, role: 'option' },
        h('span', { className: 'item-icon' }, icon), h('span', { className: 'item-title' }, title), h('span', { className: 'item-sub' }, sub))
      el.addEventListener('click', () => { choose(index) })
      // Hover moves the selection, so Enter always does what the highlighted row says. Under a box main reads Enter,
      // so it is told too.
      el.addEventListener('mousemove', () => {
        if (selected === index) return
        select(index, false)
        if (field) void overlay.request({ type: 'hover', index })
      })
      return el
    }

    function render (chooser: Chooser): void {
      choices = []
      rows.length = 0
      if (chooser.generated !== null) {
        rows.push(row(rows.length, refreshIcon(), 'Use a strong password', h('code', { className: 'pf-code' }, chooser.generated)))
        choices.push({ kind: 'generate' })
      }
      for (const login of chooser.logins) {
        const name = login.username === '' ? h('span', { className: 'pf-none' }, 'No username') : login.username
        const title = login.username === '' ? '' : login.username
        const el = row(rows.length, keyIcon(), name, DOTS)
        if (title !== '') el.title = title
        rows.push(el)
        choices.push({ kind: 'login', id: login.id })
      }
      list.replaceChildren(...rows)
      // Under a box the page keeps the keyboard and nothing is chosen until the arrow keys, which main reads, say so.
      select(field ? -1 : 0, true)
    }

    // Main drives the list under a box: the keys never reach this page.
    overlay.onEvent((event) => {
      const index = selectionFrom(event, rows.length)
      if (index !== null) select(index, true)
    })

    document.addEventListener('keydown', (event) => {
      if (field) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Enter') {
        if (event.target instanceof HTMLButtonElement) return
        event.preventDefault()
        choose(selected)
        return
      }
      const how = stepFor(event.key)
      if (how === null) return
      event.preventDefault()
      select(step(rows.map((_, at) => at), selected, how) ?? 0, true)
    })

    return {
      shown (payload) {
        const chooser = chooserFrom(payload)
        field = chooser.mode === 'field'
        content.dataset['mode'] = chooser.mode
        render(chooser)
        if (!field) list.focus()
      }
    }
  }
}
