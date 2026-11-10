import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs the parts of scripts/ipfs-status.sh that read a .eth name through the Universal Resolver and tell a name pointing
// at a site's Swarm feed from one pointing elsewhere: the functions are cut out of the script and run in bash with the
// Ethereum lookups (or curl) replaced, and `render` runs on a made-up status.json, so nothing asks a node or the network.
const SCRIPT = join(process.cwd(), 'scripts', 'ipfs-status.sh')
const available = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0
const REF = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

/** What `contenthash()` returns for these bytes: an offset word, a length word, the bytes padded to whole words. */
const abi = (data: string): string => `0x${(32).toString(16).padStart(64, '0')}${(data.length / 2).toString(16).padStart(64, '0')}${data.padEnd(Math.ceil(data.length / 64) * 64, '0')}`
const swarm = (reference: string): string => abi(`e40101fa011b20${reference}`)
const UR = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee'
/** The Universal Resolver's answer, `(bytes result, address resolver)`, around what the resolver's contenthash() returned. */
const resolved = (returned: string): string => `0x${(64).toString(16).padStart(64, '0')}${'00'.repeat(12)}${'11'.repeat(20)}${abi(returned.slice(2)).slice(2 + 64)}`
// resolve(foo.eth, contenthash(namehash(foo.eth))) as viem encodes it, and mainnet's revert for a name nobody registered.
const FOO_NODE = 'de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f'
const SUPERPRODUCTIVITY_NODE = '88ac5461bc04b230f29b70dbee792b401b32427f3aa9b924d3f5dd965fd61997'
const SUPERPRODUCTIVITY_LOOKUP = '0x9061b923000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000002311737570657270726f6475637469766974790b6f7269766f6e737461636b036574680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024bc1c58d188ac5461bc04b230f29b70dbee792b401b32427f3aa9b924d3f5dd965fd6199700000000000000000000000000000000000000000000000000000000'
const FOO_LOOKUP = '0x9061b92300000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000903666f6f036574680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000024bc1c58d1de9b09fd7c5f901e23a3f19fecc54828e9c848539801e86591bd9801b019f84f00000000000000000000000000000000000000000000000000000000'
const NOT_FOUND = '0x77209fe800000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000017116f7269766f6e2d6e6f70652d7a7a3931780365746800000000000000000000'
/** ResolverError(bytes) around a resolver's own revert. */
const resolverError = (inner: string): string => `0x95c0c752${abi(inner).slice(2)}`

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'ipfs-status-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function bash (body: string, env: Record<string, string> = {}): string {
  const cut = [
    ...['feed_for', 'decode_contenthash', 'eth_call', 'dns_encode', 'contenthash_lookup', 'ens_check'].map((name) => `/^${name} ()/,/^}/p`),
    '/^pad_words ()/p', '/^ENS_UNIVERSAL_RESOLVER=/p'
  ].join(';')
  const result = spawnSync('bash', ['-c', `eval "$(sed -n '${cut}' "$SCRIPT")"\nKECCAK=1\nnamehash () { echo node; }\n${body}`], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', SCRIPT, ...env } })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(!available)('ipfs-status.sh and the Universal Resolver', () => {
  it('asks resolve(bytes,bytes) for contenthash(bytes32), byte for byte as viem does', () => {
    expect(bash(`contenthash_lookup foo.eth ${FOO_NODE}`)).toBe(FOO_LOOKUP)
    // A name of 35 DNS bytes, which takes two padded words.
    expect(bash(`contenthash_lookup superproductivity.orivonstack.eth ${SUPERPRODUCTIVITY_NODE}`)).toBe(SUPERPRODUCTIVITY_LOOKUP)
    expect(bash('echo "$ENS_UNIVERSAL_RESOLVER"')).toBe(`${UR}\n`)
  })

  const lookup = (answer: string): string => bash(
    `eth_call () { echo '${answer}'; }\nens_check x.eth ipns://k51key ''; echo "$ENS_STATE\${ENS_DETAIL:+ ($ENS_DETAIL)}"`
  ).trim()

  it('tells the reverts apart: no resolver, no contenthash, answered offchain, anything else', () => {
    expect(lookup(`revert:${NOT_FOUND}`)).toBe('no-resolver')
    expect(lookup(`revert:0x1e9535f2${'00'.repeat(64)}`)).toBe('no-resolver')
    expect(lookup(`revert:${resolverError(`5fe9a5df${'00'.repeat(64)}`)}`)).toBe('no-resolver')
    expect(lookup(`revert:${resolverError(`08c379a0${'00'.repeat(64)}`)}`)).toBe('unknown (its resolver reverted)')
    expect(lookup(`revert:0x7b1c461b${'bc1c58d1'.padEnd(64, '0')}`)).toBe('none')
    expect(lookup(`revert:0x556f1830${'00'.repeat(32)}`)).toBe('unknown (it is answered offchain (CCIP-Read), which this script does not follow)')
    expect(lookup('revert:')).toBe('unknown (the Universal Resolver reverted with no reason)')
    expect(lookup('0x1234')).toBe('unknown (the Universal Resolver sent a malformed answer)')
    // An offset past the end, or a character that is not hex, is malformed too, and ends nothing but this check.
    expect(lookup(`0x${(4096).toString(16).padStart(64, '0')}${'00'.repeat(64)}`)).toBe('unknown (the Universal Resolver sent a malformed answer)')
    expect(lookup(`0x${'zz'.repeat(96)}`)).toBe('unknown (the Universal Resolver sent a malformed answer)')
    expect(lookup(resolved(`0x${(4096).toString(16).padStart(64, '0')}${'00'.repeat(32)}`))).toBe('none')
    expect(bash('eth_call () { return 1; }\nens_check x.eth ipns://k51key; echo "$ENS_STATE ($ENS_DETAIL)"')).toBe('unknown (no Ethereum RPC answered)\n')
  })

  it('takes a revert as an answer, and moves past an RPC that refuses or is down', () => {
    const rpcs = (replies: string): string => bash(
      `curl () { case "$*" in ${replies} esac; }\neth_call ${UR} 0x9061b923 || echo 'no answer'`, { ETH_RPCS: 'https://a https://b', TIMEOUT: '1' }
    ).trim()
    expect(rpcs(`*//a*) echo '{"error":{"code":-32005,"message":"limit"}}' ;; *//b*) echo '{"error":{"code":3,"message":"execution reverted","data":"0x77209FE8"}}' ;;`)).toBe('revert:0x77209fe8')
    expect(rpcs(`*//a*) return 7 ;; *//b*) echo '{"result":"0xabcd"}' ;;`)).toBe('0xabcd')
    expect(rpcs(`*//a*) echo '{"error":{"code":-32000,"message":"execution reverted","data":"0x7b1c461b"}}' ;;`)).toBe('revert:0x7b1c461b')
    expect(rpcs(`*) echo '{"error":{"code":-32000,"message":"down"}}' ;;`)).toBe('no answer')
  })
})

