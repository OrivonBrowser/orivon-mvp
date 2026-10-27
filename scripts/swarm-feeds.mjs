/**
 * Publishes each of Orivon's own sites to a Swarm sequence feed and keeps the feed current. A site is a folder pinned
 * in a pinning node's Kubo under an IPNS key; whenever a key moves to a new CID, that version is uploaded to a Bee node
 * and a feed update naming it is appended. ENS points at the feed's manifest, so a name never changes and IPNS stays the
 * trigger. Postage is two immutable batches: one for pointers (never replaced), one for site versions (replaced when
 * full, so old versions stop costing money). docs/development/packaging.md section Orivon's sites on Swarm has the why.
 *
 *   NAMES_FILE=<names.conf> node swarm-feeds.mjs [sync [--dry-run] | list | address]
 *
 * Runs from one file: `npx esbuild scripts/swarm-feeds.mjs --bundle --platform=node --format=esm --outfile=swarm-feeds.mjs`
 * (the bundle carries viem) and needs GNU `tar`. Run it where Bee runs; Kubo may be remote (IPFS_API, e.g. a tunnel).
 *
 * Settings come from the environment: NAMES_FILE (required: `<ipns-key> <ens names...>` per line; a path, or
 * ssh://user@host/absolute/path), SKIP_KEYS, SIGNER_KEY_FILE (the feed owner's private key, mode 600, never logged),
 * BEE_API, IPFS_API (http(s)://..., or ssh://user@host[:port] to run each RPC call as curl over ssh against
 * IPFS_SSH_RPC there), STATE_DIR (state.json, socs.jsonl, status.json), WORK_DIR, SUMMARY_LOG, and the batch policy:
 * POINTER_DEPTH, POINTER_TTL_MIN_DAYS,
 * POINTER_TTL_TARGET_DAYS, POINTER_DILUTE_AT, CONTENT_DEPTH, CONTENT_TTL_MIN_DAYS, CONTENT_TTL_TARGET_DAYS, ROTATE_AT,
 * MAX_SPEND_BZZ (a limit per run), SYNC_TIMEOUT_MIN, BATCH_WAIT_MIN, MIN_XDAI.
 * Exit 0 when every site is current, 1 when something failed, a spend was refused or Bee is not ready (nothing is
 * spent then), 2 for a usage or configuration error. A run after days off finds the same state and carries on.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInvokedDirectly } from './cli.mjs'
import { beeClient, defaultSleep } from './swarm-feeds/bee.mjs'
import { checkAffordable, observe, planFor, restorePointer, runPlan, waitUsable } from './swarm-feeds/batches.mjs'
import { ownerOf } from './swarm-feeds/feed.mjs'
import { clearWork, kuboClient, packSite } from './swarm-feeds/kubo.mjs'
import { bzz, DAY, PLUR_PER_BZZ, SpendBudget, WEI_PER_XDAI, xdai } from './swarm-feeds/policy.mjs'
import { describeSites, syncSites } from './swarm-feeds/sites.mjs'
import { parseSshUrl, readRemoteFile } from './swarm-feeds/ssh.mjs'
import { loadState, parseList, parseNames, readJournal, readSignerKeyFile, UsageError, writeStatus } from './swarm-feeds/store.mjs'

export { UsageError }

const USAGE = 'usage: swarm-feeds.mjs [sync [--dry-run] | list | address]'

/**
 * @param {Record<string, string | undefined>} env
 * @returns {any} the settings, each checked
 */
