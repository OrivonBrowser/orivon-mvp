import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hexToBytes, keccak256 } from 'viem'
import { feedUpdateAddress, verifySoc } from '../../src/protocols/swarm/chunk.js'
import { run } from '../swarm-feeds.mjs'

/** secp256k1 private key 1: a test key, never used for anything else. */
export const KEY = `${'0'.repeat(63)}1`
export const OWNER = '7e5f4552091a69125d5dfcb7b8c2659029395bdf'
export const PLUR = 10n ** 16n
export const PRICE = 24_000n
export const cid = (tag: string): string => `bafybei${tag.padEnd(52, 'a')}`
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const kecc = (bytes: Uint8Array): string => hex(keccak256(bytes, 'bytes'))

export interface FakeStamp { id: string, depth: number, ttl: number, utilization: number, usable: boolean, immutable: boolean, label: string, full: boolean, polls: number }
export interface SocRecord { identifier: string, signature: string, data: string, batch: string }

/** A Kubo and a Bee node in memory, speaking just the routes the job calls, as Bee 2.8 answers them. */
export function fakeWorld () {
  const world = {
    price: PRICE,
    wallet: { address: '0xBee0000000000000000000000000000000000001', bzz: 500n * PLUR, xdai: 10n ** 18n },
    ready: true,
    peers: 5,
    stamps: new Map<string, FakeStamp>(),
    onChain: new Set<string>(),
    socs: new Map<string, SocRecord>(),
    feeds: new Map<string, string>(),
    tags: new Map<number, { split: number, synced: number }>(),
    keys: [] as { name: string, id: string }[],
    cids: new Map<string, string>(),
    calls: [] as string[],
    buys: [] as { id: string, amount: bigint, depth: number, immutable: boolean, label: string }[],
    uploads: [] as { batch: string, reference: string, headers: Record<string, string> }[],
    syncStep: 100,
    chunksPerUpload: 5,
    usableAfterPolls: 0,
    failSoc: false,
    failFeedLookup: false
  }
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
    new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
  const stampJson = (s: FakeStamp): unknown => ({ batchID: s.id, utilization: s.utilization, utilizationRatio: s.utilization / 2 ** (s.depth - 16), usable: true, label: s.label, depth: s.depth, amount: '1', bucketDepth: 16, blockNumber: 1, immutableFlag: s.immutable, exists: true, batchTTL: s.ttl })
  const checkBatch = (id: string | null): Response | undefined => {
    const stamp = id === null ? undefined : world.stamps.get(id)
    if (stamp === undefined) return reply(404, { message: 'batch with id not found', code: 404 })
    if (stamp.full) return reply(402, { message: 'batch is overissued', code: 402 })
    return undefined
  }
  const fetchFn = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const path = url.pathname
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    world.calls.push(`${method} ${path}`)
    if (url.host === 'kubo.test') {
      if (path === '/api/v0/key/list') return reply(200, { Keys: [{ Name: 'self', Id: 'k51self' }, ...world.keys.map((k) => ({ Name: k.name, Id: k.id }))] })
      if (path === '/api/v0/name/resolve') {
        const found = world.cids.get(String(url.searchParams.get('arg')).replace('/ipns/', ''))
        return found === undefined ? reply(500, { Message: 'could not resolve name' }) : reply(200, { Path: `/ipfs/${found}` })
      }
      return reply(404)
    }
    if (path === '/readiness') return world.ready ? reply(200, { message: 'OK' }) : reply(400, { message: 'node is not ready' })
    if (path === '/topology') return reply(200, { connected: world.peers })
    if (path === '/wallet') return reply(200, { walletAddress: world.wallet.address, bzzBalance: String(world.wallet.bzz), nativeTokenBalance: String(world.wallet.xdai) })
    if (path === '/addresses') return reply(200, { ethereum: world.wallet.address })
    if (path === '/chainstate') return reply(200, { currentPrice: String(world.price) })
    const buy = /^\/stamps\/(\d+)\/(\d+)$/.exec(path)
    if (buy !== null && method === 'POST') {
      const amount = BigInt(buy[1]!)
      const depth = Number(buy[2])
      if (world.wallet.bzz < amount << BigInt(depth)) return reply(400, { message: 'out of funds', code: 400 })
      world.wallet.bzz -= amount << BigInt(depth)
      const id = (world.stamps.size + 1).toString(16).padStart(64, '0')
      const label = url.searchParams.get('label') ?? ''
      const immutable = headers.get('immutable') === 'true'
      world.stamps.set(id, { id, depth, ttl: Number(amount / world.price) * 5, utilization: 0, usable: world.usableAfterPolls === 0, immutable, label, full: false, polls: 0 })
      world.onChain.add(id)
      world.buys.push({ id, amount, depth, immutable, label })
      return reply(201, { batchID: id, txHash: '0x01' })
    }
    const topUp = /^\/stamps\/topup\/([0-9a-f]{64})\/(\d+)$/.exec(path)
    if (topUp !== null) {
      const stamp = world.stamps.get(topUp[1]!)
      if (stamp === undefined) return reply(404)
      const amount = BigInt(topUp[2]!)
      world.wallet.bzz -= amount << BigInt(stamp.depth)
      stamp.ttl += Number(amount / world.price) * 5
      return reply(202, { batchID: stamp.id })
    }
    const dilute = /^\/stamps\/dilute\/([0-9a-f]{64})\/(\d+)$/.exec(path)
    if (dilute !== null) {
      const stamp = world.stamps.get(dilute[1]!)
      if (stamp === undefined) return reply(404)
      stamp.ttl /= 2 ** (Number(dilute[2]) - stamp.depth)
      stamp.depth = Number(dilute[2])
      stamp.full = false
      return reply(202, { batchID: stamp.id })
    }
    const stamp = /^\/stamps\/([0-9a-f]{64})$/.exec(path)
    if (stamp !== null) {
      const s = world.stamps.get(stamp[1]!)
      if (s === undefined) return reply(404, { message: 'issuer does not exist', code: 404 })
      if (!s.usable && ++s.polls > world.usableAfterPolls) s.usable = true
      return s.usable ? reply(200, stampJson(s)) : reply(400, { message: 'batch not usable', code: 400 })
    }
    const batch = /^\/batches\/([0-9a-f]{64})$/.exec(path)
    if (batch !== null) return world.onChain.has(batch[1]!) ? reply(200, {}) : reply(404, { message: 'batch not found', code: 404 })
    if (path === '/tags' && method === 'POST') {
      const uid = world.tags.size + 1
      world.tags.set(uid, { split: 10, synced: 0 })
      return reply(201, { uid })
    }
    const tag = /^\/tags\/(\d+)$/.exec(path)
    if (tag !== null) {
      const t = world.tags.get(Number(tag[1]))
      if (t === undefined) return reply(404)
      t.synced = Math.min(t.split, t.synced + world.syncStep)
      return reply(200, { uid: Number(tag[1]), split: t.split, seen: 0, stored: 0, sent: t.synced, synced: t.synced })
    }
    if (path === '/bzz' && method === 'POST') {
      const refused = checkBatch(headers.get('swarm-postage-batch-id'))
      if (refused !== undefined) return refused
      const batchId = headers.get('swarm-postage-batch-id')!
      const body = await new Response(init?.body as BodyInit).text()
      const reference = kecc(new TextEncoder().encode(body))
      world.stamps.get(batchId)!.utilization += world.chunksPerUpload
      world.uploads.push({ batch: batchId, reference, headers: Object.fromEntries(headers) })
      return reply(201, { reference }, { 'swarm-tag': '1' })
    }
    const soc = /^\/soc\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(path)
    if (soc !== null && method === 'POST') {
      if (world.failSoc) return reply(500, { message: 'cannot push' })
      const refused = checkBatch(headers.get('swarm-postage-batch-id'))
      if (refused !== undefined) return refused
      const data = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer())
      const signature = url.searchParams.get('sig') ?? ''
      const address = kecc(hexToBytes(`0x${soc[2]!}${soc[1]!}`))
      const chunk = new Uint8Array(Buffer.concat([Buffer.from(soc[2]!, 'hex'), Buffer.from(signature, 'hex'), data]))
      if (await verifySoc(address, chunk) === undefined) return reply(401, { message: 'invalid chunk', code: 401 })
      world.socs.set(address, { identifier: soc[2]!, signature, data: data.toString('hex'), batch: headers.get('swarm-postage-batch-id')! })
      return reply(201, { reference: address })
    }
    if (soc !== null && method === 'GET') return world.socs.has(kecc(hexToBytes(`0x${soc[2]!}${soc[1]!}`))) ? reply(200, 'chunk') : reply(404, { message: 'requested chunk cannot be retrieved', code: 404 })
    const feed = /^\/feeds\/([0-9a-f]{40})\/([0-9a-f]{64})$/.exec(path)
    if (feed !== null && method === 'POST') {
      const refused = checkBatch(headers.get('swarm-postage-batch-id'))
      if (refused !== undefined) return refused
      const reference = kecc(hexToBytes(`0x${feed[1]!}${feed[2]!}`))
      world.feeds.set(`${feed[1]!}/${feed[2]!}`, reference)
      return reply(201, { reference })
    }
    if (feed !== null && method === 'GET') {
      if (world.failFeedLookup) return reply(500, { message: 'lookup failed' })
      let newest = -1
      while (world.socs.has(feedUpdateAddress(feed[1]!, feed[2]!, BigInt(newest + 1)))) newest++
      return newest < 0 ? reply(404, { message: 'lookup at failed', code: 404 }) : reply(200, 'root', { 'swarm-feed-index': newest.toString(16).padStart(16, '0') })
    }
    return reply(404, { message: `the fake has no ${method} ${path}` })
  }) as unknown as typeof fetch
  return { world, fetchFn }
}
export type World = ReturnType<typeof fakeWorld>['world']

