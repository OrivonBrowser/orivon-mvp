import { PORT_CHANNEL } from '../../main/channels.js'
import { originFromSenderFrame } from '../policy/origin.js'
import type { PortDeliveryFrame } from './port-transport.js'

// Handing one freshly-minted MessagePortMain to the frame that asked for it.
// Extracted from ./ipc.ts's net.connect case when net.udpBind needed the same
// forty lines verbatim -- shared because the REASON is shared, not because the
// shape is (code-guidelines.md Rule 3).
//
// THE RE-DERIVATION BELOW IS THE POINT OF THE FILE. Everything else here is
// error handling.

export interface PortDeliveryOptions {
  /** The origin this request was AUTHORISED for, derived at the top of dispatch(). */
  readonly origin: string
  /** Tags the delivery so the renderer can match it to the descriptor it is about to receive. */
  readonly handleId: string
  /** Live at delivery time, not the value read when the request arrived. */
  readonly frame: PortDeliveryFrame | null
  /** The transferable half of the pair. */
  readonly port2: unknown
  /**
   * Releases everything this request created and throws. Called for every
   * failure below, because a port that never reaches the frame means the app
   * never learns the handle's id -- so it can never close it either, and this
   * is the last chance to release it (handle-contracts.ts's destroy rule: a
   * resource is released exactly once, ALWAYS, "including when the acquisition
   * that would have registered the handle is itself refused... otherwise one
   * fd leaks per attempt against a limit an attacker can hit in a loop").
   */
  readonly abandon: (reason: string) => Promise<never>
}

/**
 * Delivers the port, or abandons the whole acquisition trying.
 *
 * A frame that navigated or was disposed between the request and this call is
 * ORDINARY, not adversarial -- which is why every branch here abandons quietly
 * rather than raising anything the app could distinguish.
 */
export async function deliverPort (options: PortDeliveryOptions): Promise<void> {
  const { origin, handleId, frame, port2, abandon } = options

  if (frame === null) {
    // Unreachable in practice: handleControlRequest already denied a null
    // senderFrame before dispatch() ever runs. Guarded anyway rather than
    // asserted, since a thrown 'internal' is a far better failure mode than a
    // crash if that ordering ever changes.
    await abandon('no frame to deliver the port to')
    return
  }

  // RE-DERIVE, never reuse the origin from the top of this request. dispatch()
  // has awaited a DNS lookup and a dial (or a bind) since then, and
  // `senderFrame` is a live getter, so the frame this port is about to be
  // handed to is not necessarily the frame that was authorised. T17's whole
  // point is that a MessagePort carries NO sender identity -- once delivered
  // it is a bearer capability, and delivering one across an origin change
  // would hand it to a page that never asked for it and holds no grant.
  // policy/origin.ts's rule is to re-derive on every call; this is the second
  // point in such a request where that applies.
  //
  // Electron documents senderFrame as null once a frame has navigated, which
  // the guard above would also catch -- but that is an undocumented lifetime
  // detail to lean on, and this check does not depend on it.
  if (originFromSenderFrame(frame) !== origin) {
    await abandon('the calling frame changed origin before its port could be delivered')
    return
  }

  try {
    frame.postMessage(PORT_CHANNEL, { handleId }, [port2])
  } catch {
    await abandon('the calling frame went away before its port could be delivered')
  }
}