export function readSettings (env) {
  /** @param {string} name @param {number} fallback @param {{ min?: number, max?: number, integer?: boolean }} [bounds] */
  const number = (name, fallback, { min = 0, max = Infinity, integer = false } = {}) => {
    const raw = env[name]
    const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new UsageError(`${name} must be ${integer ? 'a whole ' : 'a '}number from ${String(min)}${max === Infinity ? ' up' : ` to ${String(max)}`}`)
    return value
  }
  const home = env.HOME ?? homedir()
  const xdg = (/** @type {string} */ name, /** @type {string} */ fallback) => (env[name] !== undefined && env[name] !== '' ? String(env[name]) : join(home, fallback))
  const stateDir = env.STATE_DIR ?? env.STATE_DIRECTORY ?? join(xdg('XDG_STATE_HOME', '.local/state'), 'orivon-swarm-feeds')
  const days = (/** @type {string} */ min, /** @type {number} */ minFallback, /** @type {string} */ target, /** @type {number} */ targetFallback) => {
    const limits = { minDays: number(min, minFallback, { min: 1 }), targetDays: number(target, targetFallback, { min: 1 }) }
    if (limits.minDays > limits.targetDays) throw new UsageError(`${min} must not be above ${target}`)
    return limits
  }
  const cap = number('MAX_SPEND_BZZ', 100)
  const ipfsApi = env.IPFS_API ?? 'http://127.0.0.1:5001'
  try {
    parseSshUrl(ipfsApi, { path: false })
    if (env.NAMES_FILE !== undefined) parseSshUrl(env.NAMES_FILE, { path: true })
  } catch (error) {
    throw new UsageError(`${error instanceof Error ? error.message : String(error)} (IPFS_API or NAMES_FILE)`)
  }
  return {
    beeApi: env.BEE_API ?? 'http://127.0.0.1:1633',
    ipfsApi,
    ipfsSshRpc: env.IPFS_SSH_RPC ?? 'http://127.0.0.1:5001',
    namesFile: env.NAMES_FILE,
    skip: parseList(env.SKIP_KEYS),
    signerKeyFile: env.SIGNER_KEY_FILE ?? join(xdg('XDG_CONFIG_HOME', '.config'), 'orivon-swarm-feeds', 'feed-signer.key'),
    stateDir,
    workDir: env.WORK_DIR ?? join(tmpdir(), 'orivon-swarm-feeds'),
    summaryLog: env.SUMMARY_LOG,
    pointer: { depth: number('POINTER_DEPTH', 18, { min: 17, max: 40, integer: true }), ...days('POINTER_TTL_MIN_DAYS', 120, 'POINTER_TTL_TARGET_DAYS', 240), diluteAt: number('POINTER_DILUTE_AT', 0.5, { min: 0.01, max: 1 }) },
    content: { depth: number('CONTENT_DEPTH', 22, { min: 17, max: 40, integer: true }), ...days('CONTENT_TTL_MIN_DAYS', 21, 'CONTENT_TTL_TARGET_DAYS', 35) },
    rotateAt: number('ROTATE_AT', 0.75, { min: 0.01, max: 1 }),
    maxSpend: BigInt(Math.round(cap * 1e4)) * (PLUR_PER_BZZ / 10_000n),
    syncTimeoutMs: number('SYNC_TIMEOUT_MIN', 45, { min: 1 }) * 60_000,
    waitMs: number('BATCH_WAIT_MIN', 20, { min: 1 }) * 60_000,
    settleMs: 30 * 60_000,
    minXdai: BigInt(Math.round(number('MIN_XDAI', 0.01) * 1e6)) * (WEI_PER_XDAI / 1_000_000n)
  }
}

