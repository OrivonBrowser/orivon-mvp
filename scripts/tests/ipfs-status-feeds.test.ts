import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// Runs the parts of scripts/ipfs-status.sh that tell a name pointing at a site's Swarm feed from one pointing elsewhere:
// the functions are cut out of the script and run in bash with the Ethereum lookups replaced, and `render` runs on a
// made-up status.json, so nothing asks a node or the network.
const SCRIPT = join(process.cwd(), 'scripts', 'ipfs-status.sh')
const available = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0
const REF = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

/** What `contenthash()` returns for these bytes: an offset word, a length word, the bytes padded to whole words. */
const abi = (data: string): string => `0x${(32).toString(16).padStart(64, '0')}${(data.length / 2).toString(16).padStart(64, '0')}${data.padEnd(Math.ceil(data.length / 64) * 64, '0')}`
const swarm = (reference: string): string => abi(`e40101fa011b20${reference}`)

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'ipfs-status-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function bash (body: string, env: Record<string, string> = {}): string {
  const cut = ['feed_for', 'decode_contenthash', 'ens_check'].map((name) => `/^${name} ()/,/^}/p`).join(';')
  const result = spawnSync('bash', ['-c', `eval "$(sed -n '${cut}' "$SCRIPT")"\nKECCAK=1; ENS_REGISTRY=0x1\nnamehash () { echo node; }\n${body}`], { encoding: 'utf8', env: { ...process.env, SCRIPT, ...env } })
  expect(result.stderr).toBe('')
  return result.stdout
}

describe.skipIf(!available)('ipfs-status.sh and a site on Swarm', () => {
  it('reads a Swarm contenthash as bzz://<64 hex>, and any other length as an unknown one', () => {
    expect(bash(`decode_contenthash '${swarm(REF)}'`)).toBe(`bzz://${REF}\n`)
    expect(bash(`decode_contenthash '${abi(`e40101fa011b20${REF}00`)}'`)).toBe(`other:0xe40101fa011b20${REF}00\n`)
    expect(bash(`decode_contenthash '${abi('e40101fa011b20abcd')}'`)).toBe('other:0xe40101fa011b20abcd\n')
  })

  const ens = (contenthash: string, feed: string): string => bash(
    `eth_call () { case $1 in 0x1) echo 0x${'0'.repeat(24)}${'11'.repeat(20)} ;; *) echo '${contenthash}' ;; esac; }\nens_check x.eth ipns://k51key '${feed}'; echo "$ENS_STATE $ENS_VIA"`
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

  it('renders a status.json written before the feed fields existed', () => {
    const { html, md } = render(status([{ name: 'b.eth', actual: 'ipns://k51key', state: 'ok', limo: null }]))
    expect(html).not.toContain('Swarm feed')
    expect(md).toContain('b.eth ok |')
  })
})
