// How the host looks a name up for the check of a CCIP-Read gateway: main answers with the addresses the name relay finds while it
// runs, and the host looks the name up itself while it does not. A question main does not answer in time, or answers with a
// refusal, fails the check: the host never falls back to its own lookup for a name the relay was asked about.

import { MAX_ANSWERED_ADDRESSES } from './protocol.js'
import type { AddressAnswer, FromHost } from './protocol.js'

/** The most questions waiting on main at once, and how long one may wait: a lookup through a proxy can take a few queries of five seconds each. */
export const MAX_PENDING = 64
export const ANSWER_TIMEOUT_MS = 20_000

export interface RelayedAddresses {
  /** The addresses of `host`; rejects when main refuses, does not answer in time, or has too many questions waiting. */
  readonly resolve: (host: string) => Promise<readonly string[]>
  /** Main's answer. One for a question that is not waiting (late, repeated, never asked) is dropped. */
  readonly receive: (answer: AddressAnswer) => void
}

export interface RelayedAddressesDeps {
  readonly post: (message: FromHost) => void
  /** The host's own lookup, for the time no relay runs. */
  readonly own: (host: string) => Promise<readonly string[]>
  readonly timeoutMs?: number
}

export function createRelayedAddresses (deps: RelayedAddressesDeps): RelayedAddresses {
  let nextId = 1
  const waiting = new Map<number, { readonly settle: (answer: AddressAnswer) => void }>()
  return {
    resolve: async (host) => {
      if (waiting.size >= MAX_PENDING) throw new Error('too many addresses are being looked up at once')
      const id = nextId++
      const answer = await new Promise<AddressAnswer>((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the name relay did not answer in time')) }, deps.timeoutMs ?? ANSWER_TIMEOUT_MS)
        waiting.set(id, { settle: (given) => { clearTimeout(timer); resolve(given) } })
        deps.post({ type: 'address-lookup', id, host })
      })
      if (answer.kind === 'none') return await deps.own(host)
      if (answer.kind === 'refused' || answer.addresses.length === 0 || answer.addresses.length > MAX_ANSWERED_ADDRESSES) throw new Error('the name relay could not look this name up')
      return answer.addresses
    },
    receive: (answer) => {
      const pending = waiting.get(answer.id)
      if (pending === undefined) return
      waiting.delete(answer.id)
      pending.settle(answer)
    }
  }
}
