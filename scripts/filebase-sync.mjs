/**
 * Keeps a second copy of what a pinning node serves on Filebase, and only of what it serves now: every IPNS key
 * of the node's Kubo points at one version, and that version is the one Filebase holds. A version a key has
 * moved past is unpinned, with the per-file pins a folder upload leaves behind, so the account's storage
 * follows the live sites and not their history.
 *
 *   FILEBASE_KEY=<IPFS RPC key> node scripts/filebase-sync.mjs [--dry-run]
 *
 * Settings come from the environment: FILEBASE_KEY (required, only ever sent as the Authorization header),
 * IPFS_API (Kubo's RPC, default http://127.0.0.1:5001), KEEP_FILE (CIDs to hold that no key points at, one per
 * line), PROTECT_FILE (the DecentraWiki relay's pins.jsonl: its live pins are never removed), STATE_FILE,
 * SUMMARY_LOG, WORK_DIR, and the limits MAX_BYTES, CAR_MAX_BYTES, GRACE_HOURS, MAX_REMOVE, LIMIT_BYTES.
 * Exit 0 when Filebase holds what it should, 1 when a request failed or removal was held back, 2 for a usage or
 * configuration error. A version that fails to add is tried again after 1 h, then 2 h, 4 h, up to a day.
 *
 * Filebase refuses a file whose bytes hold certain phrases ("Authentication is required", "password to
 * continue", ...) with an empty 403, on `add` and on a block it fetches for `pin/add`: the pin then stays
 * "pinning" until it fails. A CAR import is not filtered, so a version is added that way, and only a version
 * too large for that goes by CID.
 */
import { appendFileSync, createWriteStream, mkdirSync, openAsBlob, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isInvokedDirectly } from './cli.mjs'

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/
const PSA_PAGE = 1000
const HOUR = 3_600_000
const PSA_PAGES = 200

/** A configuration or input error the caller fixes: exit code 2. */
export class UsageError extends Error {}

/**
 * @typedef {{ key: string, cid: string }} Want one IPNS key and the version it points at
 * @typedef {{ size: number | null, created: number | null, name: string | null }} Info what Filebase says of a pin
 * @typedef {{ add: Want[], remove: string[], kept: string[], deferred: number, over: number, blocked: string | null }} Plan
 */

/**
 * One CID per line of the KEEP file; blank lines and `#` comments ignored.
 * @param {string} text
 * @returns {string[]}
 */
export function parseKeep (text) {
  /** @type {string[]} */
  const cids = []
  for (const [i, raw] of text.split('\n').entries()) {
    const cid = raw.replace(/#.*$/, '').trim()
    if (cid === '') continue
    if (!CID.test(cid)) throw new UsageError(`keep file line ${String(i + 1)}: expected a CID`)
    cids.push(cid)
  }
  return cids
}

/**
 * The CIDs the DecentraWiki relay still keeps for its month, read the way the relay reads its own pins.jsonl: a line
 * cut short by a crash is skipped, a `dropped` line forgets the CID, an `expired` line ends it for good.
 * @param {string} text
 * @returns {string[]}
 */
export function liveRelayPins (text) {
  /** @type {Map<string, boolean>} CID to expired */
  const pins = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (typeof record?.cid !== 'string') continue
    if (record.dropped === true) pins.delete(record.cid)
    else if (record.expired === true && record.at === undefined) { if (pins.has(record.cid)) pins.set(record.cid, true) }
    else if (!pins.has(record.cid)) pins.set(record.cid, record.expired === true)
  }
  return [...pins].filter(([, expired]) => !expired).map(([cid]) => cid)
}

/**
 * Gives every pin Filebase did not date the time this node first saw it, so the grace period counts from then; `seen`
 * keeps only the pins still listed.
 * @param {Set<string>} have
 * @param {Map<string, Info>} info
 * @param {Record<string, string>} seen first-seen times from the state file, as ISO strings
 * @param {number} now
 * @returns {{ info: Map<string, Info>, seen: Record<string, string> }}
 */