/** @param {string} file @param {string} what @returns {string} */
function readInput (file, what) {
  try { return readFileSync(file, 'utf8') } catch (error) {
    throw new UsageError(`${what} ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {string} file a path or an ssh:// address @param {import('./swarm-feeds/ssh.mjs').SpawnFn | undefined} spawnFn @returns {Promise<string>} */
async function readNames (file, spawnFn) {
  return file.startsWith('ssh://') ? readRemoteFile(file, spawnFn) : readInput(file, 'the names file')
}

/** @param {string[]} args @returns {{ command: 'sync' | 'list' | 'address', dryRun: boolean }} */
function parseArgs (args) {
  const [first, ...rest] = args
  const command = first === undefined || first === '--dry-run' ? 'sync' : first
  const flags = first === '--dry-run' ? args : rest
  if (command !== 'sync' && command !== 'list' && command !== 'address') throw new UsageError(USAGE)
  if (flags.some((flag) => flag !== '--dry-run') || (flags.length > 0 && command !== 'sync')) throw new UsageError(USAGE)
  return { command, dryRun: flags.includes('--dry-run') }
}

/** @param {number} seconds @returns {number | null} */
const daysOf = (seconds) => (seconds === Infinity ? null : Math.round((seconds / DAY) * 10) / 10)

/** The `list` table: one row per site of the names file, from the state. @param {any} state @param {{ key: string, names: string[] }[]} sites @returns {string} */
function listTable (state, sites) {
  const rows = sites.map(({ key, names }) => {
    const rec = state.sites[key] ?? {}
    const cells = [key, names.join(', ') || '-', rec.manifest === undefined ? '-' : `bzz://${String(rec.manifest)}`, rec.index === undefined ? '-' : String(rec.index), rec.cid ?? '-', rec.reference ?? '-']
    return `| ${cells.join(' | ')} |`
  })
  return ['| Key | ENS names | Feed manifest | Newest index | IPFS CID | Swarm reference |', '|---|---|---|---|---|---|', ...rows].join('\n')
}

/**
 * What the run leaves in status.json: the wallet, each batch, each site. Reads what it can; a failure to read is recorded
 * in place and never stops the run from ending. With `live` false (Bee was not ready) it asks Bee nothing.
 * @param {any} ctx
 * @param {{ key: string, names: string[] }[]} sites
 * @param {string[]} errors
 * @param {boolean} live
 */
async function buildStatus (ctx, sites, errors, live) {
  const attempt = async (/** @type {() => Promise<any>} */ read) => {
    if (!live) return null
    try { return await read() } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  }
  const batch = async (/** @type {{ id: string, boughtAt?: string, retiredAt?: string, reason?: string }} */ held) => attempt(async () => {
    const stamp = await ctx.bee.stamp(held.id)
    return { id: held.id, found: stamp.found, usable: stamp.usable, depth: stamp.depth, ttlDays: daysOf(stamp.ttl), fill: Math.round(stamp.fill * 100) / 100, boughtAt: held.boughtAt, retiredAt: held.retiredAt, reason: held.reason }
  })
  return {
    time: new Date(ctx.now()).toISOString(),
    ok: errors.length === 0,
    owner: `0x${String(ctx.signer.owner)}`,
    wallet: await attempt(async () => { const wallet = await ctx.bee.wallet(); return { address: wallet.address, xbzz: bzz(wallet.bzz), xdai: xdai(wallet.xdai) } }),
    spentThisRun: bzz(ctx.spend.spent),
    pointerBatch: ctx.state.pointer === null ? null : await batch(ctx.state.pointer),
    contentBatch: ctx.state.content === null ? null : await batch(ctx.state.content),
    retiredBatches: await Promise.all(ctx.state.retired.map(batch)),
    sites: sites.map(({ key, names }) => {
      const rec = ctx.state.sites[key] ?? {}
      return { key, names, topic: rec.topic, manifest: rec.manifest === undefined ? null : `bzz://${String(rec.manifest)}`, index: rec.index ?? null, cid: rec.cid ?? null, reference: rec.reference ?? null, batch: rec.batch ?? null, published: rec.published ?? null, uploadPending: rec.pending != null }
    }),
    errors
  }
}

/**
 * @param {{ env: Record<string, string | undefined>, args: string[], fetchFn?: typeof fetch, spawnFn?: import('./swarm-feeds/ssh.mjs').SpawnFn, now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (line: string) => void, out?: (text: string) => void, pack?: (input: { cid: string, workDir: string }) => Promise<{ file: string, bytes: number, hasIndex: boolean, cleanup: () => void }> }} io
 * @returns {Promise<number>} the exit code
 */
