// The two-click Remove shared by the list and the details view: the first
// click arms it for a few seconds, the second removes. The armed extension is
// kept here, not in a view, so a redraw that lands while it waits (another
// window changed the registry) draws it still armed.
import { armEnded } from '../../shared/armed.js'
import { h } from '../../shared/dom.js'
import type { PageContext } from '../types.js'

const ARM_MS = 4_000

let armedId: string | null = null
let disarmTimer: ReturnType<typeof setTimeout> | undefined
/** The button last drawn for each extension, so a timer or another arming repaints the one on screen. */
const drawn = new Map<string, { button: HTMLButtonElement, name: string }>()

function paint (id: string): void {
  const entry = drawn.get(id)
  if (entry === undefined) return
  const armed = armedId === id
  entry.button.className = armed ? 'btn danger small armed' : 'btn danger small'
  entry.button.textContent = armed ? 'Click again to remove' : 'Remove'
  entry.button.setAttribute('aria-label', armed ? `Confirm removing ${entry.name}` : `Remove ${entry.name}`)
}

function disarm (): void {
  if (disarmTimer !== undefined) clearTimeout(disarmTimer)
  const previous = armedId
  armedId = null
  if (previous !== null) paint(previous)
  armEnded()
}

function arm (id: string): void {
  if (armedId !== null && armedId !== id) disarm()
  armedId = id
  paint(id)
  if (disarmTimer !== undefined) clearTimeout(disarmTimer)
  disarmTimer = setTimeout(disarm, ARM_MS)
}

/** `removed` runs once main has taken the extension away. */
export function removeButton (ext: { readonly id: string, readonly name: string }, ctx: PageContext, removed: () => void): HTMLButtonElement {
  const button = h('button', {
    type: 'button',
    onclick: () => {
      if (armedId !== ext.id) { arm(ext.id); return }
      disarm()
      void ctx.request('remove', { id: ext.id }).then(removed)
    }
  })
  drawn.set(ext.id, { button, name: ext.name })
  paint(ext.id)
  return button
}
