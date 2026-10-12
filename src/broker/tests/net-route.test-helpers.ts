// Shared fixtures for the net-route-*.test.ts files: a route whose provider
// records what it was asked and reaches a local server, and brokers wired
// with one route for APP. Not *.test.ts, so vitest does not collect it.

import { connect as netConnect, createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { vi } from 'vitest'
import type { CapabilityKind, Datagram, Pattern } from '../../contracts/index.js'
import type { RoutedDatagram, RoutedUdp, Route, RouteProvider } from '../route/provider.js'
import { createBroker } from '../index.js'
import type { Broker, CreateBrokerOptions } from '../broker-contracts.js'
import { APP, baseDeps, manifestWith } from './index.test-helpers.js'

export interface EchoServer { readonly port: number, close: () => Promise<void> }

/** A loopback TCP server that echoes what it is sent. */
export async function echoServer (): Promise<EchoServer> {
  const open = new Set<Socket>()
  const server: Server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    socket.on('error', () => {})
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of open) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  }
}

export async function connectLocal (port: number): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    socket.once('connect', () => { resolve(socket) })
    socket.once('error', reject)
  })
}

/** A datagram channel the test drives: it records what is sent and lets the test deliver datagrams "from the route". */
export interface FakeUdp extends RoutedUdp {
  readonly sent: RoutedDatagram[]
  deliver: (datagram: RoutedDatagram) => void
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

export function fakeUdp (): FakeUdp {
  const sent: RoutedDatagram[] = []
  let listener: ((datagram: RoutedDatagram) => void) | undefined
  const closing: Array<() => void> = []
  return {
    sent,
    deliver: (datagram) => { listener?.(datagram) },
    send: async (datagram) => { sent.push(datagram) },
    onDatagram: (next) => { listener = next },
    onClose: (next) => { closing.push(next) },
    close: vi.fn(async () => { for (const call of closing) call() })
  }
}

export interface RecordedRoute {
  readonly route: Route
  readonly connects: Array<{ readonly host: string, readonly port: number }>
  readonly resolves: string[]
  readonly udpOpened: { count: number }
}

export interface RouteScript {
  /** The local port every connect reaches. */
  readonly target?: number
  readonly connect?: RouteProvider['connect']
  readonly resolve?: RouteProvider['resolve'] | null
  readonly udp?: FakeUdp | null | (() => Promise<RoutedUdp>)
}

/** A route that records every call. Parts the script leaves out are absent from the provider, as a real provider's can be. */
export function recordedRoute (script: RouteScript = {}): RecordedRoute {
  const connects: Array<{ host: string, port: number }> = []
  const resolves: string[] = []
  const udpOpened = { count: 0 }
  const provider: { -readonly [K in keyof RouteProvider]: RouteProvider[K] } = {
    connect: script.connect ?? (async (host, port) => {
      connects.push({ host, port })
      if (script.target === undefined) throw new Error('no target')
      return await connectLocal(script.target)
    })
  }
  if (script.resolve !== null && script.resolve !== undefined) {
    const resolve = script.resolve
    provider.resolve = async (host, signal) => { resolves.push(host); return await resolve(host, signal) }
  }
  if (script.udp !== null && script.udp !== undefined) {
    const udp = script.udp
    provider.udp = async () => { udpOpened.count += 1; return typeof udp === 'function' ? await udp() : udp }
  }
  return { route: { provider }, connects, resolves, udpOpened }
}

/** A broker where only `APP` has `route`; any other origin has none. */
export function routedBroker (route: Route | undefined, deps: Partial<CreateBrokerOptions> = {}): Broker {
  return createBroker(baseDeps({ routeFor: (key) => key === APP ? route : undefined, ...deps }))
}

export async function registerAndGrant (broker: Broker, capabilities: Parameters<typeof manifestWith>[0], grants: ReadonlyArray<readonly [CapabilityKind, readonly Pattern[]]>): Promise<void> {
  broker.registerApp(APP, manifestWith(capabilities))
  for (const [kind, patterns] of grants) await broker.grant(APP, kind, patterns)
}

export function datagramTo (address: string, port: number, bytes: number[] = [1]): Datagram {
  return { data: new Uint8Array(bytes), address, port, family: address.includes(':') ? 'IPv6' : 'IPv4' }
}
