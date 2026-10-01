import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { TabGroupState } from '../../main/shell/tab-extra-types.js'
import type { ChromeContext, ChromeModule, TabDecorator } from './context.js'
import { makeChipDraggable } from './tab-group-drag.js'

/** A tab's group, if the state lists it. */
function groupOf (tab: TabState, state: ShellState): TabGroupState | undefined {
  const id = tab.group ?? null
  return id === null ? undefined : state.groups?.find((group) => group.id === id)
}

/** How many tabs a group holds, as the state says. */
export function memberCount (group: TabGroupState, state: ShellState): number {
  return state.tabs.filter((tab) => tab.group === group.id).length
}

/** What a chip reads aloud: the name, how many tabs, and whether they are shown. */
export function chipName (group: TabGroupState, count: number): string {
  const size = `group of ${String(count)} ${count === 1 ? 'tab' : 'tabs'}`
  const open = group.collapsed ? 'collapsed' : 'expanded'
  return group.title === '' ? `Untitled ${size}, ${open}` : `${group.title}, ${size}, ${open}`
}

/** A tab of a group: its colour and group as attributes, and out of sight while the group is collapsed. Runs after
 * the other decorators, so the group's name is appended to the name they set. */
export const decorateTabGroup: TabDecorator = function decorateTabGroup (el, tab, state) {
  const group = groupOf(tab, state)
  if (group === undefined) return
  el.dataset['group'] = group.id
  el.dataset['color'] = group.color
  el.hidden = group.collapsed
  const label = el.getAttribute('aria-label')
  if (label !== null) el.setAttribute('aria-label', `${label}, in group ${group.title === '' ? 'untitled' : group.title}`)
}

/** The place `moveTab` wants for a drop at place `target` among the tabs shown (the held tabs left out): the same place
 * among every tab, hidden ones included, which sits before the tab shown there. */
export function placeAmongAll (row: ParentNode, held: ReadonlyArray<string | null>, target: number): number {
  const tabs = [...row.querySelectorAll<HTMLElement>('.tab')].filter((tab) => !held.includes(tab.dataset['id'] ?? ''))
  const shown = tabs.filter((tab) => !tab.hidden)
  const before = shown[target]
  return before === undefined ? tabs.length : tabs.indexOf(before)
}

function chipFor (group: TabGroupState, count: number, ctx: ChromeContext): HTMLButtonElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'tab-group-chip no-drag'
  chip.classList.toggle('untitled', group.title === '')
  chip.classList.toggle('collapsed', group.collapsed)
  chip.dataset['groupId'] = group.id
  chip.dataset['color'] = group.color
  chip.setAttribute('aria-expanded', String(!group.collapsed))
  chip.setAttribute('aria-haspopup', 'dialog')
  chip.setAttribute('aria-label', chipName(group, count))
  chip.title = group.title === '' ? 'Untitled group' : group.title
  const dot = document.createElement('span')
  dot.className = 'tg-dot'
  chip.append(dot)
  if (group.title !== '') {
    const title = document.createElement('span')
    title.className = 'tg-title'
    title.textContent = group.title
    chip.append(title)
  }
  if (group.collapsed) {
    const tally = document.createElement('span')
    tally.className = 'tg-count'
    tally.textContent = String(count)
    chip.append(tally)
  }
  const openBubble = (): void => { void ctx.shell.act('group.menu', { id: group.id, anchor: ctx.anchorFor(chip) }) }
  chip.addEventListener('click', () => { void ctx.shell.act('group.toggle', { id: group.id }) })
  chip.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openBubble()
  })
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    openBubble()
  })
  // A middle press would start Chromium's autoscroll, and a middle click does nothing here.
  chip.addEventListener('mousedown', (event) => { if (event.button === 1) event.preventDefault() })
  makeChipDraggable(chip, group.id, ctx)
  return chip
}

/** Draws each group's chip before its first tab and sizes the strip to what is shown. Runs at the end of every
 * strip redraw, so a strip redrawn after a drag has its chips too. */
export function placeGroupChips (scroller: HTMLElement, state: ShellState, ctx: ChromeContext): void {
  scroller.querySelectorAll('.tab-group-chip').forEach((chip) => { chip.remove() })
  let chips = 0
  for (const group of state.groups ?? []) {
    const first = scroller.querySelector<HTMLElement>(`.tab[data-group="${CSS.escape(group.id)}"]`)
    if (first === null) continue
    first.before(chipFor(group, memberCount(group, state), ctx))
    chips += 1
  }
  if (chips === 0 && scroller.querySelector('.tab[hidden]') === null) return
  // The strip is as wide as its tabs want to be; a hidden tab wants none, and a chip about half a tab.
  const shown = [...scroller.querySelectorAll('.tab')].filter((tab) => !(tab as HTMLElement).hidden).length
  scroller.style.setProperty('--tab-count', String(Math.max(1, shown + chips * 0.5)))
}

/** Opens the bubble of a group the main process just made, once its chip is on screen. */
export function createTabGroups (): ChromeModule {
  let wanted: string | null = null
  const open = (ctx: ChromeContext): void => {
    if (wanted === null) return
    const chip = document.querySelector<HTMLElement>(`.tab-group-chip[data-group-id="${CSS.escape(wanted)}"]`)
    if (chip === null) return
    const id = wanted
    wanted = null
    // The chip may be out of the scrolled strip: the bubble hangs from where it is.
    chip.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    void ctx.shell.act('group.menu', { id, anchor: ctx.anchorFor(chip) })
  }
  return {
    name: 'tab-groups',
    init: () => {},
    render: (_state, ctx) => { open(ctx) },
    event: (payload, ctx) => {
      const { type, id } = (payload ?? {}) as { type?: unknown, id?: unknown }
      if (type !== 'menu' || typeof id !== 'string') return
      wanted = id
      open(ctx)
    }
  }
}
