import type { OrivonShell } from '../../preload/shell.js'
import type { ToolbarButtonSpec, ToolbarSlot } from './context.js'

/** Each slot reuses the class of the buttons already in that part of the toolbar, so an added button looks
 * like its neighbours without a rule of its own. */
const SLOT_CLASS: Record<ToolbarSlot, string> = { nav: 'navbtn', address: 'pillbtn', cluster: 'iconbtn' }

/** Adds a button to one of the three slots in index.html. Ordering is CSS (`order`), so modules that add
 * buttons to the same slot need not agree on who initialises first. */
export function toolbarButton (spec: ToolbarButtonSpec, shell: Pick<OrivonShell, 'press'>): HTMLButtonElement {
  const slot = document.querySelector<HTMLElement>(`#${spec.slot}-slot`)
  if (slot === null) throw new Error(`#${spec.slot}-slot missing`)
  const button = document.createElement('button')
  button.id = spec.id
  button.type = 'button'
  button.className = SLOT_CLASS[spec.slot]
  button.title = spec.label
  button.setAttribute('aria-label', spec.label)
  button.style.order = String(spec.order)
  button.append(spec.icon())
  const { presses } = spec
  if (presses !== undefined) button.addEventListener('pointerdown', (event) => { if (event.button === 0) shell.press(presses) })
  button.addEventListener('click', (event) => { spec.onClick(button, event) })
  slot.append(button)
  return button
}
