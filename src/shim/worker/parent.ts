// The Worker's side of its control channel, behind an interface so the
// runtime's spawn and fork halves run in a unit test without a real Worker.

import type { FromWorker, StreamName, ToWorker } from './protocol.js'

export interface ParentChannel {
  post (message: FromWorker, transfer?: Transferable[]): void
  /** Registered synchronously while the start message is handled, so nothing sent after it is missed. */
  onMessage (handler: (message: ToWorker) => void): void
}

/** Output the page acknowledges chunk by chunk, so a program writing faster than the page reads is paused. */
export class OutputAcks {
  readonly #waiting: Record<StreamName, Array<() => void>> = { stdout: [], stderr: [] }

  wait (stream: StreamName): Promise<void> {
    return new Promise((resolve) => { this.#waiting[stream].push(resolve) })
  }

  ack (stream: StreamName): void {
    this.#waiting[stream].shift()?.()
  }
}