export async function run ({ env, args, fetchFn = fetch, spawnFn, now = Date.now, sleep = defaultSleep, log = (line) => { console.log(`[swarm-feeds] ${line}`) }, out = (text) => { console.log(text) }, pack }) {
  try {
    const { command, dryRun } = parseArgs(args)
    const cfg = readSettings(env)
    const privateKey = readSignerKeyFile(cfg.signerKeyFile)
    const signer = { privateKey, owner: ownerOf(privateKey).owner }
    const bee = beeClient({ api: cfg.beeApi, fetchFn, sleep })
    if (command === 'address') {
      out(`feed owner: ${ownerOf(privateKey).address}`)
      out(`bee wallet: ${await bee.ethereumAddress()}`)
      return 0
    }
    if (cfg.namesFile === undefined) throw new UsageError('NAMES_FILE must be set: the file listing each IPNS key and its ENS names')
    const sites = parseNames(await readNames(cfg.namesFile, spawnFn), cfg.skip)
    const state = loadState(cfg.stateDir)
    if (command === 'list') {
      out(listTable(state, sites))
      return 0
    }

    const kubo = kuboClient({ api: cfg.ipfsApi, rpc: cfg.ipfsSshRpc, fetchFn, spawnFn })
    const summary = (/** @type {string} */ line) => {
      if (dryRun || cfg.summaryLog === undefined) return
      appendFileSync(cfg.summaryLog, `- ${new Date(now()).toISOString().slice(0, 10)}: Swarm feeds: ${line}\n`)
    }
    const ctx = { cfg, bee, state, spend: new SpendBudget(cfg.maxSpend), log, summary, now, sleep, journal: readJournal(cfg.stateDir), signer, rotated: false, pack: pack ?? ((/** @type {{ cid: string, workDir: string }} */ input) => packSite({ kubo, ...input })) }
    /** @type {string[]} */
    const errors = []
    let live = true
    try {
      // A node that is still starting, or has no peers, cannot hold what is uploaded to it: nothing is bought, sent or written.
      const notReady = await bee.notReady().catch((/** @type {unknown} */ error) => error instanceof Error ? error.message : String(error))
      if (notReady !== null) {
        live = false
        throw new Error(`${notReady}; nothing was done`)
      }
      if (!dryRun) clearWork(cfg.workDir)
      const keys = new Map((await kubo.keys()).map((k) => [k.name, k.id]))
      /** @type {import('./swarm-feeds/sites.mjs').Site[]} */
      const current = []
      for (const site of sites) {
        const id = keys.get(site.key)
        if (id === undefined) { errors.push(`${site.key}: Kubo has no IPNS key of that name`); continue }
        try { current.push({ ...site, id, cid: await kubo.resolve(id) }) } catch (error) { errors.push(`${site.key}: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const observed = await observe(ctx)
      const plan = planFor(ctx, observed)
      if (dryRun) {
        for (const step of plan) log(`would ${step.op} the ${step.role} batch (${bzz(step.cost)}): ${step.why}`)
        try { checkAffordable(ctx, plan, observed) } catch (error) { errors.push(error instanceof Error ? error.message : String(error)) }
        for (const line of describeSites(ctx, current)) log(`would sync ${line}`)
      } else {
        checkAffordable(ctx, plan, observed)
        await runPlan(ctx, plan)
        await waitUsable(ctx, 'pointer')
        await waitUsable(ctx, 'content')
        if (ctx.state.restorePending) await restorePointer(ctx)
        await syncSites(ctx, current, errors)
      }
    } catch (error) {
      if (error instanceof UsageError) throw error
      errors.push(error instanceof Error ? error.message : String(error))
    }
    for (const message of errors) log(`error: ${message}`)
    if (!dryRun) writeStatus(cfg.stateDir, await buildStatus(ctx, sites, errors, live))
    log(`${String(sites.length)} site(s)${dryRun ? ' (dry run: nothing spent, uploaded or written)' : ''}${errors.length > 0 ? `, ${String(errors.length)} error(s)` : ', all current'}; spent ${bzz(ctx.spend.spent)}`)
    return errors.length > 0 ? 1 : 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[swarm-feeds] ${message}`)
    return error instanceof UsageError ? 2 : 1
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.exitCode = await run({ env: process.env, args: process.argv.slice(2) })
}
