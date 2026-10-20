// Work that waits for the welcome screen to close: what the first run of a tagged package opens. No Electron here.
import type { IntroPlan } from '../shell/intro-state.js'

export class AfterWelcome {
  private ended = false
  private waiting: Array<() => void> = []

  /** Runs `work` once the welcome screen has closed; at once when it already has, or never showed. */
  whenEnded (work: () => void): void {
    if (this.ended) this.run(work)
    else this.waiting.push(work)
  }

  /** The plan with the end of the screen noticed: the click that leaves it. */
  wrap (intro: IntroPlan | undefined): IntroPlan | undefined {
    if (intro === undefined) return undefined
    return { ...intro, onEntered: async () => { await intro.onEntered(); this.end() } }
  }

  /** Called once the first window exists: a launch with no welcome page in front of it has nothing to wait for. */
  windowOpened (intro: IntroPlan | undefined): void {
    if (intro === undefined || !intro.welcome) this.end()
  }

  private end (): void {
    this.ended = true
    for (const work of this.waiting.splice(0)) this.run(work)
  }

  private run (work: () => void): void {
    try {
      work()
    } catch (error) {
      console.error('[orivon] work that waited for the welcome screen failed:', error)
    }
  }
}
