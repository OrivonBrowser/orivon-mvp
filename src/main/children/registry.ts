// ADR-0046's connect() entry point: an app tab asks for a connection to its
// own child host, and this is the one place that checks who is asking and
// closes a host once its origin's last page is gone. `ChildHostPool`
// (./child-host.ts) builds and holds the hosts; `PageTracker`
// (./page-tracker.ts) counts their pages; this file is only the sender check
// and the wiring between the two -- kept separate so each half stays unit
// testable on its own (README.md's own note).

import { MessageChannelMain } from 'electron'
import { originFromSenderFrame } from '../../broker/policy/origin.js'
import type { ControlEvent, PortDeliveryFrame } from '../../broker/transport/relay/port-transport.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { CHILD_HOST_PORT_CHANNEL } from '../channels.js'
import type { ChildHostPool } from './child-host.js'
import type { PageTracker } from './page-tracker.js'

export interface ChildHostRegistry {
  /** One `CHILD_HOST_CONNECT_CHANNEL` request. Silently does nothing for a
   * frame with no derivable origin, or one that is not a registered app --
   * the same refusal shape `appTabArgsFor` gives an ordinary tab, never an
   * error the calling page could distinguish from "no host exists yet". */
  connect (event: ControlEvent): Promise<void>
  /** `before-quit`'s own call: every open host, closed. */
  closeAll (): Promise<void>
}

/**
 * `getBroker` is a lazy thunk, resolved only inside `connect()`, for the same
 * reason `../sessions/web-context-host.ts`'s own `createWebContextHost` takes
 * one: this registry is built and wired in before the broker it needs exists.
 */
export function createChildHostRegistry (
  getBroker: () => Broker,
  pool: ChildHostPool,
  tracker: PageTracker
): ChildHostRegistry {
  /** Origins with a live `tracker.onceEmpty` subscription -- at most one per
   * origin at a time, so two connect() calls for the same origin before its
   * host exists yet do not double-subscribe. Cleared when the subscription
   * fires (the origin's last page just closed, so its host is already being
   * closed too) or the origin's host is closed directly by `closeAll`, so a
   * LATER child at the same origin, with a fresh host, is watched again. */
  const watching = new Set<string>()

  function watchForEmpty (origin: string): void {
    if (watching.has(origin)) return
    watching.add(origin)
    tracker.onceEmpty(origin, () => {
      watching.delete(origin)
      void pool.close(origin)
    })
  }

  async function connect (event: ControlEvent): Promise<void> {
    const origin = originFromSenderFrame(event.senderFrame)
    if (origin === null) return
    if (!getBroker().app.isRegisteredSync(origin)) return

    watchForEmpty(origin)
    const host = await pool.getOrCreate(origin)

    // RE-DERIVE, never reuse the origin from above: `getOrCreate` awaited the
    // host's first document load, which the calling frame could navigate
    // across in the meantime (deliver-port.ts's own rule, same reason).
    const frame: PortDeliveryFrame | null = event.senderFrame
    if (frame === null || originFromSenderFrame(frame) !== origin) return

    const { port1, port2 } = new MessageChannelMain()
    host.postPagePort(port1)
    try {
      frame.postMessage(CHILD_HOST_PORT_CHANNEL, null, [port2])
    } catch {
      // The frame went away between the check above and this call -- ordinary,
      // not adversarial. The host's own end (port1) is simply never used.
    }
  }

  async function closeAll (): Promise<void> {
    watching.clear()
    await pool.closeAll()
  }

  return { connect, closeAll }
}
