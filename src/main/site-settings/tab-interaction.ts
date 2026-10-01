// When the person last clicked or pressed a key in each tab, and whether that
// input has already been spent on a window. Only input the browser process
// sees counts: a script's `dispatchEvent` never reaches it. Keyed weakly by
// the tab's webContents. No `electron` import: a tab is used only through `on`.

/** The one event of a tab's webContents this reads, typed as Electron emits it. */
export interface InputTab {
  on: (event: 'input-event', listener: (event: unknown, input: { type: string }) => void) => unknown
}

export interface Interaction {
  readonly at: number | null
  readonly consumed: boolean
}

/** Input the person has to make on purpose; pointer movement, scrolling and key release are not. */
export const DELIBERATE_INPUT: ReadonlySet<string> = new Set(['mouseDown', 'pointerDown', 'touchStart', 'rawKeyDown', 'keyDown'])

interface Mark { at: number | null, consumed: boolean }

export class TabInteraction<T extends InputTab & object> {
  private readonly marks = new WeakMap<T, Mark>()

  constructor (private readonly clock: () => number = Date.now) {}

  /** Starts listening to `tab`; calling it again does nothing. */
  watch (tab: T): void {
    if (this.marks.has(tab)) return
    const mark: Mark = { at: null, consumed: false }
    this.marks.set(tab, mark)
    tab.on('input-event', (_event, input) => {
      if (!DELIBERATE_INPUT.has(input.type)) return
      mark.at = this.clock()
      mark.consumed = false
    })
  }

  read (tab: T): Interaction {
    const mark = this.marks.get(tab)
    return mark === undefined ? { at: null, consumed: false } : { at: mark.at, consumed: mark.consumed }
  }

  /** The last input opened a window: the next open needs a new one. */
  consume (tab: T): void {
    const mark = this.marks.get(tab)
    if (mark !== undefined) mark.consumed = true
  }
}
