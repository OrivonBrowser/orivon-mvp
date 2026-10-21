/**
 * Pins Orivon's releases and a list of app and site CIDs on an additional pinning service: any
 * service that speaks the IPFS Pinning Service API (https://ipfs.github.io/pinning-services-api-spec/).
 *
 *   PINNING_ENDPOINT=<base url> PINNING_TOKEN=<bearer token> \
 *     node scripts/pin-extra.mjs [--extra <file>] [--prune] [--dry-run]
 *
 * The CIDs come from the `ipfs.json` of the newest KEEP releases (the selection `pin-releases.sh sync`
 * makes, pinned as orivon-release-<tag>) and from `name=cid` lines in the --extra file. A pin is added
 * when no pin with that name and CID exists; --prune removes pins under the name prefix that are no
 * longer listed. Exit 0 when the service holds every listed CID, 1 when a request failed or a
 * release could not be read, 2 for a usage or configuration error. The token is only ever sent as the
 * Authorization header.
 */
import { readFileSync } from 'node:fs'
import { isInvokedDirectly } from './cli.mjs'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/
const PAGE = 1000

/** A configuration or input error the caller fixes: exit code 2. */
export class UsageError extends Error {}

/**
 * @typedef {{ name: string, cid: string }} Wanted
 * @typedef {{ requestid: string, status: string, pin: { cid: string, name?: string }, created?: string }} Held
 * @typedef {{ add: Wanted[], remove: Held[], keep: Held[] }} Plan
 */

/**
 * The newest `keep` releases that carry an ipfs.json, newest first (the selection of pin-releases.sh).
 * @param {any[]} releases GitHub's releases list
 * @param {number} keep
 */
export function selectReleases (releases, keep) {
  return releases
    .filter((r) => r.draft !== true && Array.isArray(r.assets) && r.assets.some((a) => a.name === 'ipfs.json'))
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, keep)
}

/**
 * Parses the --extra file: one `name=cid` per line, blank lines and `#` comments ignored.
 * @param {string} text
 * @param {string} prefix every name must start with it, so --prune can never reach a pin that is not ours
 * @returns {Wanted[]}
 */
export function parseExtra (text, prefix) {
  /** @type {Wanted[]} */
  const wanted = []
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    const at = line.indexOf('=')
    const name = at < 0 ? '' : line.slice(0, at).trim()
    const cid = at < 0 ? '' : line.slice(at + 1).trim()
    if (!NAME.test(name) || !CID.test(cid)) throw new UsageError(`extra file line ${String(i + 1)}: expected name=cid`)
    if (!name.startsWith(prefix)) throw new UsageError(`extra file line ${String(i + 1)}: name '${name}' must start with '${prefix}'`)
    wanted.push({ name, cid })
  }
  return wanted
}

/**
 * What to add and what to remove so the service holds exactly `wanted` under `prefix`.
 * A pin that failed counts as missing and is removed; a pin of the same CID under another name is
 * not a match. Pins outside the prefix are never in the plan. With `prune` false nothing is removed
 * except failed pins that are being replaced.
 * @param {Wanted[]} wanted
 * @param {Held[]} held
 * @param {{ prefix: string, prune: boolean }} options
 * @returns {Plan}
 */
export function planPins (wanted, held, { prefix, prune }) {
  const ours = held.filter((h) => (h.pin.name ?? '').startsWith(prefix))
  const live = ours.filter((h) => h.status !== 'failed')
  const key = (/** @type {string} */ name, /** @type {string} */ cid) => `${name}\u0000${cid}`
  const have = new Set(live.map((h) => key(h.pin.name ?? '', h.pin.cid)))
  const want = new Set(wanted.map((w) => key(w.name, w.cid)))
  const add = wanted.filter((w, i) => !have.has(key(w.name, w.cid)) && wanted.findIndex((o) => o.name === w.name && o.cid === w.cid) === i)
  const failedReplaced = ours.filter((h) => h.status === 'failed' && want.has(key(h.pin.name ?? '', h.pin.cid)))
  const stale = prune ? ours.filter((h) => !want.has(key(h.pin.name ?? '', h.pin.cid))) : []
  const remove = [...new Set([...failedReplaced, ...stale])]
  return { add, remove, keep: live.filter((h) => want.has(key(h.pin.name ?? '', h.pin.cid))) }
}

/**
 * A client for the Pinning Service API. `request` is injectable for tests.
 * @param {{ endpoint: string, token: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void> }} config
 */
export function pinningClient ({ endpoint, token, fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const base = endpoint.replace(/\/+$/, '')
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function request (method, path, body) {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchFn(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      })
      if (response.status === 429 && attempt < 4) {
        const wait = Number(response.headers.get('retry-after'))
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 60) * 1000 : attempt * 2000)
        continue
      }
      if (!response.ok) throw Object.assign(new Error(`${method} ${path.split('?')[0]} answered ${String(response.status)}`), { status: response.status })
      return response.status === 202 || response.status === 200 ? await response.json().catch(() => ({})) : {}
    }
  }
  return {
    /**
     * Every pin whose name contains `prefix`, any status that is queued, pinning, pinned or failed.
     * @param {string} prefix
     * @returns {Promise<Held[]>}
     */
    async list (prefix) {
      /** @type {Held[]} */
      const all = []
      let before = ''
      for (;;) {
        const query = `name=${encodeURIComponent(prefix)}&match=partial&status=queued,pinning,pinned,failed&limit=${String(PAGE)}${before === '' ? '' : `&before=${encodeURIComponent(before)}`}`
        const page = await request('GET', `/pins?${query}`)
        const results = /** @type {Held[]} */ (page.results ?? [])
        all.push(...results)
        const oldest = results.map((r) => r.created).filter((c) => typeof c === 'string').sort()[0]
        if (results.length < PAGE || oldest === undefined) return all
        before = oldest
      }
    },
    /** @param {Wanted} pin */
    async add (pin) {
      // 409: the service already holds this request, which is what adding was for.
      try { await request('POST', '/pins', { cid: pin.cid, name: pin.name }) } catch (error) {
        if (/** @type {any} */ (error).status !== 409) throw error
      }
    },
    /** @param {string} requestid */
    async remove (requestid) { await request('DELETE', `/pins/${encodeURIComponent(requestid)}`) }
  }
}