/** The newest feed index the world holds for a site, -1 for none. */
export function newestIndex (world: World, topic: string): number {
  let newest = -1
  while (world.socs.has(feedUpdateAddress(OWNER, topic, BigInt(newest + 1)))) newest++
  return newest
}

/** A version as the packer would hand it over: a file whose bytes are the CID, so one CID is always one reference. */
export const fakePack = async ({ cid: version, workDir }: { cid: string, workDir: string }) => {
  mkdirSync(workDir, { recursive: true })
  const file = join(workDir, `${version}.tar`)
  writeFileSync(file, version)
  return { file, bytes: version.length, hasIndex: true, cleanup: () => { rmSync(file, { force: true }) } }
}

export function makeRun (extraEnv: Record<string, string> = {}, extraIo: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-feeds-test-'))
  const keyFile = join(dir, 'signer.key')
  writeFileSync(keyFile, `${KEY}\n`)
  chmodSync(keyFile, 0o600)
  const namesFile = join(dir, 'names.conf')
  writeFileSync(namesFile, '# sites\nexplore explore.orivon.eth explore.eth\nlatest latest.orivon.eth\n')
  const env = { NAMES_FILE: namesFile, SIGNER_KEY_FILE: keyFile, STATE_DIR: join(dir, 'state'), WORK_DIR: join(dir, 'work'), BEE_API: 'http://bee.test', IPFS_API: 'http://kubo.test', SUMMARY_LOG: join(dir, 'summary.md'), ...extraEnv }
  const clock = { t: Date.parse('2026-10-27T12:00:00Z') }
  const logs: string[] = []
  const outs: string[] = []
  const fake = fakeWorld()
  for (const [name, id, version] of [['explore', 'k51explore', cid('a')], ['latest', 'k51latest', cid('b')]] as const) {
    fake.world.keys.push({ name, id })
    fake.world.cids.set(id, version)
  }
  const io = { env, fetchFn: fake.fetchFn, now: () => clock.t, sleep: async (ms: number) => { clock.t += ms }, log: (line: string) => { logs.push(line) }, out: (text: string) => { outs.push(text) }, pack: fakePack, ...extraIo }
  return {
    dir,
    env,
    world: fake.world,
    clock,
    logs,
    outs,
    /** Runs the job; `calls` is what it asked of Bee and Kubo during this run only. */
    async go (...args: string[]): Promise<{ code: number, calls: string[] }> {
      const before = fake.world.calls.length
      const code = await run({ ...io, args })
      return { code, calls: fake.world.calls.slice(before) }
    },
    state: (): any => JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf8')),
    status: (): any => JSON.parse(readFileSync(join(dir, 'state', 'status.json'), 'utf8')),
    journal: (): any[] => readFileSync(join(dir, 'state', 'socs.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
    summary: (): string => { try { return readFileSync(join(dir, 'summary.md'), 'utf8') } catch { return '' } },
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) }
  }
}
export type Run = ReturnType<typeof makeRun>
