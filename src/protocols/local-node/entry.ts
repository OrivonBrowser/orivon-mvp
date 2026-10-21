// The utility-process entry of every local node. The node is WebAssembly: it
// reaches only the imports node-net.ts and node-fs.ts hand it, and a crash or
// a trap here ends this process, never the shell or the verifier host. The
// kind to run comes in the start message's config (kinds.ts). Started and
// restarted by src/main/verifier/ (local-node-controller.ts).

import { kindNamed } from './kinds.js'
import { startNode } from './service.js'
import { envName, failure } from './protocol.js'
import type { FromNode, ToNode } from './protocol.js'
import { createParentRouteSource } from './route-source.js'

function post (message: FromNode): void {
  process.parentPort.postMessage(message)
}

function main (): void {
  process.on('unhandledRejection', (reason) => {
    post(failure('run', reason instanceof Error ? reason.message : String(reason)))
  })
  let started = false
  const routeListeners: Array<(message: ToNode) => void> = []
  const route = createParentRouteSource({ post, listen: (listener) => { routeListeners.push(listener) } })
  process.parentPort.on('message', (event) => {
    const message = event.data as ToNode
    if (message.type === 'route' || message.type === 'route-reset') {
      for (const listener of routeListeners) listener(message)
      return
    }
    if (message.type !== 'start' || started) return
    started = true
    const kind = kindNamed(message.config.kind)
    if (kind === undefined) {
      post(failure('start', `this build has no local node named ${JSON.stringify(message.config.kind)}`))
      return
    }
    const log = process.env[envName(kind.name, 'LOG')] === '1'
    startNode(kind, message.config, { post, route, ...(log ? { onLog: (line: string) => { console.log(`[${kind.name}] ${line}`) } } : {}) }).catch(() => {
      // startNode posts the reason of every setup failure before it rethrows.
    })
  })
}

main()
