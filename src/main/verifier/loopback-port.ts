import { createServer } from 'node:net'

let chosen: number | undefined

/**
 * Where the port is looked for: below every system's default range for the local end of an outgoing connection
 * (Linux from 32768, Windows and macOS from 49152). A port from that range, as `listen(0)` gives, can be handed to a
 * connection to any loopback server between this choice and the host's bind, and the host then never listens: every
 * name the verifier serves fails until the browser restarts.
 */
export const QUIET_PORTS = { first: 20_000, last: 32_767 } as const
const TRIES = 64

/** Binds `port` on every interface and lets it go: true when it was free. A taken port's error comes a tick later and is dropped. */
function bindsNow (port: number): boolean {
  const probe = createServer()
  probe.on('error', () => {})
  probe.listen(port)
  const free = probe.address() !== null
  probe.close()
  return free
}

/** Any free port the system gives, from its range for outgoing connections. */
function anyFreePort (): number {
  const probe = createServer()
  probe.listen(0)
  const address = probe.address()
  probe.close()
  if (address === null || typeof address === 'string') throw new Error('could not choose a port for the .eth verifier')
  return address.port
}

/** A free port in `QUIET_PORTS`, tried at random; any free port when every try was taken. */
export function choosePort (random: () => number, binds: (port: number) => boolean, fallback: () => number): number {
  const span = QUIET_PORTS.last - QUIET_PORTS.first + 1
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const port = QUIET_PORTS.first + Math.floor(random() * span)
    if (binds(port)) return port
  }
  return fallback()
}

/**
 * A free port for the verifier's loopback server, chosen synchronously,
 * because the resolver-rules switch naming it must be set before app ready
 * and a subsystem's beforeReady cannot wait. Only a bind with no host is
 * synchronous in Node, so for about a millisecond this listens on every
 * interface with no handler, then closes. The verifier host binds the port
 * later; if something took it meanwhile, that bind fails loudly.
 */
export function loopbackPort (): number {
  chosen ??= choosePort(Math.random, bindsNow, anyFreePort)
  return chosen
}

let chosenSwarmNode: number | undefined

/** A quiet free port for the Swarm node's API, never the verifier's, and the same until `renewSwarmNodePort`. */
export function swarmNodePort (): number {
  const verifier = loopbackPort()
  chosenSwarmNode ??= choosePort(Math.random, (port) => port !== verifier && bindsNow(port), anyFreePort)
  return chosenSwarmNode
}

/** The node's port was taken after it was chosen: the next `swarmNodePort` is another, never the old one. */
export function renewSwarmNodePort (): void {
  const taken = chosenSwarmNode
  const verifier = loopbackPort()
  chosenSwarmNode = choosePort(Math.random, (port) => port !== verifier && port !== taken && bindsNow(port), anyFreePort)
}