export function datePins (have, info, seen, now) {
  const dated = new Map(info)
  /** @type {Record<string, string>} */
  const kept = {}
  for (const cid of have) {
    if (dated.get(cid)?.created != null) continue
    const first = Date.parse(seen[cid] ?? '')
    const at = Number.isFinite(first) ? first : now
    kept[cid] = new Date(at).toISOString()
    dated.set(cid, { size: dated.get(cid)?.size ?? null, name: dated.get(cid)?.name ?? null, created: at })
  }
  return { info: dated, seen: kept }
}

/**
 * What to add and what to remove so Filebase holds the versions the keys point at, and whatever is kept or
 * protected, and nothing else. A pin younger than the grace period is left alone (a publisher may have pinned a
 * version just before moving its key), and so is every pin when the list of keys is incomplete: a key that did
 * not resolve must never turn its live version into "old". At most `maxRemove` go in one run, largest first.
 * @param {{ want: Want[], keep: string[], protect: string[], have: Set<string>, info: Map<string, Info>, now: number, graceMs: number, maxRemove: number, complete: boolean }} input
 * @returns {Plan}
 */
export function planSync ({ want, keep, protect, have, info, now, graceMs, maxRemove, complete }) {
  const wanted = new Set(want.map((w) => w.cid))
  const spared = new Set([...keep, ...protect])
  for (const cid of keep) wanted.add(cid)
  const add = [
    ...want.filter((w, i) => !have.has(w.cid) && want.findIndex((o) => o.cid === w.cid) === i),
    ...keep.filter((cid, i) => !have.has(cid) && keep.indexOf(cid) === i && !want.some((w) => w.cid === cid)).map((cid) => ({ key: 'keep', cid }))
  ]
  const kept = [...wanted].filter((cid) => have.has(cid))
  const stale = [...have].filter((cid) => !wanted.has(cid) && !spared.has(cid))
  const old = stale.filter((cid) => {
    const created = info.get(cid)?.created ?? null
    return created === null || now - created >= graceMs
  })
  const size = (/** @type {string} */ cid) => info.get(cid)?.size ?? 0
  old.sort((a, b) => size(b) - size(a) || (a < b ? -1 : 1))
  /** @type {string | null} */
  let blocked = null
  if (!complete) blocked = 'a key or a list the plan depends on could not be read'
  else if (want.length === 0) blocked = 'no key points at anything'
  const remove = blocked === null ? old.slice(0, maxRemove) : []
  return { add, remove, kept, deferred: stale.length - old.length, over: blocked === null ? old.length - remove.length : old.length, blocked }
}

/**
 * Runs `fn` over `items`, at most `limit` at a time.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} fn
 */
async function eachLimited (items, limit, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(/** @type {T} */ (items[next++]))
  }))
}

/**
 * Kubo's RPC API: the IPNS keys of the node, what they point at, and a version as a CAR.
 * @param {{ api: string, fetchFn?: typeof fetch }} config
 */
export function kuboClient ({ api, fetchFn = fetch }) {
  const base = api.replace(/\/+$/, '')
  /** @param {string} path @param {number} [timeout] */
  const post = async (path, timeout = 120_000) => {
    const response = await fetchFn(`${base}/api/v0/${path}`, { method: 'POST', signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`Kubo ${path.split('?')[0]} answered ${String(response.status)}`)
    return response
  }
  return {
    /** @returns {Promise<{ name: string, id: string }[]>} every key but the node's own */
    async keys () {
      const body = /** @type {any} */ (await (await post('key/list?l=true&ipns-base=base36')).json())
      return (body.Keys ?? []).filter((/** @type {any} */ k) => k.Name !== 'self').map((/** @type {any} */ k) => ({ name: String(k.Name), id: String(k.Id) }))
    },
    /**
     * The CID a key points at, from the node's own record: the node published it, so nothing is asked of the network.
     * @param {string} id
     * @returns {Promise<string>}
     */
    async resolve (id) {
      const body = /** @type {any} */ (await (await post(`name/resolve?arg=${encodeURIComponent(`/ipns/${id}`)}&offline=true`)).json())
      const cid = String(body.Path ?? '').replace(/^\/ipfs\//, '')
      if (!CID.test(cid)) throw new Error(`${id} does not point at a CID`)
      return cid
    },
    /** @param {string} cid @returns {Promise<number>} the size of the whole DAG */
    async dagSize (cid) {
      const text = await (await post(`dag/stat?arg=${cid}&progress=false`, 600_000)).text()
      const last = /** @type {any} */ (text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)).pop())
      return Number(last?.TotalSize ?? last?.DagStats?.[0]?.Size ?? last?.Size ?? 0)
    },
    /** @param {string} cid @param {string} file */
    async exportCar (cid, file) {
      const response = await post(`dag/export?arg=${cid}`, 900_000)
      if (response.body === null) throw new Error(`Kubo dag/export gave no body for ${cid}`)
      await pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), createWriteStream(file))
    }
  }
}

