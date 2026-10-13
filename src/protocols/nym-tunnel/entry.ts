// The utility-process entry of the Nym tunnel. The module is WebAssembly: it reaches only the globals service.ts
// hands it, and its only network is module-net.ts's, so a crash or a trap here ends this process, never the shell.
// Started and stopped by src/main/route/ (nym-subsystem.ts).

import { startHost } from './service.js'
import { NYM_TUNNEL_IDENTITY } from './protocol.js'
import type { FromHost, ToHost } from './protocol.js'
import { envName } from '../local-node/protocol.js'

function post (message: FromHost): void {
  process.parentPort.postMessage(message)
}

function main (): void {
  // A promise one tunnel's module left rejected must not end the other apps' tunnels: it is logged, and the tunnel that
  // cannot go on fails its own requests.
  process.on('unhandledRejection', (reason) => {
    console.error('[nym-tunnel] an unhandled rejection:', reason instanceof Error ? reason.message : String(reason))
  })
  let started = false
  process.parentPort.on('message', (event) => {
    const message = event.data as ToHost
    if (message.type !== 'start' || started) return
    started = true
    const log = process.env[envName(NYM_TUNNEL_IDENTITY.name, 'LOG')] === '1' || message.config.log === true
    startHost(message.config, { post, log }).catch(() => {
      // startHost already posted why.
    })
  })
}

main()
