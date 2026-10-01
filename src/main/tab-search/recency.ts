// Which tab was in front last, across every window of the process: what orders tab search when nothing is
// typed. A counter, not a clock, so two activations in one millisecond still order.
import type { WebContents } from 'electron'
import type { TabLifecycle } from '../shell/tab-lifecycle.js'

export class Recency {
  private readonly order = new Map<string, number>()
  private counter = 0
  private readonly unsubscribe: () => void

  /** `idOf` names the tab a webContents belongs to, in whichever window it is. */
  constructor (lifecycle: TabLifecycle, idOf: (contents: WebContents) => string | null) {
    this.unsubscribe = lifecycle.subscribe({
      tabActivated: (contents) => {
        const id = idOf(contents)
        if (id !== null) this.touch(id)
      },
      tabClosing: ({ id }) => { this.order.delete(id) }
    })
  }

  touch (id: string): void {
    this.counter += 1
    this.order.set(id, this.counter)
  }

  /** The tab's place in the order, or undefined when it was never seen in front. */
  get (id: string): number | undefined {
    return this.order.get(id)
  }

  /** Read-only view for the model. */
  get map (): ReadonlyMap<string, number> {
    return this.order
  }

  dispose (): void {
    this.unsubscribe()
    this.order.clear()
  }
}
