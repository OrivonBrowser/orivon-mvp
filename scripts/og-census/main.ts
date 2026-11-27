import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { readCensus } from '../../src/protocols/og/census.js'
import { agreeingChain } from './agree.js'
import { censusText, cutCensus, sharedFinalized } from './cut.js'
import { chunkedChain } from './logs.js'
import { nodeChain } from './rpc.js'
import type { CutChain } from './rpc.js'
import { validateShared } from './validate.js'

// The census tool: cuts `src/protocols/og/census.json` from two public nodes that must agree on every read, so anybody can run it again
// and get the same file. README.md says how and why.
//
//   run.mjs                  cut at the newest block both nodes call finalized, and write the file
//   run.mjs --block N        cut at block N (the nodes need its state: an archive node, or a recent block)
//   run.mjs --check          cut again at the file's own block and say whether it is the same file
//   run.mjs --out PATH       write somewhere else
//   run.mjs --validate       after the cut, read a sample of the shared log read name by name and compare

export const DEFAULT_NODES: readonly [string, string] = ['https://rpc.mevblocker.io', 'https://gateway.tenderly.co/public/mainnet']
export const CENSUS_FILE = fileURLToPath(new URL('../../src/protocols/og/census.json', import.meta.url))

const flagValue = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at < 0 ? undefined : argv[at + 1]
}

/** @returns the process's exit code */
export async function main (argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const started = Date.now()
  const say = (line: string): void => { console.error(`[${String(Math.round((Date.now() - started) / 1000))}s] ${line}`) }
  const urls: [string, string] = [env['OG_RPC_A'] ?? DEFAULT_NODES[0], env['OG_RPC_B'] ?? DEFAULT_NODES[1]]
  const counters = { sent: 0, busy: 0 }
  const nodes: [CutChain, CutChain] = [nodeChain(urls[0], { counters }), nodeChain(urls[1], { counters })]
  let chunks = 0
  const chain = chunkedChain(agreeingChain(nodes[0], nodes[1], urls), { onChunk: () => { if (++chunks % 500 === 0) say(`${String(chunks)} log ranges read, ${String(counters.sent)} requests, ${String(counters.busy)} busy answers`) } })
  const out = flagValue(argv, '--out') ?? CENSUS_FILE

  if (argv.includes('--check')) {
    const current = await readFile(out, 'utf8')
    const { census } = await cutCensus(chain, { block: readCensus(JSON.parse(current)).block }, say)
    const same = censusText(census) === current
    say(same ? 'the census is what the chain gives' : 'the census differs from what the chain gives')
    return same ? 0 : 1
  }

  const asked = flagValue(argv, '--block')
  const block = asked === undefined ? await sharedFinalized(nodes) : Number(asked)
  if (!Number.isSafeInteger(block) || block <= 0) throw new Error(`${String(asked)} is not a block number`)
  const { census, shared } = await cutCensus(chain, { block }, say)
  await writeFile(out, censusText(census))
  say(`wrote ${out} at block ${String(census.block)}, hash ${census.blockHash}`)
  const different = argv.includes('--validate') ? await validateShared(chain, shared, block, say) : 0
  say(`done: ${String(counters.sent)} requests, ${String(counters.busy)} busy answers`)
  return different === 0 ? 0 : 1
}
