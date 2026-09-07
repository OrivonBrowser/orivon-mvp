// Shape validation for messages on a socket's dedicated MessagePortMain
// port -- the write-side counterpart of ./ipc-validation.ts. Every message
// here is UNTRUSTED, not merely unexpected: a compromised renderer PROCESS
// reaches this port directly, unfiltered by contextBridge (which only
// restricts what a PAGE's JS can construct).

import type {
  CreditMessage, DatagramCreditMessage, RendererToBrokerMessage, SendMessage,
  WriteAbortMessage, WriteEndMessage, WriteMessage
} from '../../contracts/index.js'
import { LIMITS } from '../../contracts/index.js'

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

/** A finite, non-negative number, checked here rather than trusted -- see isCreditMessage. */
function isUsableCount (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isDatagramCreditMessage (value: unknown): value is DatagramCreditMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  if ((value as { kind?: unknown }).kind !== 'datagram-credit') return false
  return isUsableCount((value as { datagramsConsumed?: unknown }).datagramsConsumed) &&
    isUsableCount((value as { bytesConsumed?: unknown }).bytesConsumed)
}

/**
 * `data.byteLength` is bounded HERE as well as by the adapter's own check, for
 * the same retained-vs-peak reason isWriteMessage gives: Electron has already
 * structured-cloned the message into this process before any of this runs.
 *
 * `address` and `port` are shape-checked only -- whether this origin may SEND
 * there is a policy question, answered per datagram by ../index.ts's
 * `authorisedSend`, and answering it twice in two places is exactly the
 * duplicate-decision problem code-guidelines.md Rule 3 is about.
 */
export function isSendMessage (value: unknown): value is SendMessage {
  if (typeof value !== 'object' || value === null || !hasStringHandleId(value)) return false
  if ((value as { kind?: unknown }).kind !== 'send') return false
  const data = (value as { data?: unknown }).data
  const address = (value as { address?: unknown }).address
  const port = (value as { port?: unknown }).port
  return data instanceof Uint8Array && data.byteLength <= LIMITS.maxDatagramBytes &&
    typeof address === 'string' && address.length > 0 &&
    typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
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
  if (isDatagramCreditMessage(value)) return value
  if (isSendMessage(value)) return value
  return undefined
}
