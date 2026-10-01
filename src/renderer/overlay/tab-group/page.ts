// The group bubble: a name, a colour, and what can be done to the group as a whole. The name is saved as it is
// typed. Only requests go to main, which knows which group this is.
import { h } from '../../pages/shared/dom.js'
import { closeIcon, externalLinkIcon, minusIcon, plusIcon } from '../../pages/shared/icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { nextRow } from '../menu/keys.js'
import type { NavKey } from '../menu/keys.js'
import { closeLabel, colorName, isModel, nextSwatch } from './model.js'
import type { GroupBubbleModel } from './model.js'
import './tab-group.css'

/** How long the close row waits for its second click. */
const ARMED_MS = 4000

export const tabGroupPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    let model: GroupBubbleModel | null = null
    let armed: number | undefined
    const input = h('input', { className: 'text tg-name', type: 'text', placeholder: 'Name this group', ariaLabel: 'Group name', spellcheck: false, autocomplete: 'off' })
    const swatches = h('div', { className: 'tg-swatches', role: 'radiogroup', ariaLabel: 'Group colour' })
    const list = h('ul', { className: 'listbox tg-actions', role: 'menu', ariaLabel: 'Group actions' })
    content.append(h('div', { className: 'tg-head' }, input, swatches), list)

    const rows = (): HTMLElement[] => [...list.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const radios = (): HTMLElement[] => [...swatches.querySelectorAll<HTMLElement>('[role="radio"]')]

    input.maxLength = 40
    input.addEventListener('input', () => { void overlay.request({ type: 'rename', title: input.value }) })
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      overlay.close()
    })

    function disarm (): void {
      if (armed !== undefined) window.clearTimeout(armed)
      armed = undefined
    }

    function choose (color: string): void {
      if (model === null) return
      model = { ...model, color: color as GroupBubbleModel['color'] }
      void overlay.request({ type: 'color', color })
      for (const swatch of radios()) {
        const on = swatch.dataset['color'] === color
        swatch.setAttribute('aria-checked', String(on))
        swatch.tabIndex = on ? 0 : -1
      }
    }

    function swatchFor (color: string, on: boolean): HTMLElement {
      const swatch = h('button', { type: 'button', className: 'tg-swatch', role: 'radio', ariaLabel: colorName(color), title: colorName(color) })
      swatch.dataset['color'] = color
      swatch.setAttribute('aria-checked', String(on))
      swatch.tabIndex = on ? 0 : -1
      swatch.addEventListener('click', () => { choose(color) })
      swatch.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const all = radios()
        const target = all[nextSwatch(all.length, all.indexOf(swatch), event.key)]
        if (target?.dataset['color'] === undefined) return
        choose(target.dataset['color'])
        target.focus()
      })
      return swatch
    }

    function row (label: string, icon: SVGSVGElement, run: () => void, danger = false): HTMLElement {
      const item = h('li', { className: danger ? 'listbox-item tg-danger' : 'listbox-item', role: 'menuitem' },
        h('span', { className: 'item-icon' }, icon), h('span', { className: 'item-title' }, label))
      item.tabIndex = -1
      item.addEventListener('click', run)
      item.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        run()
      })
      return item
    }

    function renderActions (): void {
      if (model === null) return
      const { count, canMoveToWindow } = model
      const items = [
        row('New tab in group', plusIcon(), () => { void overlay.request({ type: 'newTab' }) }),
        row('Ungroup', minusIcon(), () => { void overlay.request({ type: 'ungroup' }) })
      ]
      if (canMoveToWindow) items.push(row('Move group to new window', externalLinkIcon(), () => { void overlay.request({ type: 'toWindow' }) }))
      const close = row(closeLabel(count, false), closeIcon(), () => {
        if (armed === undefined) {
          const label = close.querySelector('.item-title')
          if (label !== null) label.textContent = closeLabel(count, true)
          close.classList.add('armed')
          armed = window.setTimeout(() => {
            disarm()
            if (label !== null) label.textContent = closeLabel(count, false)
            close.classList.remove('armed')
          }, ARMED_MS)
          return
        }
        disarm()
        void overlay.request({ type: 'close' })
      }, true)
      items.push(close)
      list.replaceChildren(...items)
    }

    list.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const all = rows()
      all[nextRow(all.length, all.findIndex((item) => item === document.activeElement), event.key as NavKey)]?.focus()
    })

    return {
      shown (payload) {
        disarm()
        if (!isModel(payload)) { overlay.close(); return }
        model = payload
        input.value = payload.title
        swatches.replaceChildren(...payload.colors.map((color) => swatchFor(color, color === payload.color)))
        renderActions()
        // Named at once: a new group is opened to be named, and one being renamed is opened for the same.
        input.focus()
        input.select()
      }
    }
  }
}
