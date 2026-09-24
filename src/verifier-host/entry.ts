// The verifier host's utility-process entry: every untrusted parser (CAR,
// dag-pb, IPNS protobuf, the light client's WASM, CCIP answers) runs here,
// never in the main process. It reaches the network only through Electron's
// net, so a configured proxy applies, and it is started and restarted by
// src/main/verifier/.

import { net } from 'electron'
import { startHeliosLightClient } from './light-client.js'
import type { FromHost, ToHost } from './protocol.js'
import { startHost } from './service.js'
import type { RunningHost } from './service.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const FIXTURES_ALLOWED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

function post (message: FromHost): void {
  process.parentPort.postMessage(message)
}

function describe (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function main (): void {
  // A rejection nothing observed would end this process, and every `.eth` page with it; each request's own handler catches what it expects.
  process.on('unhandledRejection', (reason) => { console.error('[verifier] unhandled rejection:', reason) })
  let host: Promise<RunningHost> | undefined
  process.parentPort.on('message', (event) => {
    const message = event.data as ToHost
    if (message.type === 'start') {
      if (host !== undefined) return
      host = startHost(message.config, {
        fetch: async (url, init) => await net.fetch(url, init),
        resolveHost: async (name) => (await net.resolveHost(name)).endpoints.map((endpoint) => endpoint.address),
        post,
        startLightClient: startHeliosLightClient,
        fixturesAllowed: FIXTURES_ALLOWED
      })
      host.then(
        (running) => { post({ type: 'listening', fingerprint: running.fingerprint }) },
        (error: unknown) => { post({ type: 'failed', stage: (error as { code?: unknown }).code === 'EADDRINUSE' ? 'listen' : 'start', message: describe(error) }) }
      )
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
