// Holds the first page of a moved app until its storage has been carried, for as long as the carry takes, up to a bound. The
// carry starts at that first page, not at launch: an app nobody opens costs nothing, and the verifier host the carry
// needs is the one the page needs too.

/** Whether the carry is due for an origin: `later` when the shell does not serve it as a website yet, so the answer may change. */
export type CarryDue = 'yes' | 'no' | 'later'

export interface CarryGateDeps {
  readonly due: (origin: string) => CarryDue
  /** Runs the carry and records its outcome; it does not reject. */
  readonly carry: (origin: string) => Promise<void>
  /** The longest a page waits. The carry goes on after that, and writes nothing over what the page has made by then. */
  readonly boundMs: number
  readonly onBound: (origin: string) => void
}

export class CarryGate {
  private readonly started = new Map<string, Promise<void>>()
  private readonly settled = new Set<string>()
  /** Origins whose page already waited out the bound once: a second page does not wait the same time again. */
  private readonly given = new Set<string>()

  constructor (private readonly deps: CarryGateDeps) {}

  /** Resolves when `origin`'s page may load: at once when no carry is due or it has ended, else when it ends or the bound passes. */
  async ready (origin: string): Promise<void> {
    if (this.settled.has(origin) || this.given.has(origin)) return
    let job = this.started.get(origin)
    if (job === undefined) {
      const due = this.deps.due(origin)
      if (due === 'later') return
      if (due === 'no') {
        this.settled.add(origin)
        return
      }
      job = this.deps.carry(origin).finally(() => { this.settled.add(origin) })
      this.started.set(origin, job)
    }
    await this.waitFor(origin, job)
  }

  private async waitFor (origin: string, job: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<'bound'>((resolve) => { timer = setTimeout(() => { resolve('bound') }, this.deps.boundMs) })
    try {
      if (await Promise.race([job.then(() => 'done' as const), bound]) === 'bound') {
        this.given.add(origin)
        this.deps.onBound(origin)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
