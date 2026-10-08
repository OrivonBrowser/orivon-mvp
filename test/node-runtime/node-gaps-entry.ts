// Bundled against the shim by ./e2e-node-gaps.test.ts into the fixture app's page script: the Node module
// `constants` and `process.execPath` a dependency reads as it loads, `fs` opens that create in place, and file
// calls made while many socket dials hang. (A torrent client inspired each; random-access-file opens every file with O_RDWR | O_CREAT.)

import constants from 'constants'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'

export interface NodeGapsResults {
  readonly constants?: { create: unknown, readWrite: unknown, matchesFs: boolean, errnoNames: boolean }
  readonly execPath?: { type: string, dirname: string }
  readonly createInPlace?: { created: string, kept: string, missingCreated: boolean, secondOpenKeeps: string }
  readonly filesBesideHungDials?: { calls: number, failed: number, firstError: string | undefined, elapsedMs: number, dialConnects: number, dialErrors: number, dialError: string | undefined }
  readonly error?: string
}

const HUNG_DIALS = 300
const FILE_CALLS = 30

async function createInPlace (): Promise<NonNullable<NodeGapsResults['createInPlace']>> {
  const flags = constants.O_RDWR | constants.O_CREAT
  // Missing: created, and writable.
  const fresh = await fs.promises.open('create-in-place/fresh.bin', flags).catch(async () => {
    await fs.promises.mkdir('create-in-place', { recursive: true })
    return await fs.promises.open('create-in-place/fresh.bin', flags)
  })
  await fresh.write(new TextEncoder().encode('made'), 0, 4, 0)
  await fresh.close()
  const created = await fs.promises.readFile('create-in-place/fresh.bin', 'utf8')

  // Present: kept, not truncated, and written in place at an offset.
  await fs.promises.writeFile('create-in-place/kept.bin', 'abcdefgh')
  const kept = await fs.promises.open('create-in-place/kept.bin', flags)
  await kept.write(new TextEncoder().encode('XY'), 0, 2, 2)
  await kept.close()
  const keptText = await fs.promises.readFile('create-in-place/kept.bin', 'utf8')

  // The same call again over the file it created keeps it too.
  const again = await fs.promises.open('create-in-place/fresh.bin', flags)
  await again.close()
  const secondOpenKeeps = await fs.promises.readFile('create-in-place/fresh.bin', 'utf8')
  return { created, kept: keptText, missingCreated: created === 'made', secondOpenKeeps }
}

/**
 * Dials to an address that never answers, then ordinary file calls beside them. A dial holds one of the
 * origin's operation slots until the broker gives up on it, so the file calls only run if the dials left room.
 */
async function filesBesideHungDials (port: number): Promise<NonNullable<NodeGapsResults['filesBesideHungDials']>> {
  const dialErrors: string[] = []
  let dialConnects = 0
  const sockets = Array.from({ length: HUNG_DIALS }, () => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.on('error', (error) => { dialErrors.push(String(error)) })
    socket.on('connect', () => { dialConnects += 1 })
    return socket
  })
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const started = Date.now()
  const outcomes = await Promise.allSettled(Array.from({ length: FILE_CALLS }, async (_, index) => {
    await fs.promises.writeFile(`beside-dials-${String(index)}.txt`, String(index))
  }))
  const elapsedMs = Date.now() - started
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  const first = failures[0]?.reason as { code?: string, orivonCode?: string, message?: string } | undefined
  for (const socket of sockets) socket.destroy()
  return {
    calls: FILE_CALLS,
    failed: failures.length,
    firstError: first === undefined ? undefined : `${first.code ?? ''} ${first.orivonCode ?? ''} ${first.message ?? ''}`.trim(),
    elapsedMs,
    dialConnects,
    dialErrors: dialErrors.length,
    dialError: dialErrors[0]
  }
}

async function run (): Promise<NodeGapsResults> {
  const port = Number(document.querySelector('meta[name=silent-port]')?.getAttribute('content'))
  return {
    constants: {
      create: constants.O_CREAT,
      readWrite: constants.O_RDWR,
      matchesFs: constants.O_CREAT === fs.constants.O_CREAT && constants.O_RDWR === fs.constants.O_RDWR && constants.O_TRUNC === fs.constants.O_TRUNC,
      errnoNames: typeof constants.ENOENT === 'number' && typeof constants.SIGTERM === 'number'
    },
    execPath: { type: typeof process.execPath, dirname: path.dirname(process.execPath) },
    createInPlace: await createInPlace(),
    filesBesideHungDials: await filesBesideHungDials(port)
  }
}

;(globalThis as unknown as { nodeGapsE2e: { run: () => Promise<NodeGapsResults> } }).nodeGapsE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
