// Bundled against the shim by ./e2e-node-gaps.test.ts into the fixture app's page script: the Node module
// `constants` and `process.execPath` a dependency reads as it loads, `fs` opens that create in place, file
// calls made while many socket dials hang, and a request whose URL went through `url.parse`. (A torrent client inspired each; random-access-file opens every file with O_RDWR | O_CREAT.)

import constants from 'constants'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import * as url from 'url'

export interface NodeGapsResults {
  readonly constants?: { create: unknown, readWrite: unknown, matchesFs: boolean, errnoNames: boolean }
  readonly execPath?: { type: string, dirname: string }
  readonly createInPlace?: { created: string, kept: string, missingCreated: boolean, secondOpenKeeps: string }
  readonly filesBesideHungDials?: { calls: number, failed: number, firstError: string | undefined, elapsedMs: number, dialConnects: number, dialErrors: number, dialError: string | undefined }
  readonly randomInt?: { inRange: boolean, distinct: number, callbackError: unknown, callbackValue: unknown, badRange: string | undefined }
  readonly copies?: {
    file: string, tree: string[], nested: string, exclusive: string, callbackTree: boolean,
    temp: { inTmpdir: boolean, distinct: boolean, written: string, outside: string }, outside: string
  }
  readonly requests?: Array<{ status?: number | undefined, error?: string | undefined }>
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

/** `crypto.randomInt` in both of its forms, drawn many times so a draw outside the range or a value never reached would show. */
async function randomIntegers (): Promise<NonNullable<NodeGapsResults['randomInt']>> {
  const drawn = Array.from({ length: 300 }, () => crypto.randomInt(3, 9))
  const viaCallback = await new Promise<{ error: unknown, value: unknown }>((resolve) => { crypto.randomInt(10, (error, value) => { resolve({ error, value }) }) })
  let badRange: string | undefined
  try { crypto.randomInt(5, 5) } catch (error) { badRange = (error as { code?: string }).code }
  return {
    inRange: drawn.every((value) => Number.isInteger(value) && value >= 3 && value < 9),
    distinct: new Set(drawn).size,
    callbackError: viaCallback.error,
    callbackValue: viaCallback.value,
    badRange
  }
}

const codeOf = (error: unknown): string => (error as { code?: string }).code ?? String(error)

/** `copyFile`, `cp` and `mkdtemp` on the app's own files, the way a note app duplicates and discards things. */
async function copiesAndTempFolders (): Promise<NonNullable<NodeGapsResults['copies']>> {
  await fs.promises.mkdir('tree/sub', { recursive: true })
  await fs.promises.writeFile('tree/a.txt', 'alpha')
  await fs.promises.writeFile('tree/sub/b.txt', 'beta')
  await fs.promises.copyFile('tree/a.txt', 'tree/a-copy.txt')
  const exclusive = await fs.promises.copyFile('tree/a.txt', 'tree/a-copy.txt', 1).then(() => 'copied', codeOf)
  await fs.promises.cp('tree', 'tree-copy', { recursive: true })
  const callbackTree = await new Promise<boolean>((resolve) => { fs.cp('tree', 'tree-cb', { recursive: true }, (error) => { resolve(error === null) }) })
  const first = await fs.promises.mkdtemp(`${os.tmpdir()}/job-`) as string
  const second = await fs.promises.mkdtemp(`${os.tmpdir()}/job-`) as string
  await fs.promises.writeFile(`${first}/x.txt`, 'in the temp folder')
  return {
    file: await fs.promises.readFile('tree/a-copy.txt', 'utf8'),
    tree: [...await fs.promises.readdir('tree-copy')].sort(),
    nested: await fs.promises.readFile('tree-copy/sub/b.txt', 'utf8'),
    exclusive,
    callbackTree,
    temp: {
      inTmpdir: first.startsWith(`${os.tmpdir()}/job-`),
      distinct: first !== second,
      written: await fs.promises.readFile(`${first}/x.txt`, 'utf8'),
      outside: await fs.promises.mkdtemp('/etc/job-').then(() => 'made', codeOf)
    },
    outside: await fs.promises.cp('tree', '/etc/escaped', { recursive: true }).then(() => 'copied', codeOf)
  }
}

/** `http.get` of a legacy-parsed URL whose path holds characters Node's parser percent-encodes. */
async function requestsAfterUrlParse (port: number): Promise<NonNullable<NodeGapsResults['requests']>> {
  const targets = [`http://127.0.0.1:${String(port)}/16 - Artist "Title" {1}.mp3`, `http://127.0.0.1:${String(port)}/dir\\file.bin?x=1`]
  return await Promise.all(targets.map(async (target) => await new Promise<{ status?: number | undefined, error?: string | undefined }>((resolve) => {
    const parsed = url.parse(target)
    const request = http.get({ hostname: parsed.hostname ?? '', port: parsed.port ?? '', path: parsed.path ?? '' }, (response) => {
      response.resume()
      response.on('end', () => { resolve({ status: response.statusCode }) })
    })
    request.on('error', (error: Error & { code?: string }) => { resolve({ error: `${error.code ?? ''} ${error.message}`.trim() }) })
  })))
}

async function run (): Promise<NodeGapsResults> {
  const port = Number(document.querySelector('meta[name=silent-port]')?.getAttribute('content'))
  const httpPort = Number(document.querySelector('meta[name=http-port]')?.getAttribute('content'))
  return {
    constants: {
      create: constants.O_CREAT,
      readWrite: constants.O_RDWR,
      matchesFs: constants.O_CREAT === fs.constants.O_CREAT && constants.O_RDWR === fs.constants.O_RDWR && constants.O_TRUNC === fs.constants.O_TRUNC,
      errnoNames: typeof constants.ENOENT === 'number' && typeof constants.SIGTERM === 'number'
    },
    execPath: { type: typeof process.execPath, dirname: path.dirname(process.execPath) },
    createInPlace: await createInPlace(),
    filesBesideHungDials: await filesBesideHungDials(port),
    randomInt: await randomIntegers(),
    copies: await copiesAndTempFolders(),
    requests: await requestsAfterUrlParse(httpPort)
  }
}

;(globalThis as unknown as { nodeGapsE2e: { run: () => Promise<NodeGapsResults> } }).nodeGapsE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
