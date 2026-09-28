// wasi:sockets: the network resource, socket creation, and name lookup,
// with tcp.ts and udp.ts. A lookup is started at once and answered
// `would-block` until orivon.net.lookup settles; each address it returns is
// remembered with its name (addresses.ts).

import { type IpAddress, type IpAddressFamily, ResolvedNames, type SocketNet, parseAddress, socketErrorCode } from './addresses.js'
import { type IoError, Pollable } from './io.js'
import { TcpSocket } from './tcp.js'
import { UdpSocket } from './udp.js'

/** wasi:sockets/network's `network`: the one this host hands out stands for the app's own grants. */
export class Network {}

export class ResolveAddressStream {
  #addresses: IpAddress[] | undefined
  #failure: string | undefined
  readonly #settled: Promise<void>

  constructor (net: SocketNet, names: ResolvedNames, name: string) {
    const literal = parseAddress(name)
    if (literal !== undefined) {
      this.#addresses = [literal]
      this.#settled = Promise.resolve()
      return
    }
    this.#settled = net.lookup({ hostname: name }).then(
      (found) => {
        this.#addresses = found.flatMap((entry) => {
          const address = parseAddress(entry.address)
          if (address === undefined) return []
          names.remember(name, address)
          return [address]
        })
      },
      (error: unknown) => { this.#failure = socketErrorCode(error) }
    )
  }

  resolveNextAddress (): IpAddress | undefined {
    if (this.#failure !== undefined) throw this.#failure
    if (this.#addresses === undefined) throw 'would-block'
    return this.#addresses.shift()
  }

  subscribe (): Pollable {
    return new Pollable(() => this.#addresses !== undefined || this.#failure !== undefined, async () => { await this.#settled })
  }
}

export function socketInterfaces (net: SocketNet): Record<string, Record<string, unknown>> {
  const names = new ResolvedNames()
  const network = new Network()
  const context = { net, names }
  return {
    'wasi:sockets/network': { Network, networkErrorCode: (error: IoError): string | undefined => error.code },
    'wasi:sockets/instance-network': { instanceNetwork: (): Network => network },
    'wasi:sockets/tcp': { TcpSocket },
    'wasi:sockets/tcp-create-socket': { createTcpSocket: (family: IpAddressFamily): TcpSocket => new TcpSocket(context, family) },
    'wasi:sockets/udp': { UdpSocket },
    'wasi:sockets/udp-create-socket': { createUdpSocket: (family: IpAddressFamily): UdpSocket => new UdpSocket(net, names, family) },
    'wasi:sockets/ip-name-lookup': {
      ResolveAddressStream,
      resolveAddresses: (_network: Network, name: string): ResolveAddressStream => {
        if (name.length === 0) throw 'invalid-argument'
        return new ResolveAddressStream(net, names, name)
      }
    }
  }
}