describe.skipIf(!available)('ipfs-status.sh and a site on Swarm', () => {
  it('reads a Swarm contenthash as bzz://<64 hex>, and any other length as an unknown one', () => {
    expect(bash(`decode_contenthash '${swarm(REF)}'`)).toBe(`bzz://${REF}\n`)
    expect(bash(`decode_contenthash '${abi(`e40101fa011b20${REF}00`)}'`)).toBe(`other:0xe40101fa011b20${REF}00\n`)
    expect(bash(`decode_contenthash '${abi('e40101fa011b20abcd')}'`)).toBe('other:0xe40101fa011b20abcd\n')
  })

  const ens = (contenthash: string, feed: string): string => bash(
    `eth_call () { [ "$1" = "${UR}" ] || exit 9; echo '${resolved(contenthash)}'; }\nens_check x.eth ipns://k51key '${feed}'; echo "$ENS_STATE $ENS_VIA"`
  ).trim()

  it('calls a name right at its key or at its key feed, and says which', () => {
    expect(ens(swarm(REF), `bzz://${REF}`)).toBe('ok feed')
    expect(ens(swarm(OTHER), `bzz://${REF}`)).toBe('wrong')
    expect(ens(swarm(REF), '')).toBe('wrong')
    expect(ens('0x', `bzz://${REF}`)).toBe('none')
  })

  it('reads the feed of a key from the feeds file, and nothing for a key it does not list, a malformed line or no file', () => {
    const file = join(scratch(), 'feeds.txt')
    writeFileSync(file, `# <ipns-key> bzz://<feed manifest>\nexplore bzz://${REF}\nshort bzz://abcd\nweb3 bzz://${OTHER} # trailing\n`)
    const feeds = (key: string, path: string): string => bash(`feed_for ${key}`, { FEEDS_FILE: path })
    expect(feeds('explore', file)).toBe(`bzz://${REF}\n`)
    expect(feeds('web3', file)).toBe(`bzz://${OTHER}\n`)
    expect(feeds('short', file)).toBe('')
    expect(feeds('missing', file)).toBe('')
    expect(feeds('explore', join(scratch(), 'none.txt'))).toBe('')
    expect(feeds('explore', '')).toBe('')
  })

  const status = (names: object[], extra: object = {}): object => ({
    generated_at: '2026-10-27T12:00:00Z', interval_minutes: 15, node: { inbound: {}, pinner: {}, watchdog: null }, releases: [], latest: null, problems: [],
    sites: [{ key: 'explore', id: 'k51key', ipns: 'ipns://k51key', target: 'bafy', record: { found: true }, pinned: true, provided: true, gateways: [], names, state: 'ok', ...extra }]
  })
  const render = (data: object): { html: string, md: string } => {
    const dir = scratch()
    writeFileSync(join(dir, 'status.json'), JSON.stringify(data))
    const result = spawnSync('bash', [SCRIPT, 'render'], { encoding: 'utf8', env: { ...process.env, OUT_DIR: dir } })
    expect(result.status).toBe(0)
    return { html: readFileSync(join(dir, 'index.html'), 'utf8'), md: readFileSync(join(dir, 'STATUS.md'), 'utf8') }
  }

  it('shows the feed beside the key, and a name that points at it as pointing at its Swarm feed', () => {
    const names = [{ name: 'a.eth', actual: `bzz://${REF}`, state: 'ok', via: 'feed', limo: null }, { name: 'b.eth', actual: 'ipns://k51key', state: 'ok', via: 'ipns', limo: null }]
    const { html, md } = render(status(names, { feed: `bzz://${REF}` }))
    expect(html).toContain('<th>ipns:// and bzz://</th>')
    expect(html).toContain(`<code>bzz://${REF}</code>`)
    expect(html.match(/points at its Swarm feed/g)).toHaveLength(1)
    expect(md).toContain('a.eth ok (points at its Swarm feed)<br>b.eth ok |')
    expect(md).toContain(`\`ipns://k51key\`<br>\`bzz://${REF}\``)
  })

  it('renders a status.json with no feed or via fields', () => {
    const { html, md } = render(status([{ name: 'b.eth', actual: 'ipns://k51key', state: 'ok', limo: null }]))
    expect(html).not.toContain('Swarm feed')
    expect(md).toContain('b.eth ok |')
  })
})
