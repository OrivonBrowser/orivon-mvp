// A few worker threads that check Swarm chunks against their addresses, so the hashing of a site read back from disk or
// from the node does not hold the one thread every protocol the host serves runs on.

import { availableParallelism } from 'node:os'
import type { Worker } from 'node:worker_threads'
import { checkHere } from '../swarm/chunk-check.js'
import type { CheckedOn, ChunkChecker } from '../swarm/chunk-check.js'

/** What the pool sends a thread. The chunk's buffer is a copy, transferred. */
export interface CheckRequest {
  readonly id: number
  readonly address: string
  readonly chunk: Uint8Array
}

/** What a thread answers. */
export interface CheckAnswer {
  readonly id: number
  readonly ok: boolean
}

export interface ChunkCheckPoolOptions {
  /** Starts one thread running `chunk-check-worker`. */
  readonly spawn: () => Worker
  /** How many threads at most. */
  readonly size?: number
  /** How long with nothing to check before the threads end. */
  readonly idleMs?: number
  /** How long a thread with checks waiting may go without answering before it is given up. */
  readonly stallMs?: number
  /** A line for the report log, naming no site or address. */
  readonly log?: (line: string) => void
}

/** One fewer than the cores, at most three: the host's own thread is the one that must not be starved. */
export function defaultPoolSize (): number {
  return Math.max(1, Math.min(3, availableParallelism() - 1))
}

/** Checks waiting at one thread at once: enough that it never idles between two answers. */
const DEPTH = 4
const IDLE_MS = 30_000
const STALL_MS = 5000

interface Task {
  readonly address: string
  readonly chunk: Uint8Array
  readonly resolve: (genuine: boolean) => void
  readonly ran: ((on: CheckedOn) => void) | undefined
}

interface Slot {
  readonly number: number
  readonly worker: Worker
  readonly inflight: Map<number, Task>
  watchdog: ReturnType<typeof setTimeout> | undefined
  ended: boolean
}

/** A code or a name for an error, never its text, which may carry a path. */
function reasonOf (error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown, name?: unknown }
    if (typeof code === 'string') return code
    if (typeof name === 'string') return name
  }
  return 'an error'
}

/**
 * Checks `ChunkChecker.verify` on a few threads, started when a check first waits and ended after `idleMs` with none.
 * A thread that cannot start, dies, or goes `stallMs` without answering ends the pool for the rest of this run: every check
 * waiting is made in the calling thread, one to a turn of the event loop, and so is every later one.
 */
export class ChunkCheckPool implements ChunkChecker {
  private slots: Slot[] = []
  private readonly queue: Array<{ readonly id: number, readonly task: Task }> = []
  private nextId = 0
  private over = false
  private idle: ReturnType<typeof setTimeout> | undefined
  private readonly size: number
  private readonly idleMs: number
  private readonly stallMs: number

  constructor (private readonly options: ChunkCheckPoolOptions) {
    this.size = options.size ?? defaultPoolSize()
    this.idleMs = options.idleMs ?? IDLE_MS
    this.stallMs = options.stallMs ?? STALL_MS
  }

  /** Threads running now. */
  get threads (): number {
    return this.slots.length
  }

  async verify (address: string, chunk: Uint8Array, ran?: (on: CheckedOn) => void): Promise<boolean> {
    if (this.over) {
      ran?.('host')
      return checkHere(address, chunk)
    }
    return await new Promise<boolean>((resolve) => {
      this.queue.push({ id: this.nextId++, task: { address, chunk, resolve, ran } })
      this.pump()
    })
  }

  /** Ends the threads. A check still waiting is made in the calling thread, and so is every later one. */
  close (): void {
    this.end(undefined)
  }

  private pump (): void {
    if (this.over) return
    this.stopIdling()
    while (this.queue.length > 0) {
      const slot = this.freest()
      if (slot === undefined) return
      const { id, task } = this.queue.shift()!
      // A copy that is transferred: the caller's bytes stay its own, and the thread's cost to send is no more than the copy's.
      const copy = new Uint8Array(task.chunk)
      slot.inflight.set(id, task)
      if (slot.watchdog === undefined) this.watch(slot)
      slot.worker.postMessage({ id, address: task.address, chunk: copy } satisfies CheckRequest, [copy.buffer])
    }
  }

