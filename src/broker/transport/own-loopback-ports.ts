// `CreateBrokerOptions['ownLoopbackPort']`: the loopback listeners Orivon runs
// itself, which `orivon.net` must not dial (policy/own-loopback.ts). Each source
// is read on every call, because nodes and route fronts start and stop while the
// browser runs; the Nym SOCKS port is a held node port.

export interface OwnLoopbackSources {
  /** The .eth verifier's port. */
  readonly verifier: () => number
  /** The ports local nodes hold. */
  readonly nodes: () => ReadonlySet<number>
  /** Whether a route front (an app's, a website's or a temporary tab's) listens on `port`. */
  readonly routeFront: (port: number) => boolean
}

export function ownLoopbackPortCheck (sources: OwnLoopbackSources): (port: number) => boolean {
  return (port) => port === sources.verifier() || sources.nodes().has(port) || sources.routeFront(port)
}
