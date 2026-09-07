// Shape validation for messages on a socket's dedicated MessagePortMain
// port -- the write-side counterpart of ./ipc-validation.ts. Every message
// here is UNTRUSTED, not merely unexpected: a compromised renderer PROCESS
// reaches this port directly, unfiltered by contextBridge (which only
// restricts what a PAGE's JS can construct).

import type { CreditMessage, RendererToBrokerMessage, WriteAbortMessage, WriteEndMessage, WriteMessage } from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'

function hasStringHandleId (value: object): value is { handleId: string } {
  return typeof (value as { handleId?: unknown }).handleId === 'string'
}

/**
 * `bytesConsumed` must be finite and non-negative HERE, not left to
 * ./port-pump.ts's own defence, so a NaN/Infinity/negative figure never
 * reaches `handleCredit` at all, rather than relying solely on the pump's
 * own (separately tested) tolerance for the same cases.
 */
export function isCreditMessage (value: unknown): value is CreditMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  if ((value as { kind?: unknown }).kind !== 'credit') return false
  const bytesConsumed = (value as { bytesConsumed?: unknown }).bytesConsumed
  return typeof bytesConsumed === 'number' && Number.isFinite(bytesConsumed) && bytesConsumed >= 0
}

/**
 * `chunk.byteLength` is bounded here too, not only by ./port-sink.ts's own
 * write-window check -- defense in depth against the RETAINED-vs-PEAK
 * distinction: Electron structured-clones a WriteMessage into this process
 * BEFORE anything here runs, so a hostile renderer's oversized chunk has
 * already cost the memory by the time the window check would reject it.
 * This is not the primary backpressure mechanism (the window is); it only
 * stops one single message from being larger than the window could ever
 * admit regardless.
 */
export function isWriteMessage (value: unknown): value is WriteMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  if ((value as { kind?: unknown }).kind !== 'write') return false
  const chunk = (value as { chunk?: unknown }).chunk
  return chunk instanceof Uint8Array && chunk.byteLength <= LIMITS.writeWindowBytes
}

export function isWriteEndMessage (value: unknown): value is WriteEndMessage {
  return typeof value === 'object' && value !== null && hasStringHandleId(value) &&
    (value as { kind?: unknown }).kind === 'write-end'
}

export function isWriteAbortMessage (value: unknown): value is WriteAbortMessage {
  return typeof value === 'object' && value !== null && hasStringHandleId(value) &&
    (value as { kind?: unknown }).kind === 'write-abort'
}

/**
 * Validates and narrows one raw port message to its exact shape, or
 * `undefined` if it matches no recognised kind or fails that kind's own
 * shape check. The one function ./socket-relay.ts needs to route an
 * inbound message without re-deriving the dispatch table itself.
 */
export function parseRendererToBrokerMessage (value: unknown): RendererToBrokerMessage | undefined {
  if (isCreditMessage(value)) return value
  if (isWriteMessage(value)) return value
  if (isWriteEndMessage(value)) return value
  if (isWriteAbortMessage(value)) return value
  return undefined
}