  /** The thread with the fewest checks waiting, or a new one when every thread has some and fewer than `size` run. */
  private freest (): Slot | undefined {
    let best: Slot | undefined
    for (const slot of this.slots) {
      if (slot.inflight.size < DEPTH && (best === undefined || slot.inflight.size < best.inflight.size)) best = slot
    }
    if ((best === undefined || best.inflight.size > 0) && this.slots.length < this.size) return this.start()
    return best
  }

  private start (): Slot | undefined {
    let worker: Worker
    try {
      worker = this.options.spawn()
    } catch (error) {
      this.end(`a thread could not start (${reasonOf(error)})`)
      return undefined
    }
    worker.unref()
    const slot: Slot = { number: this.slots.length + 1, worker, inflight: new Map(), watchdog: undefined, ended: false }
    worker.on('message', (answer: CheckAnswer) => { this.answered(slot, answer) })
    worker.on('error', (error: unknown) => { if (!slot.ended) this.end(`a thread failed (${reasonOf(error)})`) })
    worker.on('messageerror', () => { if (!slot.ended) this.end('a thread sent an answer that could not be read') })
    worker.on('exit', (code: number) => { if (!slot.ended) this.end(`a thread exited (code ${String(code)})`) })
    this.slots.push(slot)
    return slot
  }

  private answered (slot: Slot, answer: CheckAnswer): void {
    const task = typeof answer === 'object' && answer !== null ? slot.inflight.get(answer.id) : undefined
    if (slot.ended || task === undefined || typeof answer.ok !== 'boolean') {
      if (!slot.ended) this.end('a thread sent an answer nobody asked for')
      return
    }
    slot.inflight.delete(answer.id)
    task.ran?.(slot.number)
    task.resolve(answer.ok)
    this.watch(slot)
    this.pump()
    if (this.queue.length === 0) this.idleWhenQuiet()
  }

  /** Gives a thread with checks waiting `stallMs` to answer, from its latest answer. */
  private watch (slot: Slot): void {
    if (slot.watchdog !== undefined) clearTimeout(slot.watchdog)
    slot.watchdog = undefined
    if (slot.inflight.size === 0) return
    slot.watchdog = setTimeout(() => { this.end(`a thread gave no answer in ${String(this.stallMs / 1000)} s`) }, this.stallMs)
    slot.watchdog.unref()
  }

  private idleWhenQuiet (): void {
    if (this.over || this.idle !== undefined || this.slots.some((slot) => slot.inflight.size > 0)) return
    this.idle = setTimeout(() => {
      this.idle = undefined
      this.stopThreads()
    }, this.idleMs)
    this.idle.unref()
  }

  private stopIdling (): void {
    if (this.idle !== undefined) clearTimeout(this.idle)
    this.idle = undefined
  }

  /** Ends every thread; the pool starts others when a check next waits. */
  private stopThreads (): void {
    for (const slot of this.slots) {
      slot.ended = true
      if (slot.watchdog !== undefined) clearTimeout(slot.watchdog)
      slot.worker.terminate().catch(() => {})
    }
    this.slots = []
  }

  /** The end of the pool: `why` is logged once, and every check waiting is made in the calling thread. */
  private end (why: string | undefined): void {
    if (this.over) return
    this.over = true
    this.stopIdling()
    if (why !== undefined) this.options.log?.(`swarm: chunks are checked in the host's own thread from now on (${why})`)
    const waiting = this.slots.flatMap((slot) => [...slot.inflight].map(([id, task]) => ({ id, task })))
    waiting.sort((a, b) => a.id - b.id)
    waiting.push(...this.queue.splice(0))
    this.stopThreads()
    this.checkInTurns(waiting.map(({ task }) => task))
  }

  /** One check to a turn of the event loop, as the checks of a site read from disk were made before any thread was. */
  private checkInTurns (tasks: Task[]): void {
    const step = (): void => {
      const task = tasks.shift()
      if (task === undefined) return
      task.ran?.('host')
      task.resolve(checkHere(task.address, task.chunk))
      if (tasks.length > 0) setImmediate(step)
    }
    if (tasks.length > 0) setImmediate(step)
  }
}
