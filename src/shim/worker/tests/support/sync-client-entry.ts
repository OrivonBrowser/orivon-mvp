// The Worker end of sync-channel.test.ts, run in a real worker_threads
// thread: the synchronous calls block it while the test's thread answers.

import { parentPort, workerData } from 'node:worker_threads'
import type { SyncFileHandle } from '../../../wasi/host.js'
import { createOrivonClient } from '../../orivon-client.js'
import { SYNCHRONOUS } from '../../sync-channel.js'

interface SyncFs {
  readFileSync (path: string): Uint8Array
  open (path: string, flags: string): SyncFileHandle
  stat (path: string): { size: number }
}

const { port, size } = workerData as { port: MessagePort, size: number }
const orivon = createOrivonClient(port) as Record<PropertyKey, unknown> & { fs: SyncFs }
const sync = orivon[SYNCHRONOUS] as { fs: SyncFs, test: { stream (): unknown } }

function outcome (run: () => unknown): unknown {
  try {
    return { value: run() }
  } catch (error) {
    return { error: { name: (error as Error).name, code: (error as { code?: unknown }).code } }
  }
}

function intact (bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index++) if (bytes[index] !== index % 251) return false
  return true
}

const big = orivon.fs.readFileSync('big.bin')
const handle = sync.fs.open('notes.txt', 'w+')
const written = handle.write({ position: 0, data: new TextEncoder().encode('blocking write') })
const readBack = new TextDecoder().decode(handle.read({ position: 0, length: 64 }))
const stat = handle.stat()
handle.close()

parentPort?.postMessage({
  bigLength: big.length,
  bigIntact: big.length === size && intact(big),
  written,
  readBack,
  size: stat.size,
  stream: outcome(() => sync.test.stream()),
  missing: outcome(() => sync.fs.stat('missing.txt'))
})
