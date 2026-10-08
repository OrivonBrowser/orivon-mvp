// Bundled against the shim by ./e2e-destroy-abandons-dial.test.ts into the fixture app's page script: dials to an
// address that never answers, abandoned by the app, and what the app can do right afterwards. (A peer-to-peer client
// gives up on most of its dials after a few seconds and dials the next peer.)

import * as fs from 'fs'
import * as net from 'net'

export interface AbandonResults {
  /** `orivon.net.connect` with a signal: dials started, settled how, and how long a queued file call waited after the abort. */
  readonly signal?: { closedRejections: number, otherSettled: string[], probePendingBeforeAbort: boolean, probeMsAfterAbort: number, probeError: string | undefined }
  /** `net.Socket#destroy()` while connecting: sockets that closed, errors seen, and how long a fresh dial then took. */
  readonly destroy?: { sockets: number, closed: number, errors: string[], freshConnectMs: number | undefined, freshError: string | undefined, fileCallsMs: number }
  readonly error?: string
}

interface DialApi { net: { connect: (opts: { host: string, port: number, signal: AbortSignal }) => Promise<{ close: () => Promise<void> }> } }

// 290 dials against the broker's bound of 256 in flight at once.
const FIRST_BATCH = 150
const SECOND_BATCH = 140
const SOCKETS = 100

const wait = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** Past the in-flight bound the broker makes a file call wait for a slot; aborting the dials has to hand slots back at once. */
async function signalAbandonsDials (port: number): Promise<NonNullable<AbandonResults['signal']>> {
  const orivon = (globalThis as unknown as { orivon: DialApi }).orivon
  const controllers: AbortController[] = []
  const settled: Array<Promise<string>> = []
  const start = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const controller = new AbortController()
      controllers.push(controller)
      settled.push(orivon.net.connect({ host: '127.0.0.1', port, signal: controller.signal }).then(
        async (socket) => { await socket.close(); return 'connected' },
        (error: { code?: string }) => error.code ?? 'error'
      ))
    }
  }
  // The control channel admits 200 calls in a burst and 100 a second after; two batches keep clear of it.
  start(FIRST_BATCH)
  await wait(1600)
  start(SECOND_BATCH)
  await wait(500)
  const probeStarted = Date.now()
  let probeDoneAt: number | undefined
  let probeError: string | undefined
  const probe = fs.promises.stat('.').then(() => { probeDoneAt = Date.now() }, (error: unknown) => { probeDoneAt = Date.now(); probeError = String(error) })
  await wait(500)
  const probePendingBeforeAbort = probeDoneAt === undefined
  const abortedAt = Date.now()
  for (const controller of controllers) controller.abort()
  await probe
  const outcomes = await Promise.all(settled)
  return {
    closedRejections: outcomes.filter((outcome) => outcome === 'closed').length,
    otherSettled: [...new Set(outcomes.filter((outcome) => outcome !== 'closed'))],
    probePendingBeforeAbort,
    probeMsAfterAbort: (probeDoneAt ?? Date.now()) - abortedAt,
    probeError: probeError === undefined ? undefined : `${probeError} (started ${String(probeStarted)})`
  }
}

/** What a torrent client does to a peer it gave up on: destroy the socket while it is connecting. */
async function destroyAbandonsDials (silentPort: number, livePort: number): Promise<NonNullable<AbandonResults['destroy']>> {
  const errors: string[] = []
  let closed = 0
  const sockets = Array.from({ length: SOCKETS }, () => {
    const socket = net.connect({ host: '127.0.0.1', port: silentPort })
    socket.on('error', (error) => { errors.push(String(error)) })
    socket.on('close', () => { closed += 1 })
    return socket
  })
  await wait(1000)
  for (const socket of sockets) socket.destroy()
  await wait(200)
  const filesStarted = Date.now()
  await fs.promises.writeFile('after-destroy.txt', 'x')
  const fileCallsMs = Date.now() - filesStarted
  const started = Date.now()
  const outcome = await new Promise<{ ms?: number, error?: string }>((resolve) => {
    const fresh = net.connect({ host: '127.0.0.1', port: livePort })
    fresh.on('connect', () => { resolve({ ms: Date.now() - started }); fresh.destroy() })
    fresh.on('error', (error) => { resolve({ error: String(error) }) })
  })
  return { sockets: SOCKETS, closed, errors, freshConnectMs: outcome.ms, freshError: outcome.error, fileCallsMs }
}

async function run (): Promise<AbandonResults> {
  const silentPort = Number(document.querySelector('meta[name=silent-port]')?.getAttribute('content'))
  const livePort = Number(document.querySelector('meta[name=live-port]')?.getAttribute('content'))
  const signal = await signalAbandonsDials(silentPort)
  return { signal, destroy: await destroyAbandonsDials(silentPort, livePort) }
}


;(globalThis as unknown as { abandonE2e: { run: () => Promise<AbandonResults> } }).abandonE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
