import { createServer } from 'node:net'

let chosen: number | undefined

/**
 * A free port for the verifier's loopback server, chosen synchronously,
 * because the resolver-rules switch naming it must be set before app ready
 * and a subsystem's beforeReady cannot wait. Only a bind with no host is
 * synchronous in Node, so for about a millisecond this listens on every
 * interface with no handler, then closes. The verifier host binds the port
 * later; if something took it meanwhile, that bind fails loudly.
 */
export function loopbackPort (): number {
  if (chosen !== undefined) return chosen
  const probe = createServer()
  probe.listen(0)
  const address = probe.address()
  probe.close()
  if (address === null || typeof address === 'string') throw new Error('could not choose a port for the .eth verifier')
  chosen = address.port
  return chosen
}
