// Bundled against the shim by ./e2e-child-process.test.ts as the app's
// /thread.js: a worker_threads thread, using fs.promises, workerData and a
// MessageChannel port the page passed in, the way ported validation code
// would run heavy work off the page's own thread. `workerData.sab` also
// proves a thread never routes through the app's child host (ADR-0046's
// amendment): a SharedArrayBuffer only clones into another renderer
// process's Worker, it does not stay entangled with it.

import { promises as fs } from 'fs'
import { parentPort, workerData } from 'worker_threads'

interface Incoming { readonly ping: string, readonly port: MessagePort }
interface ThreadWorkerData { readonly text: string, readonly sab: SharedArrayBuffer }

const { text, sab } = workerData as ThreadWorkerData
const sharedView = new Int32Array(sab)
// Read before write: proves the page's own value already reached this
// thread through `sab` itself, never through a message that happened to
// carry the same number.
const sawFromPage = Atomics.load(sharedView, 0)
Atomics.store(sharedView, 0, 222)

parentPort?.on('message', (message: unknown) => {
  const { ping, port } = message as Incoming
  void fs.writeFile('from-thread.txt', String(text)).then(() => {
    port.postMessage('pong via port')
    parentPort?.postMessage({ echoedPing: ping, wroteText: text, sawFromPage })
  })
})
