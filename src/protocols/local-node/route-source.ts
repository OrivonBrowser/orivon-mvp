// How the node's process learns where its tunnel is: it asks main over the parent port, and main answers with the SOCKS5
// server's port and the secret for this start (never an argument or a log line). The answer is kept until main says the
// route is gone or the proxy refuses a connection outright; a refusal from main (the tunnel cannot run) is not kept, so the
// next connection asks again and the node never has a route it was not given.

import { createSocks5Provider } from '../../broker/route/socks5.js'
import type { RouteProvider } from '../../broker/route/provider.js'
import type { RouteSource } from './node-route.js'
import type { FromNode, RouteEndpoint, ToNode } from './protocol.js'

/** The tunnel may be starting; main waits for it a while before it answers. */
export const ASK_TIMEOUT_MS = 120_000
/** A first connection through a tunnel that has just come up takes a few more seconds; the host gives up on a tunnel after 95 s. */
export const PROXY_TIMEOUT_MS = 100_000

export interface ParentChannel {
  readonly post: (message: FromNode) => void
  /** Called with every message main sends after the start. */
  readonly listen: (listener: (message: ToNode) => void) => void
}

export function createParentRouteSource (channel: ParentChannel, askTimeoutMs = ASK_TIMEOUT_MS): RouteSource {
  let nextId = 0
  let known: Promise<RouteProvider> | undefined
  const waiting = new Map<number, { resolve: (endpoint: RouteEndpoint) => void, reject: (error: Error) => void }>()

  channel.listen((message) => {
    if (message.type === 'route-reset') { known = undefined; return }
    if (message.type !== 'route') return
    const asked = waiting.get(message.id)
    if (asked === undefined) return
    waiting.delete(message.id)
    if (message.endpoint === undefined) asked.reject(new Error(message.refusal ?? 'the tunnel is not available'))
    else asked.resolve(message.endpoint)
  })

  const ask = async (): Promise<RouteEndpoint> => await new Promise<RouteEndpoint>((resolve, reject) => {
    nextId += 1
    const id = nextId
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the tunnel did not answer in time')) }, askTimeoutMs)
    timer.unref()
    waiting.set(id, { resolve: (endpoint) => { clearTimeout(timer); resolve(endpoint) }, reject: (error) => { clearTimeout(timer); reject(error) } })
    channel.post({ type: 'route-ask', id })
  })

  return async () => {
    if (known === undefined) {
      const pending = ask().then((endpoint): RouteProvider => {
        const inner = createSocks5Provider({ host: endpoint.host, port: endpoint.port, credentials: { userId: endpoint.userId, password: endpoint.password }, timeoutMs: PROXY_TIMEOUT_MS })
        // A proxy nobody listens on any more is a route that is gone; the next connection asks for the new one.
        const forgetIfGone = (error: unknown): never => {
          if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' && known === pending) known = undefined
          throw error
        }
        return {
          connect: async (host, port, signal) => await inner.connect(host, port, signal).catch(forgetIfGone),
          ...(inner.udp === undefined ? {} : { udp: async (signal) => await (inner.udp as NonNullable<RouteProvider['udp']>)(signal).catch(forgetIfGone) })
        }
      })
      known = pending
      pending.catch(() => { if (known === pending) known = undefined })
    }
    return await known
  }
}
