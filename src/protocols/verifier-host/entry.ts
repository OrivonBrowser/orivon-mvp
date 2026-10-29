// The verifier host's utility-process entry: every untrusted parser (UnixFS,
// dag-pb, IPNS protobuf, the light client's WASM, CCIP answers) runs here,
// never in the main process. It reaches the network through Electron's
// net, so a configured proxy applies -- with one deliberate exception,
// dns-fallback.ts's direct connection to a gateway `config.unproxiedGateways`
// already found to have no proxy in front of it, taken only once `net`
// itself has failed that gateway and a DNS-over-HTTPS answer disagreed with
// the system resolver's (A251, docs/open-questions.md). A tunnel-profile
// website's fetches leave through routed-fetch.ts instead, never through net.
// It is started and restarted by src/main/verifier/.

import { net } from 'electron'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { createDirectFetch } from './direct-fetch.js'
import { lookup } from 'node:dns/promises'
import { Worker } from 'node:worker_threads'
import { ChunkCheckPool } from './chunk-check-pool.js'
import { createOutsideFetch } from './outside-fetch.js'
import { createLocalRpcFetch } from './local-rpc-fetch.js'
import { createRoutedFetch } from './routed-fetch.js'
import { answerForFront } from './front-login.js'
import { startHeliosLightClient } from './light-client/light-client.js'
import type { FromHost, ToHost } from './protocol.js'
import { startHost } from './service.js'
import type { RunningHost } from './service.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
/** The code of the chunk check thread as a string; the main build replaces this name with it, and fails if it cannot. */
declare const __ORIVON_CHUNK_CHECK_WORKER__: string
const FIXTURES_ALLOWED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

function post (message: FromHost): void {
  process.parentPort.postMessage(message)
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The names the person asked to resolve outside the tunnel: the system's own resolver, which neither the front nor the proxy setting of this process reaches. */
const resolveOutside = async (name: string): Promise<readonly string[]> => (await lookup(name, { all: true })).map((entry) => entry.address)

function main (): void {
  // A rejection nothing observed would end this process, and every `.eth` page with it; each request's own handler catches what it expects.
  process.on('unhandledRejection', (reason) => { console.error('[verifier] unhandled rejection:', reason) })
  let host: Promise<RunningHost> | undefined
  process.parentPort.on('message', (event) => {
    const message = event.data as ToHost
    if (message.type === 'start') {
      if (host !== undefined) return
      const { front } = message.config
      const tunnelFetch = front === undefined ? undefined : createRequestFetch({ net, answer: answerForFront(front) })
      host = startHost(message.config, {
        // No HTTP cache: one would answer a block another site's pages fetched faster, and so tell a page where the person has been (A256).
        // No credentials: this process's fetches are gateways, RPCs and DNS-over-HTTPS endpoints, never a page's own request, so nothing here should carry a cookie or a client certificate a session might hold.
        // Through the tunnel's front (`config.front`), `net.fetch` would end at the front's 407, so `net.request` answers it: for the front's own port, and no other proxy. It asks for revalidation where `net.fetch` bypassed the cache, and this process's network context is no session's, so no page's fetch fills it.
        fetch: tunnelFetch === undefined
          ? async (url, init) => await net.fetch(url, { ...init, cache: 'no-store', credentials: 'omit' })
          : async (url, init) => await tunnelFetch(url, { ...init, cache: 'no-store' }),
        // A name is never resolved on this computer while the tunnel carries the host's requests: the far end resolves it.
        resolveHost: front === undefined
          ? async (name) => (await net.resolveHost(name)).endpoints.map((endpoint) => endpoint.address)
          : async () => { throw new Error('a name is resolved at the far end of the tunnel, not on this computer') },
        post,
        startLightClient: startHeliosLightClient,
        fixturesAllowed: FIXTURES_ALLOWED,
        directFetch: createDirectFetch(),
        ccipFetch: createDirectFetch({ allowPost: true, allowRedirect: true }),
        // A tunnel profile's website's only way to the network: Node sockets to that profile's front, never `net`. A test build's fixture gateways are plain HTTP.
        routedFetch: (tunnel) => createRoutedFetch({ front: () => message.config.profileFronts?.[tunnel], allowHttp: FIXTURES_ALLOWED }),
        // What the person asked to run outside the tunnel leaves on Node's own sockets, to addresses this process resolves and checks.
        outside: { send: createOutsideFetch(createDirectFetch({ allowPost: true }), resolveOutside), resolveHost: resolveOutside },
        // A server the person runs on this computer or their home network, at an address they typed in: Node sockets straight to it, never `net`, which a proxy or the tunnel's front would carry elsewhere.
        localFetch: createLocalRpcFetch(),
        // The hashing of Swarm chunks, off the thread every protocol is served on. Started from a string: a thread cannot read a file from inside app.asar.
        chunkChecks: new ChunkCheckPool({ spawn: () => new Worker(__ORIVON_CHUNK_CHECK_WORKER__, { eval: true, name: 'orivon chunk check' }), log: (line) => { console.error(`[verifier] ${line}`) } })
      })
      host.then(
        (running) => { post({ type: 'listening', fingerprint: running.fingerprint }) },
        (error: unknown) => { post({ type: 'failed', stage: (error as { code?: unknown }).code === 'EADDRINUSE' ? 'listen' : 'start', message: describe(error) }) }
      )
      return
    }
    if (message.type === 'node') {
      host?.then((running) => { running.node(message) }, () => {})
      return
    }
    if (message.type === 'ipfs-lookup') {
      host?.then((running) => { running.ipfsLookup(message.allowed) }, () => {})
      return
    }
    const { id, request } = message
    if (host === undefined) {
      post({ type: 'reply', id, ok: false, message: 'the verifier host has not been started' })
      return
    }
    host
      .then(async (running) => await running.answer(request))
      .then(
        (value) => { post({ type: 'reply', id, ok: true, value }) },
        (error: unknown) => { post({ type: 'reply', id, ok: false, message: describe(error) }) }
      )
  })
}

main()
