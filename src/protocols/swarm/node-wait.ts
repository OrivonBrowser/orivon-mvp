// The start of the node a Swarm mount reads from: begun when the mount begins, waited for only by a read that has to
// reach an endpoint, so a chunk the memory or the disk holds never waits for it.

/** Starts the node the endpoints name; resolves once it can be read from, rejects in plain words when it will not serve. */
export type StartNode = (signal: AbortSignal) => Promise<void>

/** What a reader calls before it asks an endpoint for anything. */
export type NodeWait = (reader: AbortSignal) => Promise<void>

/** Filled in by the reads that were held for the node: the longest any of them waited, and nothing when none had to. */
export interface Held {
  waitedMs?: number
}

export interface NodeStart {
  /**
   * Resolves once the node can be read from. Rejects with the node's own error when it will not serve, and with `reader`'s
   * reason when the reader gives up first, leaving the start itself running for the readers that remain.
   */
  readonly ready: (reader: AbortSignal, held?: Held) => Promise<void>
  /**
   * The start a read that begins now waits on. A refusal is the node's answer to the ask that was made, never to a later
   * one, and a node can be ready by the time a page asks for a file the mount did not need: this is then a new ask,
   * shared by every read that arrives while it is pending.
   */
  readonly again: () => NodeStart
}

const NO_NODE: NodeStart = { ready: async () => {}, again: () => NO_NODE }

/** `promise`, unless `reader` aborts first; the listener is gone either way. */
async function unlessAborted (promise: Promise<void>, reader: AbortSignal): Promise<void> {
  reader.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(reader.reason) }
    reader.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => { reader.removeEventListener('abort', onAbort); resolve() },
      (error: unknown) => { reader.removeEventListener('abort', onAbort); reject(error) }
    )
  })
}

/**
 * Asks `start` for the node now and returns what the reads wait on. The answer is always observed here, so a mount that
 * finishes without it never leaves a rejection nobody handles; a read that needs it still gets the rejection.
 */
export function startNode (start: StartNode | undefined, signal: AbortSignal): NodeStart {
  if (start === undefined) return NO_NODE
  let state: 'asking' | 'ready' | 'refused' = 'asking'
  const answer = (async () => { await start(signal) })()
  answer.then(() => { state = 'ready' }, () => { state = 'refused' })
  let renewed: NodeStart | undefined
  const self: NodeStart = {
    ready: async (reader, held) => {
      if (state === 'ready') return
      const blocked = state === 'asking'
      const from = Date.now()
      try {
        await unlessAborted(answer, reader)
      } finally {
        if (held !== undefined && blocked) held.waitedMs = Math.max(held.waitedMs ?? 0, Date.now() - from)
      }
    },
    again: () => {
      if (state !== 'refused') return self
      renewed = (renewed ?? startNode(start, signal)).again()
      return renewed
    }
  }
  return self
}
