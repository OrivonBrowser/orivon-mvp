// Shape validation for messages arriving on a socket's dedicated
// MessagePortMain port, the write-side counterpart of ./ipc-validation.ts.
// Split out of ./ipc.ts's inline credit-message check under
// code-guidelines.md Rule 2, once a second and third message kind joined it.
//
// SAME THREAT MODEL AS ./ipc-validation.ts, restated because this is a
// different channel: a compromised renderer PROCESS reaches this port
// directly (it is not gated by contextBridge, which only restricts what a
// PAGE's JS can construct), so every message read here is untrusted, not
// merely unexpected.

import type { CreditMessage, RendererToBrokerMessage, WriteAbortMessage, WriteEndMessage, WriteMessage } from '../contracts/index.js'

function hasStringHandleId (value: object): value is { handleId: string } {
  return typeof (value as { handleId?: unknown }).handleId === 'string'
}

/**
 * `bytesConsumed` must be finite and non-negative HERE, not left to
 * ./port-pump.ts's own defence -- preserved unchanged from the inline check
 * this file replaces, so a NaN/Infinity/negative figure never reaches
 * `handleCredit` at all, rather than relying solely on the pump's own
 * (separately tested) tolerance for the same cases.
 */
export function isCreditMessage (value: unknown): value is CreditMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  if ((value as { kind?: unknown }).kind !== 'credit') return false
  const bytesConsumed = (value as { bytesConsumed?: unknown }).bytesConsumed
  return typeof bytesConsumed === 'number' && Number.isFinite(bytesConsumed) && bytesConsumed >= 0
}

export function isWriteMessage (value: unknown): value is WriteMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  return (value as { kind?: unknown }).kind === 'write' && (value as { chunk?: unknown }).chunk instanceof Uint8Array
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
