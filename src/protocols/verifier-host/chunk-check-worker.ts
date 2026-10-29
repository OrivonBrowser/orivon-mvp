// The thread a ChunkCheckPool starts: it answers each chunk it is sent with whether it is the one at its address.

import { parentPort } from 'node:worker_threads'
import { checkHere } from '../swarm/chunk-check.js'
import type { CheckAnswer, CheckRequest } from './chunk-check-pool.js'

const port = parentPort
if (port === null) throw new Error('chunk-check-worker runs as a worker thread')
port.on('message', (request: CheckRequest) => {
  port.postMessage({ id: request.id, ok: checkHere(request.address, request.chunk) } satisfies CheckAnswer)
})
