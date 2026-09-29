// The main menu: a list of commands with their keys. Choosing one asks main to
// run it; main closes the popover.
import type { MenuItemView } from '../../main/shell/menu-layout.js'

interface OrivonMenu {
  items: () => Promise<readonly MenuItemView[]>
  run: (id: string) => void
  reportHeight: (height: number) => void
}

declare global {
  interface Window {
    orivonMenu?: OrivonMenu
  }
}

const menu = window.orivonMenu
const list = document.getElementById('items')
if (menu === undefined || list === null) throw new Error('orivonMenu not exposed -- preload did not run')

function entry (item: MenuItemView): HTMLElement {
  const li = document.createElement('li')
  if (item.kind === 'separator') {
    li.className = 'separator'
    li.setAttribute('role', 'separator')
    return li
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'item'
  button.setAttribute('role', 'menuitem')
  const label = document.createElement('span')
  label.textContent = item.label
  const keys = document.createElement('span')
  keys.className = 'keys'
  keys.textContent = item.keys === null ? '' : item.keys.join('+')
  button.append(label, keys)
  button.addEventListener('click', () => { menu?.run(item.id) })
  li.append(button)
  return li
}

void menu.items().then((items) => {
  list.replaceChildren(...items.map(entry))
  // `list`'s own scrollHeight is its full, unclipped content height whatever
  // the popup's CURRENT size already is (style.css's `.items { overflow-y:
  // auto }` is what makes that true); `document.documentElement`'s is not --
  // once the document itself never scrolls (style.css's `overflow: hidden`,
  // for the popup's own rounded corners), it reports only what already fits,
  // which is exactly the wrong number to ask main to grow the popup to.
  const inset = list.getBoundingClientRect().top + (parseFloat(getComputedStyle(list).marginBottom) || 0)
  menu.reportHeight(Math.ceil(list.scrollHeight + inset))
  list.querySelector<HTMLButtonElement>('.item')?.focus()
})

// Arrow keys move through the entries, as in any menu.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const buttons = [...list.querySelectorAll<HTMLButtonElement>('.item')]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = event.key === 'ArrowDown' ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length
  buttons[next]?.focus()
  event.preventDefault()
})
