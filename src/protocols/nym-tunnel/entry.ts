// The utility-process entry of the Nym tunnel. The module is WebAssembly: it reaches only the globals service.ts
// hands it, and its only network is module-net.ts's, so a crash or a trap here ends this process, never the shell.
// Started and stopped by src/main/route/ (nym-subsystem.ts).

import { startHost } from './service.js'
import type { RunningHost } from './service.js'
import { isNymPrivacy, NYM_TUNNEL_IDENTITY } from './protocol.js'
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
  let running: Promise<RunningHost> | undefined
  process.parentPort.on('message', (event) => {
    const message = event.data as ToHost
    if (message.type === 'privacy') {
      // One that arrives before the start message is no loss: the start carries the level main holds by then.
      if (isNymPrivacy(message.privacy)) void running?.then((host) => { host.setPrivacy(message.privacy) }, () => {})
      return
    }
    if (message.type !== 'start' || running !== undefined) return
    const log = process.env[envName(NYM_TUNNEL_IDENTITY.name, 'LOG')] === '1' || message.config.log === true
    running = startHost(message.config, { post, log })
    running.catch(() => {
      // startHost already posted why.
    })
  })
}

main()
