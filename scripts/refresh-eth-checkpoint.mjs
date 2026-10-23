/**
 * Reads the current finalized beacon checkpoint from at least two independent
 * beacon APIs, refuses unless they agree, and prints it as the checkpoint a
 * release ships (src/main/verifier/mainnet-checkpoint.json). The checkpoint is
 * the block at the first slot of the newest finalized epoch that the light
 * client's consensus server (publicnode, or the one --consensus names) will
 * bootstrap from. With --write it also writes that file, for the owner to
 * review and commit. The release checklist runs it before tagging.
 *
 * Usage: node scripts/refresh-eth-checkpoint.mjs [--write] [--consensus <url>] [beacon-api-url ...]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

/** The server the light client bootstraps from (`DEFAULT_ENDPOINTS.consensusRpc`). */
export const DEFAULT_CONSENSUS_RPC = 'https://ethereum-beacon-api.publicnode.com'
export const DEFAULT_BEACON_APIS = [
  DEFAULT_CONSENSUS_RPC,
  'https://lodestar-mainnet.chainsafe.io'
]

const SLOTS_PER_EPOCH = 32
const MAX_EPOCHS_BACK = 8
const MAINNET_GENESIS_SECONDS = 1_606_824_023
const SECONDS_PER_SLOT = 12
const BLOCK_ROOT = /^0x[0-9a-f]{64}$/
const OUTPUT = fileURLToPath(new URL('../src/main/verifier/mainnet-checkpoint.json', import.meta.url))

/** A server answered 404: it has nothing at that path. */
export class NotFoundAnswer extends Error {}

/**
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @param {string} api
 * @param {number} slot
 * @returns {Promise<string | undefined>} the block root at the slot, undefined when the API has no block there
 */
async function rootAt (fetchJson, api, slot) {
  try {
    const body = /** @type {any} */ (await fetchJson(`${api}/eth/v1/beacon/blocks/${String(slot)}/root`))
    const root = body?.data?.root
    if (typeof root !== 'string' || !BLOCK_ROOT.test(root) || body.execution_optimistic === true) throw new Error(`${api} returned no block root for slot ${String(slot)}`)
    return root
  } catch (error) {
    if (error instanceof NotFoundAnswer) return undefined
    throw error
  }
}

/**
 * The twin of `fetchAgreedCheckpoint` in src/main/verifier/checkpoint-fetch.ts, which the browser runs when a
 * checkpoint has aged out or cannot be bootstrapped from: a script cannot import that TypeScript, so the rule is written
 * twice and scripts/tests/refresh-eth-checkpoint.test.ts runs the same answers through both. Every API must answer with a
 * finalized header and all must name the same root and slot. The checkpoint is then the block at the first slot of the
 * newest finalized epoch (looking back at most eight epochs) for which the consensus API answers a bootstrap whose header
 * is at that slot; every other API must name the same root at that slot. Only the consensus API is asked for the bootstrap:
 * it is the one the light client bootstraps from, and the others vouch for the root.
 * @param {(url: string) => Promise<unknown>} fetchJson throws NotFoundAnswer on a 404
 * @param {string[]} apis
 * @param {string} [consensusRpc] the server whose bootstrap is required; named, never taken from the list's order
 * @returns {Promise<{ root: string, slot: number, timestamp: number, agreedBy: string[] }>}
 */
