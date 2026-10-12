// The Swarm node's utility-process entry. The node is WebAssembly: it reaches
// only the imports node-net.ts and node-fs.ts hand it, and a crash or a trap
// here ends this process, never the shell or the verifier host. Started and
// restarted by src/main/verifier/swarm-node-subsystem.ts.

import { startNode } from './service.js'
import { failure } from './protocol.js'
import type { FromNode, ToNode } from './protocol.js'

function post (message: FromNode): void {
  process.parentPort.postMessage(message)
}

function main (): void {
  process.on('unhandledRejection', (reason) => {
    post(failure('run', reason instanceof Error ? reason.message : String(reason)))
  })
  let started = false
  process.parentPort.on('message', (event) => {
    const message = event.data as ToNode
    if (message.type !== 'start' || started) return
    started = true
    const log = process.env['ORIVON_SWARM_NODE_LOG'] === '1'
    startNode(message.config, { post, ...(log ? { onLog: (line: string) => { console.log(`[swarm-node] ${line}`) } } : {}) }).catch(() => {
      // startNode already posted why.
    })
  })
}

main()
