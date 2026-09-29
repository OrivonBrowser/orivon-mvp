// Bundled against the shim by ./e2e-child-process.test.ts as the app's
// /thread.js: a worker_threads thread, using fs.promises, workerData and a
// MessageChannel port the page passed in, the way ported validation code
// would run heavy work off the page's own thread.

import { promises as fs } from 'fs'
import { parentPort, workerData } from 'worker_threads'

interface Incoming { readonly ping: string, readonly port: MessagePort }

parentPort?.on('message', (message: unknown) => {
  const { ping, port } = message as Incoming
  void fs.writeFile('from-thread.txt', String((workerData as { text: string }).text)).then(() => {
    port.postMessage('pong via port')
    parentPort?.postMessage({ echoedPing: ping, wroteText: (workerData as { text: string }).text })
  })
})
