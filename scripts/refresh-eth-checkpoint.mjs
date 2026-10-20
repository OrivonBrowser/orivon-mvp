/**
 * Reads the current finalized beacon checkpoint from at least two independent
 * beacon APIs, refuses unless they agree, and prints it as the checkpoint a
 * release ships (src/main/verifier/mainnet-checkpoint.json). With --write it
 * also writes that file, for the owner to review and commit. The release
 * checklist runs it before tagging.
 *
 * Usage: node scripts/refresh-eth-checkpoint.mjs [--write] [beacon-api-url ...]
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isInvokedDirectly } from './cli.mjs'

export const DEFAULT_BEACON_APIS = [
  'https://ethereum-beacon-api.publicnode.com',
  'https://lodestar-mainnet.chainsafe.io'
]

const MAINNET_GENESIS_SECONDS = 1_606_824_023
const SECONDS_PER_SLOT = 12
const BLOCK_ROOT = /^0x[0-9a-f]{64}$/
const OUTPUT = fileURLToPath(new URL('../src/main/verifier/mainnet-checkpoint.json', import.meta.url))

/**
 * The twin of `fetchAgreedCheckpoint` in src/main/verifier/checkpoint-fetch.ts, which the browser runs when a
 * checkpoint has aged out: a script cannot import that TypeScript, so the rule is written twice and
 * scripts/tests/refresh-eth-checkpoint.test.ts runs the same answers through both. Every API must answer with a
 * finalized header and all must name the same root and slot.
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @param {string[]} apis
 * @returns {Promise<{ root: string, slot: number, timestamp: number, agreedBy: string[] }>}
 */
export async function agreedCheckpoint (fetchJson, apis) {
  const distinct = [...new Set(apis)]
  if (distinct.length < 2) throw new Error('need at least two independent beacon APIs')
  const answers = await Promise.all(distinct.map(async (api) => {
    const body = /** @type {any} */ (await fetchJson(`${api}/eth/v1/beacon/headers/finalized`))
    const root = body?.data?.root
    const rawSlot = body?.data?.header?.message?.slot
    const slot = typeof rawSlot === 'string' && /^\d{1,12}$/.test(rawSlot) ? Number(rawSlot) : NaN
    if (typeof root !== 'string' || !BLOCK_ROOT.test(root) || !Number.isSafeInteger(slot) || slot <= 0) throw new Error(`${api} returned no finalized checkpoint`)
    if (body.finalized === false || body.execution_optimistic === true || body.data.canonical === false) throw new Error(`${api} returned a header that is not finalized`)
    return { api, root, slot }
  }))
  const [first] = answers
  // Finality moves every few minutes, so two honest APIs can briefly differ. Never pick one.
  if (answers.some((a) => a.root !== first.root || a.slot !== first.slot)) {
    throw new Error(`beacon APIs disagree: ${answers.map((a) => `${a.api} slot ${a.slot} ${a.root}`).join('; ')}. Run again in a minute.`)
  }
  return { root: first.root, slot: first.slot, timestamp: MAINNET_GENESIS_SECONDS + first.slot * SECONDS_PER_SLOT, agreedBy: distinct }
}

/** @param {string} url */
async function fetchJson (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return await response.json()
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const apis = args.filter((a) => a !== '--write')
  try {
    const checkpoint = await agreedCheckpoint(fetchJson, apis.length > 0 ? apis : DEFAULT_BEACON_APIS)
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
