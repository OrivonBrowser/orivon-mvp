// Dragging a tab with the browser's own drag and drop, where the pointer's place on the screen is unknown (a native
// Wayland session; tab-drag.ts is the other way). The compositor draws the drag image wherever the pointer is, and
// every window's strip takes the drag over itself, so a window shows where the tab would land before it is let go.
// The drag carries one random nonce under one data type and nothing else: a page under a drag is told its types,
// and a transparent catcher over each page (src/main/shell/drop-catcher.ts) keeps the page out of it.
import { holdStrip, placerFor } from './tab-drag.js'

/** The part of `orivonShell` the drag uses. */
export interface NativeDragShell {
  prepareTabDrag: (id: string) => Promise<string | null>
  warmDropCatchers: () => void
  startNativeTabDrag: (id: string, nonce: string) => void
  dropNativeTab: (nonce: string, index: number | null, below: boolean) => void
  endNativeTabDrag: (nonce: string) => void
  cancelNativeTabDrag: (nonce: string) => void
}

/** The strip, as the drag sees it. */
export interface NativeDragHost {
  /** The strip's tab elements that take room, in order. */
  tabs: () => HTMLElement[]
  isPinned: (el: HTMLElement) => boolean
  /** The tab joined to this one in a split, which is dragged along with it. */
  partnerOf: (el: HTMLElement) => HTMLElement | null
  /** Where `target`, a place among the shown tabs but the `held` ones, falls among every tab (a collapsed group's included). */
  stateIndex: (held: readonly string[], target: number) => number
  /** Draws the insertion line before the tab at `index` among every tab but the `held` ones, or takes it away. */
  showMark: (index: number | null, held: readonly string[]) => void
  /** The window y where the tab strip ends, and where the toolbar does. */
  stripBottom: () => number
  toolbarBottom: () => number
  /** The drag is over: the strip may be redrawn from the newest state. */
  finished: () => void
}

/** How far a press moves before the drop catchers are made ready. */
const PULL_PX = 3
/** How long after a drag ends an Escape key-up still counts as its cancel (measured at 100 to 200 ms). */
const CANCEL_WINDOW_MS = 1000
/** The drag image trails the pointer by this much on both axes, so the cursor stays in sight and the image, a tab or
 * a page, does not lie over the insertion line the strip under the pointer draws. */
const IMAGE_GAP_PX = 16

interface Source { readonly nonce: string, readonly group: HTMLElement[], readonly held: string[], readonly pinned: boolean }
/** What a press on a tab prepared for a drag it may become: the tab's own look as a chip, and its page once main has sent it. */
interface Prepared { readonly id: string, readonly chip: HTMLElement, image: HTMLImageElement | null }

function offscreen (el: HTMLElement): void {
  el.style.position = 'fixed'
  el.style.top = '-10000px'
  el.style.left = '0'
  el.style.pointerEvents = 'none'
}

/** A copy of the tab that setDragImage can draw: in the page but out of sight, and not a tab anything finds. */
function chipOf (tab: HTMLElement): HTMLElement {
  const chip = tab.cloneNode(true) as HTMLElement
  chip.removeAttribute('data-id')
  chip.removeAttribute('role')
  chip.setAttribute('aria-hidden', 'true')
  chip.classList.add('tab-drag-chip')
  chip.style.width = `${String(tab.getBoundingClientRect().width)}px`
  offscreen(chip)
  document.body.append(chip)
  return chip
}