/**
 * The release pins: one per kept release, from its ipfs.json.
 * @param {{ releasesUrl: string, keep: number, prefix: string, fetchFn?: typeof fetch, log: (line: string) => void }} config
 * @returns {Promise<{ wanted: Wanted[], complete: boolean }>}
 */
export async function releasePins ({ releasesUrl, keep, prefix, fetchFn = fetch, log }) {
  /** @type {Wanted[]} */
  const wanted = []
  const get = async (/** @type {string} */ url) => {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
    return await response.json()
  }
  const releases = selectReleases(/** @type {any[]} */ (await get(releasesUrl)), keep)
  if (releases.length === 0) { log('no release carries an ipfs.json yet'); return { wanted, complete: true } }
  let complete = true
  for (const release of releases) {
    const tag = String(release.tag_name)
    try {
      const asset = release.assets.find((/** @type {any} */ a) => a.name === 'ipfs.json')
      const manifest = /** @type {any} */ (await get(asset.browser_download_url))
      const name = `${prefix}release-${tag}`
      if (!NAME.test(name) || !CID.test(String(manifest.cid))) throw new Error('tag or cid refused')
      wanted.push({ name, cid: String(manifest.cid) })
    } catch (error) {
      complete = false
      log(`release ${tag}: not read (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return { wanted, complete }
}

/**
 * @param {{ env: Record<string, string | undefined>, args: string[], fetchFn?: typeof fetch, readFile?: (path: string) => string, log?: (line: string) => void }} io
 * @returns {Promise<number>} the exit code
 */
export async function run ({ env, args, fetchFn = fetch, readFile = (p) => readFileSync(p, 'utf8'), log = (line) => { console.log(`[pin-extra] ${line}`) } }) {
  try {
    const prune = args.includes('--prune')
    const dryRun = args.includes('--dry-run')
    const extraAt = args.indexOf('--extra')
    const extraFile = extraAt >= 0 ? args[extraAt + 1] : undefined
    const unknown = args.filter((a, i) => !['--prune', '--dry-run', '--extra'].includes(a) && (extraAt < 0 || i !== extraAt + 1))
    if (unknown.length > 0 || (extraAt >= 0 && (extraFile === undefined || extraFile.startsWith('--')))) {
      throw new UsageError('usage: pin-extra.mjs [--extra <file>] [--prune] [--dry-run]')
    }
    const endpoint = env.PINNING_ENDPOINT ?? ''
    const token = env.PINNING_TOKEN ?? ''
    if (endpoint === '' || token === '') throw new UsageError('PINNING_ENDPOINT and PINNING_TOKEN must be set in the environment')
    if (!/^https:\/\//.test(endpoint)) throw new UsageError('PINNING_ENDPOINT must be an https:// URL')
    const prefix = env.PIN_PREFIX ?? 'orivon-'
    const keep = Number(env.KEEP ?? 3)
    if (!NAME.test(prefix) || !Number.isInteger(keep) || keep < 1) throw new UsageError('PIN_PREFIX or KEEP is not valid')
    const repo = env.ORIVON_REPO ?? 'OrivonBrowser/orivon-mvp'
    const releasesUrl = env.RELEASES_URL ?? `https://api.github.com/repos/${repo}/releases?per_page=30`
    const extra = extraFile === undefined ? [] : parseExtra(readFile(extraFile), prefix)

    const releases = await releasePins({ releasesUrl, keep, prefix, fetchFn, log })
    const wanted = [...releases.wanted, ...extra]
    const client = pinningClient({ endpoint, token, fetchFn })
    const held = await client.list(prefix)
    // An unread release or an empty list is never a reason to remove a pin.
    const canPrune = prune && releases.complete && wanted.length > 0
    if (prune && !canPrune) log('not pruning: the list of CIDs is incomplete')
    const plan = planPins(wanted, held, { prefix, prune: canPrune })

    let failed = !releases.complete
    for (const pin of plan.add) {
      log(`${dryRun ? 'would add' : 'add'} ${pin.name} ${pin.cid}`)
      if (dryRun) continue
      try { await client.add(pin) } catch (error) { failed = true; log(`add ${pin.name} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const pin of plan.remove) {
      log(`${dryRun ? 'would remove' : 'remove'} ${pin.pin.name ?? ''} ${pin.pin.cid}`)
      if (dryRun) continue
      try { await client.remove(pin.requestid) } catch (error) { failed = true; log(`remove ${pin.pin.name ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    log(`${String(wanted.length)} listed, ${String(plan.keep.length)} already held, ${String(plan.add.length)} ${dryRun ? 'to add' : 'added'}, ${String(plan.remove.length)} ${dryRun ? 'to remove' : 'removed'}${failed ? ', with errors' : ''}`)
    return failed ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[pin-extra] ${message}`)
    return error instanceof UsageError ? 2 : 1
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = await run({ env: process.env, args: process.argv.slice(2) })
}