/**
 * Filebase: the Kubo-style RPC for pins and uploads, the Pinning Service API for what the RPC does not say (age, size,
 * name, requests that are stuck or failed).
 * @param {{ key: string, rpc: string, psa: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void> }} config
 */
export function filebaseClient ({ key, rpc, psa, fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const authorization = `Bearer ${key}`
  const rpcBase = rpc.replace(/\/+$/, '')
  const psaBase = psa.replace(/\/+$/, '')
  /**
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} [timeout]
   * @param {boolean} [retry] false for an upload: a body that large is not sent again within one run
   * @returns {Promise<Response>}
   */
  async function send (url, init, timeout = 120_000, retry = true) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchFn(url, { ...init, headers: { authorization, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) })
      if (retry && (response.status === 429 || response.status >= 500) && attempt < 4) {
        await sleep(attempt * 2000)
        continue
      }
      return response
    }
  }
  /** @param {string} path @param {number} [timeout] */
  const rpcPost = (path, timeout) => send(`${rpcBase}/api/v0/${path}`, { method: 'POST' }, timeout)
  /** @param {string} query */
  async function psaList (query) {
    /** @type {any[]} */
    const all = []
    let before = ''
    for (let page = 0; page < PSA_PAGES; page++) {
      const response = await send(`${psaBase}/pins?${query}&limit=${String(PSA_PAGE)}${before === '' ? '' : `&before=${encodeURIComponent(before)}`}`, { method: 'GET' })
      if (!response.ok) throw new Error(`Filebase pins answered ${String(response.status)}`)
      const results = /** @type {any[]} */ ((/** @type {any} */ (await response.json())).results ?? [])
      all.push(...results)
      const oldest = results.map((r) => r.created).filter((c) => typeof c === 'string').sort((a, b) => Date.parse(a) - Date.parse(b))[0]
      if (results.length < PSA_PAGE || oldest === undefined || oldest === before) return all
      before = oldest
    }
    throw new Error('Filebase pins list did not end')
  }
  return {
    /** @returns {Promise<Set<string>>} every pinned CID, the per-file ones of an upload included */
    async pins () {
      const response = await rpcPost('pin/ls?type=all')
      if (!response.ok) throw new Error(`Filebase pin/ls answered ${String(response.status)}`)
      return new Set(Object.keys(/** @type {any} */ ((/** @type {any} */ (await response.json())).Keys ?? {})))
    },
    /** @returns {Promise<Map<string, Info>>} */
    async info () {
      /** @type {Map<string, Info>} */
      const map = new Map()
      for (const r of await psaList('status=pinned')) {
        const created = Date.parse(String(r.created))
        const size = Number(r.info?.size)
        map.set(String(r.pin.cid), { size: Number.isFinite(size) ? size : null, created: Number.isFinite(created) ? created : null, name: typeof r.pin.name === 'string' ? r.pin.name : null })
      }
      return map
    },
    /** @returns {Promise<{ requestid: string, cid: string, status: string, created: number | null }[]>} requests that are not pinned */
    async unfinished () {
      return (await psaList('status=queued,pinning,failed')).map((r) => {
        const created = Date.parse(String(r.created))
        return { requestid: String(r.requestid), cid: String(r.pin.cid), status: String(r.status), created: Number.isFinite(created) ? created : null }
      })
    },
    /** @param {string} requestid */
    async dropRequest (requestid) {
      const response = await send(`${psaBase}/pins/${encodeURIComponent(requestid)}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw new Error(`Filebase pin request delete answered ${String(response.status)}`)
    },
    /** @param {string} cid */
    async unpin (cid) {
      const response = await rpcPost(`pin/rm?arg=${cid}`)
      if (!response.ok && !/not pinned/i.test(await response.text())) throw new Error(`Filebase pin/rm answered ${String(response.status)}`)
    },
    /** @param {string} cid */
    async isPinned (cid) {
      const response = await rpcPost(`pin/ls?arg=${cid}&type=recursive`)
      if (!response.ok) return false
      return Object.keys(/** @type {any} */ ((/** @type {any} */ (await response.json())).Keys ?? {})).includes(cid)
    },
    /** @param {string} cid asks Filebase to fetch the DAG itself, which it does not report done */
    async pinByCid (cid) {
      const response = await rpcPost(`pin/add?arg=${cid}`)
      if (!response.ok) throw new Error(`Filebase pin/add answered ${String(response.status)}`)
    },
    /** @param {string} cid @param {string} file a CAR whose root is `cid` */
    async importCar (cid, file) {
      const form = new FormData()
      form.append('file', await openAsBlob(file), `${cid}.car`)
      const response = await send(`${rpcBase}/api/v0/dag/import?pin-roots=true`, { method: 'POST', body: form }, 1_800_000, false)
      const text = await response.text()
      if (!response.ok) throw new Error(`Filebase dag/import answered ${String(response.status)}`)
      const roots = text.split('\n').filter((l) => l.trim() !== '').map((l) => /** @type {any} */ (JSON.parse(l)).Root).filter((r) => r !== undefined)
      const root = roots.find((r) => r?.Cid?.['/'] === cid)
      if (root === undefined) throw new Error('Filebase dag/import did not report the root')
      if (typeof root.PinErrorMsg === 'string' && root.PinErrorMsg !== '') throw new Error(`Filebase dag/import: ${root.PinErrorMsg}`)
    }
  }
}

/** @param {number} bytes */
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`

/**
 * @param {{ env: Record<string, string | undefined>, args: string[], fetchFn?: typeof fetch, now?: () => number, log?: (line: string) => void }} io
 * @returns {Promise<number>} the exit code
 */
export async function run ({ env, args, fetchFn = fetch, now = Date.now, log = (line) => { console.log(`[filebase-sync] ${line}`) } }) {
  try {
    const unknown = args.filter((a) => a !== '--dry-run')
    if (unknown.length > 0) throw new UsageError('usage: filebase-sync.mjs [--dry-run]')
    const dryRun = args.includes('--dry-run')
    const key = env.FILEBASE_KEY ?? ''
    if (key === '') throw new UsageError('FILEBASE_KEY must be set in the environment')
    const number = (/** @type {string} */ name, /** @type {number} */ fallback) => {
      const raw = env[name]
      const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
      if (!Number.isFinite(value) || value < 0) throw new UsageError(`${name} is not a number`)
      return value
    }
    const maxBytes = number('MAX_BYTES', 1024 ** 3)
    const carMax = number('CAR_MAX_BYTES', 300 * 1024 ** 2)
    const graceMs = number('GRACE_HOURS', 2) * HOUR
    const maxRemove = number('MAX_REMOVE', 300)
    const limitBytes = number('LIMIT_BYTES', 5e9)
    const workDir = env.WORK_DIR ?? join(env.STATE_DIRECTORY ?? tmpdir(), 'filebase-sync')
    const keep = env.KEEP_FILE === undefined ? [] : parseKeep(readFileSync(env.KEEP_FILE, 'utf8'))
    const stateFile = env.STATE_FILE
    /** @type {{ reported: Record<string, string>, seen: Record<string, string>, failures: Record<string, { at: string, n: number, message: string }>, keys: string[] }} */
    let state = { reported: {}, seen: {}, failures: {}, keys: [] }
    if (stateFile !== undefined) {
      try { state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch { /* first run */ }
    }
    const summary = (/** @type {string} */ line) => {
      if (dryRun || env.SUMMARY_LOG === undefined) return
      appendFileSync(env.SUMMARY_LOG, `- ${new Date(now()).toISOString().slice(0, 10)}: ${line}\n`)
    }

    const kubo = kuboClient({ api: env.IPFS_API ?? 'http://127.0.0.1:5001', fetchFn })
    const filebase = filebaseClient({ key, rpc: env.FILEBASE_RPC ?? 'https://rpc.filebase.io', psa: env.FILEBASE_PSA ?? 'https://api.filebase.io/v1/ipfs', fetchFn })
    let failed = false
    let complete = true
    if (!dryRun) {
      // A run killed mid-transfer leaves its CAR behind.
      try { for (const name of readdirSync(workDir)) if (name.endsWith('.car')) rmSync(join(workDir, name), { force: true }) } catch { /* no work directory yet */ }
    }

    /** @type {Want[]} */
    const want = []
    const keys = await kubo.keys()
    for (const k of keys) {
      try {
        want.push({ key: k.name, cid: await kubo.resolve(k.id) })
      } catch (error) {
        complete = false
        failed = true
        log(`key ${k.name}: not read (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    // Far fewer keys than last time means this is not the node it was (a restored keystore, a wrong IPFS_API), and everything the missing keys held would look old.
    const names = new Set(keys.map((k) => k.name))
    const gone = state.keys.filter((name) => !names.has(name))
    if (state.keys.length > 0 && gone.length * 4 > state.keys.length) {
      complete = false
      failed = true
      log(`${String(gone.length)} of the ${String(state.keys.length)} keys seen before are gone (${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', ...' : ''}); nothing is removed until the state file's keys are cleared`)
    }
    /** @type {string[]} */
    let protect = []
    if (env.PROTECT_FILE !== undefined) {
      try { protect = liveRelayPins(readFileSync(env.PROTECT_FILE, 'utf8')) } catch (error) {
        // No file yet is a relay that has pinned nothing; any other failure leaves live pins unknown.
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
          complete = false
          failed = true
          log(`protect file not read (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    }
    const have = await filebase.pins()
    /** @type {Map<string, Info>} */
    let info = new Map()
    try { info = await filebase.info() } catch (error) { log(`pin details not read (${error instanceof Error ? error.message : String(error)}); a pin counts from the first run that saw it`) }

    const dated = datePins(have, info, state.seen, now())
    info = dated.info
    state.seen = dated.seen
    const plan = planSync({ want, keep, protect, have, info, now: now(), graceMs, maxRemove, complete })
    if (plan.blocked !== null) { failed = true; log(`not removing anything: ${plan.blocked}`) }
    if (plan.deferred > 0) log(`${String(plan.deferred)} unlisted pin(s) are younger than the grace period and stay for now`)
    if (plan.over > 0 && plan.blocked === null) log(`${String(plan.over)} more unlisted pin(s) wait for the next run (at most ${String(maxRemove)} a run)`)

    const unfinished = await filebase.unfinished().catch((error) => { log(`pin requests not read (${error instanceof Error ? error.message : String(error)})`); return [] })
    const adding = new Set(plan.add.map((w) => w.cid))
    const spared = new Set([...want.map((w) => w.cid), ...keep, ...protect])
    for (const request of unfinished) {
      const replaced = request.status === 'failed' && adding.has(request.cid)
      const stale = !spared.has(request.cid) && plan.blocked === null && (request.created === null || now() - request.created >= graceMs)
      if (!replaced && !stale) continue
      log(`${dryRun ? 'would drop' : 'drop'} the ${request.status} pin request for ${request.cid}`)
      if (dryRun) continue
      try { await filebase.dropRequest(request.requestid) } catch (error) { failed = true; log(`dropping the request for ${request.cid} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }

    /** @type {string[]} */
    const added = []
    let addedBytes = 0
    /** @type {string[]} */
    const errors = []
    /** @type {{ item: Want, size: number }[]} */
    const sized = []
    for (const item of plan.add) {
      try { sized.push({ item, size: await kubo.dagSize(item.cid) }) } catch (error) { errors.push(`${item.key} ${item.cid}: size not read (${error instanceof Error ? error.message : String(error)})`) }
    }
    sized.sort((a, b) => a.size - b.size)
    /** @type {Record<string, { at: string, n: number, message: string }>} */
    const failures = {}
    for (const { item, size } of sized) {
      const label = `${item.key} ${item.cid} (${mb(size)})`
      if (size > maxBytes) { errors.push(`${label}: larger than MAX_BYTES, not added`); continue }
      const before = state.failures[item.cid]
      if (before !== undefined && now() < Date.parse(before.at) + Math.min(24 * HOUR, HOUR * 2 ** (before.n - 1))) {
        failures[item.cid] = before
        errors.push(before.message)
        log(`${label}: failed before, waiting to try again`)
        continue
      }
      log(`${dryRun ? 'would add' : 'add'} ${label} by ${size <= carMax ? 'CAR import' : 'CID'}`)
      if (dryRun) continue
      const file = join(workDir, `${item.cid}.car`)
      try {
        // The list of pins may have been cut short; asking for this one keeps a held version from being uploaded again.
        if (await filebase.isPinned(item.cid)) continue
        if (size <= carMax) {
          mkdirSync(workDir, { recursive: true })
          await kubo.exportCar(item.cid, file)
          await filebase.importCar(item.cid, file)
          if (!await filebase.isPinned(item.cid)) throw new Error('Filebase took the import but does not list the pin')
        } else {
          await filebase.pinByCid(item.cid)
        }
        added.push(label)
        addedBytes += size
      } catch (error) {
        const message = `${label}: ${error instanceof Error ? error.message : String(error)}`
        errors.push(message)
        failures[item.cid] = { at: new Date(now()).toISOString(), n: (before?.n ?? 0) + 1, message }
      } finally {
        rmSync(file, { force: true })
      }
    }

    /** @type {string[]} */
    const removed = []
    let freed = 0
    await eachLimited(plan.remove, 4, async (cid) => {
      const detail = info.get(cid)
      log(`${dryRun ? 'would remove' : 'remove'} ${cid}${detail?.name != null && detail.name !== cid ? ` (${detail.name})` : ''} ${detail?.size != null ? mb(detail.size) : ''}`.trim())
      if (dryRun) return
      try {
        await filebase.unpin(cid)
        removed.push(cid)
        freed += detail?.size ?? 0
      } catch (error) {
        errors.push(`remove ${cid}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    for (const message of errors) log(message)
    failed = failed || errors.length > 0
    let held = addedBytes
    for (const cid of have) if (!removed.includes(cid)) held += info.get(cid)?.size ?? 0
    const percent = Math.round((held * 100) / limitBytes)
    log(`${String(want.length)} key(s) point at ${String(new Set(want.map((w) => w.cid)).size)} version(s): ${String(plan.kept.length)} already held, ${String(plan.add.length)} ${dryRun ? 'to add' : `added ${String(added.length)}`}, ${String(plan.remove.length)} ${dryRun ? 'to remove' : `removed ${String(removed.length)}`}${freed > 0 ? ` (${mb(freed)} freed)` : ''}; Filebase holds about ${mb(held)} (${String(percent)}% of ${mb(limitBytes)})${failed ? ', with errors' : ''}`)
    if (percent >= 80) log(`warning: Filebase is at ${String(percent)}% of ${mb(limitBytes)}; uploads are refused when it is full`)

    if (!dryRun) {
      const newErrors = errors.filter((message) => state.reported[message] === undefined)
      if (added.length > 0 || removed.length > 0 || newErrors.length > 0) {
        summary(`Filebase sync: added ${String(added.length)}${added.length > 0 ? ` (${added.join('; ')})` : ''}, removed ${String(removed.length)} pin(s)${freed > 0 ? `, ${mb(freed)} freed` : ''}; holds about ${mb(held)}${newErrors.length > 0 ? `; not done: ${newErrors.join('; ')}` : ''}`)
      }
      if (stateFile !== undefined) {
        state.reported = Object.fromEntries(errors.map((message) => [message, new Date(now()).toISOString()]))
        state.failures = failures
        if (plan.blocked === null) state.keys = [...names]
        mkdirSync(dirname(stateFile), { recursive: true })
        writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2))
        renameSync(`${stateFile}.tmp`, stateFile)
      }
    }
    return failed ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[filebase-sync] ${message}`)
    return error instanceof UsageError ? 2 : 1
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = await run({ env: process.env, args: process.argv.slice(2) })
}