export async function agreedCheckpoint (fetchJson, apis, consensusRpc = DEFAULT_CONSENSUS_RPC) {
  const distinct = [...new Set(apis)]
  if (distinct.length < 2) throw new Error('need at least two independent beacon APIs')
  const answers = await Promise.all(distinct.map(async (api) => {
    const body = /** @type {any} */ (await fetchJson(`${api}/eth/v1/beacon/headers/finalized`))
    const root = body?.data?.root
    const rawSlot = body?.data?.header?.message?.slot
    const slot = typeof rawSlot === 'string' && /^\d{1,12}$/.test(rawSlot) ? Number(rawSlot) : NaN
    if (typeof root !== 'string' || !BLOCK_ROOT.test(root) || !Number.isSafeInteger(slot) || slot <= 0) throw new Error(`${api} returned no finalized checkpoint`)
    if (body.execution_optimistic === true || body.data.canonical === false) throw new Error(`${api} returned a header that is not finalized`)
    return { api, root, slot, finalized: typeof body.finalized === 'boolean' ? body.finalized : undefined }
  }))
  const [first] = answers
  // Finality moves every few minutes, so two honest APIs can briefly differ. Never pick one.
  if (answers.some((a) => a.root !== first.root || a.slot !== first.slot)) {
    throw new Error(`beacon APIs disagree: ${answers.map((a) => `${a.api} slot ${a.slot} ${a.root}`).join('; ')}. Run again in a minute.`)
  }
  // Lodestar sets `finalized` false on the block it names as finalized: that flag counts against an answer only when no other API sets it true.
  const flags = answers.map((a) => a.finalized)
  if (flags.includes(false) && !flags.includes(true)) throw new Error(`${distinct.join(' and ')} returned a header that is not finalized`)
  const ordered = [consensusRpc, ...distinct.filter((api) => api !== consensusRpc)]
  const newestEpochStart = first.slot - first.slot % SLOTS_PER_EPOCH
  for (let back = 0; back < MAX_EPOCHS_BACK; back++) {
    const slot = newestEpochStart - back * SLOTS_PER_EPOCH
    if (slot <= 0) break
    const root = await rootAt(fetchJson, consensusRpc, slot)
    if (root === undefined) continue
    let served
    try {
      const bootstrap = /** @type {any} */ (await fetchJson(`${consensusRpc}/eth/v1/beacon/light_client/bootstrap/${root}`))
      const rawSlot = bootstrap?.data?.header?.beacon?.slot
      if (typeof rawSlot !== 'string' || !/^\d{1,12}$/.test(rawSlot)) throw new Error(`${consensusRpc} returned a bootstrap with no slot`)
      served = Number(rawSlot)
    } catch (error) {
      if (error instanceof NotFoundAnswer) continue
      throw error
    }
    if (served !== slot) continue
    const others = await Promise.all(ordered.slice(1).map(async (api) => ({ api, root: await rootAt(fetchJson, api, slot) })))
    if (others.some((o) => o.root !== root)) {
      throw new Error(`beacon APIs disagree on the block at slot ${String(slot)}: ${[`${consensusRpc} ${root}`, ...others.map((o) => `${o.api} ${o.root ?? 'no block'}`)].join('; ')}. Run again in a minute.`)
    }
    return { root, slot, timestamp: MAINNET_GENESIS_SECONDS + slot * SECONDS_PER_SLOT, agreedBy: ordered }
  }
  throw new Error(`${consensusRpc} serves a bootstrap for none of the ${String(MAX_EPOCHS_BACK)} newest finalized epochs' first blocks`)
}

/** @param {string} url */
async function fetchJson (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } })
  if (response.status === 404) throw new NotFoundAnswer(`${url} answered 404`)
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return await response.json()
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const flagAt = args.indexOf('--consensus')
  const consensus = flagAt >= 0 ? args[flagAt + 1] : undefined
  if (flagAt >= 0 && (consensus === undefined || consensus.startsWith('--'))) {
    console.error('--consensus needs the URL of the beacon API the light client bootstraps from')
    process.exit(1)
  }
  const flagged = flagAt >= 0 ? new Set([flagAt, flagAt + 1]) : new Set()
  const apis = args.filter((a, i) => a !== '--write' && !flagged.has(i))
  try {
    const checkpoint = await agreedCheckpoint(fetchJson, apis.length > 0 ? apis : DEFAULT_BEACON_APIS, consensus)
    const json = JSON.stringify({ root: checkpoint.root, slot: checkpoint.slot, timestamp: checkpoint.timestamp }, null, 2) + '\n'
    process.stdout.write(json)
    console.error(`Agreed by ${checkpoint.agreedBy.join(', ')}; slot time ${new Date(checkpoint.timestamp * 1000).toISOString()}.`)
    if (write) {
      writeFileSync(OUTPUT, json)
      console.error(`Wrote ${OUTPUT}. Review and commit it.`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
