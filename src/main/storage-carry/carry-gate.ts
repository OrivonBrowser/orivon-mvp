// Holds the first page of a moved app until its storage has been carried, however long that takes, and runs the carries of
// the apps nobody has opened yet one at a time in the background. A carry that is cut short writes nothing the page can
// meet: the runner clears what it wrote, and the page is let through only when the carry has ended.

/** Whether the carry is due for an origin: `later` when the shell does not serve it as a website yet, so the answer may change. */
export type CarryDue = 'yes' | 'no' | 'later'

/** How a carry came out: it ran to the end, or it could not and cleared what it had written. */
export type CarryEnd = 'carried' | 'failed'

export interface CarryGateDeps {
  readonly due: (origin: string) => CarryDue
  /** Runs the carry and records its outcome. `signal` aborts at the deadline. It does not reject. */
  readonly carry: (origin: string, signal: AbortSignal) => Promise<CarryEnd>
  /** A page of `origin` was let through although its carry failed: the failure becomes final, since the page may write. */
  readonly released: (origin: string) => void
  /** How long one origin's carry may take in all: one deadline per origin, however many pages wait. */
  readonly deadlineMs: number
  readonly onDeadline: (origin: string) => void
}

interface Job {
  readonly done: Promise<void>
  end: CarryEnd | undefined
  releasedReported: boolean
}

export class CarryGate {
  private readonly jobs = new Map<string, Job>()
  private readonly noCarry = new Set<string>()
  private queue: string[] = []
  private draining: Promise<void> | undefined

  constructor (private readonly deps: CarryGateDeps) {}

  /** Resolves when `origin`'s page may load: at once when no carry is due, else when the carry has ended. */
  async ready (origin: string): Promise<void> {
    const job = this.jobFor(origin)
    if (job === undefined) return
    await job.done
    if (job.end === 'failed' && !job.releasedReported) {
      job.releasedReported = true
      this.deps.released(origin)
    }
  }

  /** Queues the carries of `origins` to run in the background, one after another. An origin a page already started is skipped. */
  enqueue (origins: Iterable<string>): void {
    for (const origin of origins) {
      if (!this.jobs.has(origin) && !this.queue.includes(origin)) this.queue.push(origin)
    }
    this.draining ??= this.drain().finally(() => { this.draining = undefined })
  }

  /** Resolves when the background queue is empty. */
  async idle (): Promise<void> {
    await this.draining
  }

  private async drain (): Promise<void> {
    for (;;) {
      const origin = this.queue.shift()
      if (origin === undefined) return
      const job = this.jobFor(origin)
      if (job !== undefined) await job.done
    }
  }

  private jobFor (origin: string): Job | undefined {
    const known = this.jobs.get(origin)
    if (known !== undefined) return known
    if (this.noCarry.has(origin)) return undefined
    const due = this.deps.due(origin)
    if (due === 'later') return undefined
    if (due === 'no') {
      this.noCarry.add(origin)
      return undefined
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      this.deps.onDeadline(origin)
      controller.abort()
    }, this.deps.deadlineMs)
    const job: Job = {
      end: undefined,
      releasedReported: false,
      done: this.deps.carry(origin, controller.signal).then((end) => { job.end = end }, () => { job.end = 'failed' }).finally(() => { clearTimeout(timer) })
    }
    this.jobs.set(origin, job)
    return job
  }
}
