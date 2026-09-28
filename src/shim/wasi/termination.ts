// The two ways a WASI program stops other than returning from `_start`.
// Both are thrown from inside an import, so they unwind the WebAssembly
// stack and reject the promise the embedder is awaiting.

/** `proc_exit(code)`. The embedder reads `code`; it is not a failure of the host. */
export class WasiExit extends Error {
  readonly code: number

  constructor (code: number) {
    super(`WASI program exited with code ${code}`)
    this.name = 'WasiExit'
    this.code = code
  }
}

export type WasiTerminationReason = 'killed' | 'revoked'

/**
 * The host stopped the program at its next import: `kill()` was called, or
 * the grant its files live under was withdrawn. A revoked grant is never an
 * errno, because a program retrying against a root that no longer exists
 * would spin.
 */
export class WasiTerminated extends Error {
  readonly reason: WasiTerminationReason

  constructor (reason: WasiTerminationReason) {
    super(`WASI program terminated: ${reason}`)
    this.name = 'WasiTerminated'
    this.reason = reason
  }
}

export function isTermination (error: unknown): error is WasiExit | WasiTerminated {
  return error instanceof WasiExit || error instanceof WasiTerminated
}
