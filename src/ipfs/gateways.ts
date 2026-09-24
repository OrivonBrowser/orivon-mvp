// Trustless gateways, tried in order. They are trusted for availability
// only: every byte they send is checked by the caller before use.

import { Slots } from '../resolution/slots.js'

export type Fetch = (url: string, init: { readonly headers: Readonly<Record<string, string>>, readonly signal: AbortSignal }) => Promise<Response>

export class GatewayPool {
  private readonly dropped = new Set<string>()
  private readonly slots: Slots

  constructor (private readonly gateways: readonly string[], concurrency: number) {
    if (gateways.length === 0) throw new Error('no IPFS gateway configured')
    this.slots = new Slots(concurrency)
  }

  /** Gateways still in use, in order of preference. */
  usable (): string[] {
    return this.gateways.filter((g) => !this.dropped.has(g))
  }

  /** For the rest of this session: a gateway that sent one bad block is not asked again. */
  drop (gateway: string): void {
    this.dropped.add(gateway)
  }

  /** Runs `task` once fewer than `concurrency` requests are in flight. */
  async withSlot<T> (task: () => Promise<T>): Promise<T> {
    return await this.slots.run(task)
  }
}

export class TooLarge extends Error {
  override readonly name = 'TooLarge'
}

/** The whole body, or TooLarge as soon as it passes `max` bytes, without reading further. */
export async function readCapped (response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel()
    throw new TooLarge(`declared ${String(declared)} bytes, over ${String(max)}`)
  }
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      throw new TooLarge(`over ${String(max)} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
