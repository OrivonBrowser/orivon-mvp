// Where a content-addressed chunk is checked against its address. The check is the one `verifyCac` makes; this file only
// lets the process that runs this protocol choose which thread makes it, and count where each one ran.

import { verifyCac } from './chunk.js'

/** Where one check ran: the number of a worker thread, or `host` for the thread that asked. */
export type CheckedOn = number | 'host'

export interface ChunkChecker {
  /** Answers what `verifyCac` answers, and never rejects. `ran` is told where the check ran, once it has. */
  readonly verify: (address: string, chunk: Uint8Array, ran?: (on: CheckedOn) => void) => Promise<boolean>
}

/** `verifyCac`, but a chunk it cannot make sense of is a chunk that is not at `address`. */
export function checkHere (address: string, chunk: Uint8Array): boolean {
  try {
    return verifyCac(address, chunk)
  } catch {
    return false
  }
}

/** The check in the thread that asks, as every check was made before a checker could be given. */
export const CHECK_HERE: ChunkChecker = {
  verify: async (address, chunk, ran) => {
    ran?.('host')
    return checkHere(address, chunk)
  }
}

/** Where the checks of one mount or one file read ran, for its log line. */
export class CheckTally {
  private readonly threads = new Set<number>()
  private inHost = 0

  note (on: CheckedOn): void {
    if (on === 'host') this.inHost++
    else this.threads.add(on)
  }

  /** ", checked on 3 threads", ", checked in the host", or ", checked on 2 threads and 5 in the host"; nothing when no chunk was checked. */
  describe (): string {
    const threads = this.threads.size
    const where: string[] = []
    if (threads > 0) where.push(`on ${String(threads)} thread${threads === 1 ? '' : 's'}`)
    if (this.inHost > 0) where.push(threads > 0 ? `${String(this.inHost)} in the host` : 'in the host')
    return where.length === 0 ? '' : `, checked ${where.join(' and ')}`
  }
}

/** `checker`, with each check's place also noted in `tally`. */
export function tallied (checker: ChunkChecker, tally: CheckTally): ChunkChecker {
  return {
    verify: async (address, chunk, ran) => await checker.verify(address, chunk, (on) => {
      tally.note(on)
      ran?.(on)
    })
  }
}
