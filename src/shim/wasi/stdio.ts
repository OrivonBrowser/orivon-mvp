// What fd 0, 1 and 2 are connected to. The embedder passes its own: a
// child process's pipes, or by default the page console.

/** Resolves with at most `max` bytes; an empty array is end of input. */
export interface StdinSource {
  read (max: number): Promise<Uint8Array>
}

/** Awaited before fd_write returns, so a slow consumer pauses the program. */
export type Sink = (bytes: Uint8Array) => void | Promise<void>

export const EMPTY_STDIN: StdinSource = { read: async () => new Uint8Array(0) }

export interface LineSink {
  readonly sink: Sink
  /** Emits a final line with no newline, when the program ends mid-line. */
  flush (): void
}

/** Buffers until a newline so one `printf` does not become several console entries. */
export function lineSink (emit: (line: string) => void): LineSink {
  const decoder = new TextDecoder()
  let pending = ''
  return {
    sink: (bytes) => {
      pending += decoder.decode(bytes, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        emit(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    },
    flush: () => {
      pending += decoder.decode()
      if (pending.length > 0) emit(pending)
      pending = ''
    }
  }
}
