// The view picker: a button naming the view on show and a listbox of the views under it. Orivon's views come
// first, then the entries other code added. Up and Down move, Enter chooses, Escape closes and returns to the button.
import { faviconElement } from '../../icons.js'
import { h } from '../../pages/shared/dom.js'
import { viewIcon } from './view-icons.js'
import { chevronDownIcon, puzzleIcon } from '../../pages/shared/icons.js'
import type { GuestMeta, ViewMeta } from './shown.js'

export interface Picker {
  readonly button: HTMLButtonElement
  readonly list: HTMLElement
  update: (views: readonly ViewMeta[], guests: readonly GuestMeta[], current: string, guest: GuestMeta | null) => void
  isOpen: () => boolean
  close: (focusButton: boolean) => void
}

interface Choice { id: string, title: string, icon: () => Element }

/** `toggled` hears the list open and close, so main can lift a view that would cover it. */
export function createPicker (choose: (id: string) => void, toggled: (open: boolean) => void = () => {}): Picker {
  let choices: Choice[] = []
  let current = ''
  let active = 0
  const label = h('span', { className: 'sp-picker-name' })
  const mark = h('span', { className: 'item-icon sp-picker-icon' })
  const button = h('button', { type: 'button', className: 'btn small sp-picker', title: 'Choose what the panel shows' }, mark, label, h('span', { className: 'sp-chevron' }, chevronDownIcon()))
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  const options = h('ul', { className: 'listbox', role: 'listbox', ariaLabel: 'Panel views' })
  options.tabIndex = -1
  const list = h('div', { className: 'sp-picker-list' }, options)
  list.hidden = true

  const isOpen = (): boolean => !list.hidden

  function markActive (): void {
    const items = [...options.children] as HTMLElement[]
    items.forEach((item, at) => { item.setAttribute('aria-selected', String(at === active)) })
    const el = items[active]
    if (el === undefined) options.removeAttribute('aria-activedescendant')
    else options.setAttribute('aria-activedescendant', el.id)
  }

  function close (focusButton: boolean): void {
    const was = isOpen()
    list.hidden = true
    if (was) toggled(false)
    button.setAttribute('aria-expanded', 'false')
    if (focusButton) button.focus()
  }

  function open (): void {
    active = Math.max(0, choices.findIndex((choice) => choice.id === current))
    list.hidden = false
    toggled(true)
    button.setAttribute('aria-expanded', 'true')
    markActive()
    options.focus()
  }

  function pick (at: number): void {
    const choice = choices[at]
    close(true)
    if (choice !== undefined) choose(choice.id)
  }

  button.addEventListener('click', () => { if (isOpen()) close(true); else open() })
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    if (!isOpen()) open()
  })
  options.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown': active = Math.min(choices.length - 1, active + 1); break
      case 'ArrowUp': active = Math.max(0, active - 1); break
      case 'Home': active = 0; break
      case 'End': active = choices.length - 1; break
      case 'Enter': case ' ': pick(active); event.preventDefault(); return
      case 'Escape': close(true); event.preventDefault(); event.stopPropagation(); return
      case 'Tab': close(false); return
      default: return
    }
    event.preventDefault()
    markActive()
  })
  // Leaving the list any other way closes it, so it is never left open behind what is focused next.
  options.addEventListener('blur', () => { setTimeout(() => { if (isOpen() && !list.contains(document.activeElement)) close(false) }, 0) })

  return {
    button,
    list,
    isOpen,
    close,
    update (views, guests, now, guest) {
      current = now
      const entries = guest !== null && !guests.some((entry) => entry.id === guest.id) ? [...guests, guest] : guests
      choices = [
        ...views.map((view): Choice => ({ id: view.id, title: view.title, icon: () => viewIcon(view.icon) })),
        ...entries.map((entry): Choice => ({ id: entry.id, title: entry.title, icon: () => entry.icon === undefined ? puzzleIcon() : faviconElement(entry.icon) }))
      ]
      const shown = choices.find((choice) => choice.id === now) ?? (guest === null ? choices[0] : { id: guest.id, title: guest.title, icon: () => guest.icon === undefined ? puzzleIcon() : faviconElement(guest.icon) })
      label.textContent = shown?.title ?? ''
      mark.replaceChildren(...(shown === undefined ? [] : [shown.icon()]))
      options.replaceChildren(...choices.map((choice, at) => {
        const el = h('li', { className: 'listbox-item sp-choice', id: `sp-view-${String(at)}`, role: 'option' }, h('span', { className: 'item-icon' }, choice.icon()), h('span', { className: 'item-title' }, choice.title))
        el.setAttribute('aria-selected', 'false')
        el.addEventListener('click', () => { pick(at) })
        el.addEventListener('mousedown', (event) => { event.preventDefault() })
        return el
      }))
      if (isOpen()) markActive()
    }
  }
}
