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
 * @param {(url: string) => Promise<unknown>} fetchJson
 * @param {string[]} apis
 * @returns {Promise<{ root: string, slot: number, timestamp: number, agreedBy: string[] }>}
 */
export async function agreedCheckpoint (fetchJson, apis) {
  if (apis.length < 2) throw new Error('need at least two independent beacon APIs')
  const answers = await Promise.all(apis.map(async (api) => {
    const body = /** @type {any} */ (await fetchJson(`${api}/eth/v1/beacon/states/head/finality_checkpoints`))
    const finalized = body?.data?.finalized
    if (typeof finalized?.root !== 'string' || !BLOCK_ROOT.test(finalized.root)) throw new Error(`${api} returned no finalized checkpoint`)
    return { api, epoch: String(finalized.epoch), root: finalized.root }
  }))
  const [first] = answers
  const disagreeing = answers.filter((a) => a.root !== first.root || a.epoch !== first.epoch)
  if (disagreeing.length > 0) {
    // Finality moves every few minutes, so two honest APIs can briefly differ. Never pick one.
    throw new Error(`beacon APIs disagree: ${answers.map((a) => `${a.api} epoch ${a.epoch} ${a.root}`).join('; ')}. Run again in a minute.`)
  }
  const headers = await Promise.all(apis.map(async (api) => {
    const body = /** @type {any} */ (await fetchJson(`${api}/eth/v1/beacon/headers/${first.root}`))
    const slot = Number(body?.data?.header?.message?.slot)
    if (!Number.isSafeInteger(slot) || slot <= 0) throw new Error(`${api} returned no slot for ${first.root}`)
    return slot
  }))
  if (new Set(headers).size !== 1) throw new Error(`beacon APIs disagree on the slot of ${first.root}: ${headers.join(', ')}`)
  const slot = headers[0]
  return { root: first.root, slot, timestamp: MAINNET_GENESIS_SECONDS + slot * SECONDS_PER_SLOT, agreedBy: apis }
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