export function createNativeTabDrag (type: string, shell: NativeDragShell, host: NativeDragHost): {
  attach: (el: HTMLElement, id: string) => void
  /** Main's word that a drag from another window is under way (`pinned`: its tab is), or over. */
  setTarget: (on: boolean, pinned: boolean) => void
} {
  let source: Source | null = null
  let target: { readonly pinned: boolean } | null = null
  let pressed: { readonly id: string, readonly x: number, readonly y: number, pulled: boolean } | null = null
  let prepared: Prepared | null = null
  let ended: { readonly nonce: string, readonly at: number } | null = null

  function discard (): void {
    prepared?.chip.remove()
    prepared?.image?.remove()
    prepared = null
  }

  async function addThumbnail (tab: Prepared): Promise<void> {
    const url = await shell.prepareTabDrag(tab.id)
    if (url === null || prepared !== tab) return
    const image = new Image()
    image.src = url
    offscreen(image)
    document.body.append(image)
    try {
      await image.decode()
    } catch {
      image.remove()
      return
    }
    if (prepared === tab) tab.image = image
    else image.remove()
  }

  /** Where a drop at this pointer lands: the place in the strip, or none when the drop is accepted and changes nothing. */
  function landing (event: DragEvent): { index: number | null, below: boolean, held: readonly string[] } {
    if (event.clientY >= host.toolbarBottom()) return { index: null, below: true, held: [] }
    const held = source?.held ?? []
    if (source !== null && event.clientY >= host.stripBottom()) return { index: null, below: false, held }
    const pinned = source?.pinned ?? target?.pinned ?? false
    const placer = placerFor(host.tabs(), source?.group ?? [], pinned, host.isPinned)
    return { index: host.stateIndex(held, placer.placeAt(event.clientX)), below: false, held }
  }

  const carriesTab = (event: DragEvent): boolean => (source !== null || target !== null) && event.dataTransfer?.types.includes(type) === true

  const over = (event: DragEvent): void => {
    if (!carriesTab(event) || event.dataTransfer === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const { index, below, held } = landing(event)
    host.showMark(below ? null : index, held)
  }
  document.addEventListener('dragenter', over, true)
  document.addEventListener('dragover', over, true)
  // Escape ends the drag with a `dragleave` that no longer lists the drag's types.
  document.addEventListener('dragleave', (event) => {
    if ((source !== null || target !== null) && event.relatedTarget === null) host.showMark(null, [])
  }, true)
  document.addEventListener('drop', (event) => {
    if (!carriesTab(event) || event.dataTransfer === null) return
    event.preventDefault()
    const nonce = event.dataTransfer.getData(type)
    const { index, below } = landing(event)
    host.showMark(null, [])
    if (nonce !== '') shell.dropNativeTab(nonce, index, below)
  }, true)
  window.addEventListener('keyup', (event) => {
    if (event.key !== 'Escape' || ended === null || performance.now() - ended.at > CANCEL_WINDOW_MS) return
    shell.cancelNativeTabDrag(ended.nonce)
    ended = null
  })
  window.addEventListener('pointerup', () => {
    pressed = null
    // The press was a click: nothing was dragged. A drag has started by now and keeps what it prepared.
    if (source === null) discard()
  }, true)

  /** The drag is over, however it ended: the strip is whole again and main is told. */
  function finish (): void {
    const finished = source
    if (finished === null) return
    source = null
    pressed = null
    for (const tab of finished.group) tab.classList.remove('drag-source')
    discard()
    host.showMark(null, [])
    holdStrip(false)
    ended = { nonce: finished.nonce, at: performance.now() }
    shell.endNativeTabDrag(finished.nonce)
    host.finished()
  }

  // While the browser's drag runs, no pointer event reaches the page. One that does means the drag ended without a
  // `dragend` (measured on Wayland: a drag that starts with the pointer already out of the chrome view). No drag
  // image was drawn, so the person saw nothing move: the drag ends as cancelled, and the tab stays where it was.
  function lost (): void {
    const nonce = source?.nonce
    if (nonce === undefined) return
    finish()
    shell.cancelNativeTabDrag(nonce)
    ended = null
  }
  for (const type of ['pointermove', 'pointerup', 'pointerdown']) window.addEventListener(type, lost, true)

  function attach (el: HTMLElement, id: string): void {
    el.draggable = true
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('.close, .tab-audio') !== null) return
      pressed = { id, x: event.clientX, y: event.clientY, pulled: false }
      discard()
      const tab: Prepared = { id, chip: chipOf(el), image: null }
      prepared = tab
      void addThumbnail(tab)
    })
    el.addEventListener('pointermove', (event) => {
      if (pressed === null || pressed.pulled || event.buttons !== 1 || Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) < PULL_PX) return
      pressed.pulled = true
      shell.warmDropCatchers()
    })
    el.addEventListener('dragstart', (event) => {
      const transfer = event.dataTransfer
      const ready = prepared
      if (transfer === null || pressed?.id !== id || ready?.id !== id) {
        event.preventDefault()
        return
      }
      const partner = host.partnerOf(el)
      const group = partner === null ? [el] : host.tabs().filter((tab) => tab === el || tab === partner)
      const nonce = crypto.randomUUID()
      // A favicon dragged by itself would add its own address to the data.
      transfer.clearData()
      transfer.setData(type, nonce)
      transfer.effectAllowed = 'move'
      transfer.setDragImage(ready.image ?? ready.chip, -IMAGE_GAP_PX, -IMAGE_GAP_PX)
      source = { nonce, group, held: group.map((tab) => tab.dataset['id'] ?? ''), pinned: host.isPinned(el) }
      holdStrip(true)
      shell.startNativeTabDrag(id, nonce)
      // The tab goes after the browser has taken the drag: hidden inside this event, the drag is lost.
      requestAnimationFrame(() => { for (const tab of group) tab.classList.add('drag-source') })
    })
    el.addEventListener('dragend', finish)
  }

  return {
    attach,
    setTarget: (on, pinned) => {
      target = on ? { pinned } : null
      if (!on) host.showMark(null, [])
    }
  }
}
