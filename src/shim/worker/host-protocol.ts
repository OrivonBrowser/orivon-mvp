// The messages between a page and its app's child host (ADR-0046) -- a
// different pair of channels from ./protocol.ts's `ToWorker`/`FromWorker`,
// which stays exactly what it always was: the host's own protocol with the
// real Worker it starts. This file is the one extra hop a host-routed child
// adds in front of that.

import type { ForkStart, FromWorker, SpawnStart, ToWorker } from './protocol.js'

/** A spawn's start, minus what only the host can supply: the compiled
 * program (a `WebAssembly.Module` does not survive the page -> host hop --
 * ADR-0046's Context) and the `orivon` port (the host's own, never the
 * page's). `command` lets the host load the program itself
 * (`../child-process/program.ts`'s `loadProgram`, shared rather than
 * duplicated). */
export type HostSpawnStart = Omit<SpawnStart, 'orivon' | 'program'> & { readonly command: string }

/** A fork's start, minus only `orivon` -- everything else is already a plain
 * URL or plain data. A `worker_threads` thread never reaches here: it stays a
 * local Worker of whatever started it (ADR-0046's amendment), so there is no
 * `HostThreadStart`. */
export type HostForkStart = Omit<ForkStart, 'orivon'>

export type HostStart = HostSpawnStart | HostForkStart

/**
 * One message on the page's own shared connection port (the one
 * `../child-process/host-client.ts` gets from the handshake): a new child,
 * with its own dedicated `MessagePort` transferred along -- "per page port:
 * start requests carry a per-child MessagePort" (ADR-0046's own design).
 * Every message after this one for that child travels on `port` directly,
 * never back on the shared connection port.
 */
export interface StartChildMessage {
  readonly type: 'start-child'
  readonly port: MessagePort
  readonly start: HostStart
  /** Every OTHER transferable the real start message will carry once the
   * host rebuilds it for the real Worker. Always empty today: a spawn and a
   * fork carry none, and a `worker_threads` thread -- the one kind that
   * would (its own `parentPort`, and any `transferList` the app asked for)
   * -- never reaches the host at all. */
  readonly extra: readonly Transferable[]
}

/**
 * What flows over one child's own dedicated port, page -> host. `terminate`
 * is first-class here rather than a `ToWorker` member: a real `Worker`'s own
 * `.terminate()` is a platform call, never a message, everywhere else this
 * protocol is used -- only the extra hop needs a wire form for it at all.
 * Every other member is `ToWorker` unchanged (`stdin`, `stdin-end`, `ack`,
 * `ipc`, `disconnect`), forwarded to the real Worker verbatim.
 */
export type ToHostChild = { readonly type: 'terminate' } | ToWorker

/** host -> page, over the same per-child port: `FromWorker` unchanged. */
export type FromHostChild = FromWorker
