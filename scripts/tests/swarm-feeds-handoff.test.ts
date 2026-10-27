import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { referenceCid } from '../../src/protocols/swarm/reference.js'
import { readSettings, UsageError } from '../swarm-feeds.mjs'
import { feedsText, scoreId } from '../swarm-feeds/handoff.mjs'
import { cid, makeRun } from './swarm-feeds.test-helpers.js'
import type { Run } from './swarm-feeds.test-helpers.js'

const runs: Run[] = []
const fresh = (env: Record<string, string> = {}): Run => { const run = makeRun(env); runs.push(run); return run }
afterEach(() => { for (const run of runs.splice(0)) run.cleanup() })

const HEADER = '# <ipns-key> bzz://<feed manifest>, one line per site. Written by swarm-feeds.mjs: do not edit.'
const feedsIn = (t: Run, name = 'feeds.txt'): string => join(t.dir, name)
const read = (file: string): string => readFileSync(file, 'utf8')

describe('the Web3 Score id of a version in Swarm', () => {
  it('is cid: and the CIDv1 of swarm-manifest over keccak-256, always starting cid:bah5acgza', () => {
    expect(scoreId('11'.repeat(32))).toBe('cid:bah5acgzaceirceirceirceirceirceirceirceirceirceirceirceirceiq')
    expect(scoreId('ab'.repeat(32))).toBe('cid:bah5acgzavov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvov2xk5lvovq')
    expect(scoreId('64302465962d0f3b3cfb5562f321f3992591c700ed78b75c6fab585589cc650c')).toBe('cid:bah5acgzamqycizmwfuhtwph3kvrpgiptteszdrya5v4loxdpvnmflcommuga')
  })
  it('is the spelling the reader gives the same reference', () => {
    for (const reference of ['00'.repeat(32), 'ff'.repeat(32), '64302465962d0f3b3cfb5562f321f3992591c700ed78b75c6fab585589cc650c']) {
      expect(scoreId(reference)).toBe(`cid:${referenceCid(reference)}`)
      expect(scoreId(reference)).toMatch(/^cid:bah5acgza[a-z2-7]{52}$/)
    }
  })
  it('refuses what is not a reference', () => {
    for (const bad of ['', 'AB', '11'.repeat(31), '11'.repeat(33), 'AB'.repeat(32), 'zz'.repeat(32)]) expect(() => scoreId(bad)).toThrow(RangeError)
  })
  it('is a column of list, right after the Swarm reference, and a dash where there is no reference', async () => {
    const t = fresh()
    await t.go()
    const state = t.state()
    delete state.sites.latest.reference
    writeFileSync(join(t.dir, 'state', 'state.json'), JSON.stringify(state))
    expect((await t.go('list')).code).toBe(0)
    expect(t.outs[0]).toContain('| Swarm reference | Score id |\n|---|---|---|---|---|---|---|\n')
    expect(t.outs[0]).toContain(`| ${String(state.sites.explore.reference)} | ${scoreId(String(state.sites.explore.reference))} |`)
    expect(t.outs[0]).toContain('| explore | explore.orivon.eth, explore.eth |')
    expect(t.outs[0]).toMatch(/\| latest \| latest\.orivon\.eth \| bzz:\/\/[0-9a-f]{64} \| 0 \| bafybei\w+ \| - \| - \|$/)
    state.sites.latest.reference = 'AB'
    writeFileSync(join(t.dir, 'state', 'state.json'), JSON.stringify(state))
    expect((await t.go('list')).code).toBe(0)
    expect(t.outs[1]).toMatch(/\| latest \| .* \| AB \| - \|$/)
    expect(scoreId(String(state.sites.explore.reference))).toBe('cid:bah5acgzamqycizmwfuhtwph3kvrpgiptteszdrya5v4loxdpvnmflcommuga')
  })
})

describe('the feeds file text', () => {
  const state = { sites: { explore: { manifest: 'a'.repeat(64) }, latest: {}, web3score: { manifest: 'b'.repeat(64) } } }
  it('is a comment line and one line per site with a manifest, in names-file order', () => {
    const sites = [{ key: 'web3score' }, { key: 'latest' }, { key: 'explore' }, { key: 'unknown' }]
    expect(feedsText(sites, state)).toBe(`${HEADER}\nweb3score bzz://${'b'.repeat(64)}\nexplore bzz://${'a'.repeat(64)}\n`)
  })
  it('is the comment line alone while no site has a manifest', () => {
    expect(feedsText([{ key: 'latest' }, { key: 'unknown' }], state)).toBe(`${HEADER}\n`)
    expect(feedsText([], state)).toBe(`${HEADER}\n`)
  })
})

describe('FEEDS_FILE', () => {
  it('is optional, empty counts as unset, and takes a path or an ssh address like NAMES_FILE', () => {
    expect(readSettings({}).feedsFile).toBeUndefined()
    expect(readSettings({ FEEDS_FILE: '' }).feedsFile).toBeUndefined()
    expect(readSettings({ FEEDS_FILE: '/srv/feeds.txt' }).feedsFile).toBe('/srv/feeds.txt')
    expect(readSettings({ FEEDS_FILE: 'ssh://me@host:2200/srv/feeds.txt' }).feedsFile).toBe('ssh://me@host:2200/srv/feeds.txt')
  })
  it('refuses a malformed ssh address, one without a path, and the names file itself', () => {
    expect(() => readSettings({ FEEDS_FILE: 'ssh://-oProxyCommand=x@host/srv/feeds.txt' })).toThrow(UsageError)
    expect(() => readSettings({ FEEDS_FILE: 'ssh://me@host' })).toThrow(/absolute path.*FEEDS_FILE/)
    expect(() => readSettings({ FEEDS_FILE: '/srv/names.conf', NAMES_FILE: '/srv/names.conf' })).toThrow(/must not be NAMES_FILE/)
  })
  it('refuses the names file under any spelling of its place', () => {
    const same = (names: string, feeds: string): void => { expect(() => readSettings({ NAMES_FILE: names, FEEDS_FILE: feeds })).toThrow(/must not be NAMES_FILE/) }
    same('ssh://u@h/srv/names.conf', 'ssh://u@h:22/srv/names.conf')
    same('ssh://u@h/srv/names.conf', 'ssh://u@h/srv/x/../names.conf')
    same('names.conf', './names.conf')
    same('/srv/names.conf', '/srv/x/../names.conf')
    expect(readSettings({ NAMES_FILE: 'ssh://u@h/srv/names.conf', FEEDS_FILE: 'ssh://u@h:2200/srv/names.conf' }).feedsFile).toBeDefined()
    expect(readSettings({ NAMES_FILE: 'ssh://u@h/srv/names.conf', FEEDS_FILE: 'ssh://u@h2/srv/names.conf' }).feedsFile).toBeDefined()
    expect(readSettings({ NAMES_FILE: 'ssh://u@h/srv/names.conf', FEEDS_FILE: '/srv/names.conf' }).feedsFile).toBeDefined()
  })
})

describe('sync: the feeds file', () => {
  it('writes it once after a sync: a comment, then each site with its feed manifest, in names-file order, and no temp file', async () => {
    const t = fresh()
    const file = feedsIn(t)
    Object.assign(t.env, { FEEDS_FILE: file })
    expect((await t.go()).code).toBe(0)
    const { sites } = t.state()
    expect(read(file)).toBe(`${HEADER}\nexplore bzz://${String(sites.explore.manifest)}\nlatest bzz://${String(sites.latest.manifest)}\n`)
    expect(existsSync(`${file}.tmp`)).toBe(false)
    expect(t.state().feedsFile).toMatchObject({ target: file })
    expect(t.summary()).toMatch(/feeds file written: 2 site\(s\)/)
  })

  it('does not write it again while the text is the same, however many runs the timer makes', async () => {
    const t = fresh()
    const file = feedsIn(t)
    Object.assign(t.env, { FEEDS_FILE: file })
    await t.go()
    const written = read(file)
    writeFileSync(file, 'changed behind the job\n')
    t.world.cids.set('k51explore', cid('c'))
    expect((await t.go()).code).toBe(0)
    expect((await t.go()).code).toBe(0)
    expect(read(file)).toBe('changed behind the job\n')
    expect(written).toContain('explore bzz://')
  })

  it('writes it again when a site is added, and when it is to be written somewhere else', async () => {
    const t = fresh()
    const file = feedsIn(t)
    Object.assign(t.env, { FEEDS_FILE: file })
    await t.go()
    t.world.keys.push({ name: 'web3score', id: 'k51web3score' })
    t.world.cids.set('k51web3score', cid('d'))
    writeFileSync(t.env.NAMES_FILE, `${read(t.env.NAMES_FILE)}web3score web3score.orivon.eth\n`)
    expect((await t.go()).code).toBe(0)
    const { sites } = t.state()
    expect(read(file).split('\n').slice(1)).toEqual([`explore bzz://${String(sites.explore.manifest)}`, `latest bzz://${String(sites.latest.manifest)}`, `web3score bzz://${String(sites.web3score.manifest)}`, ''])
    const other = feedsIn(t, 'elsewhere.txt')
    Object.assign(t.env, { FEEDS_FILE: other })
    await t.go()
    expect(read(other)).toBe(read(file))
  })

  it('writes it when a manifest in the state changes', async () => {
    const t = fresh({ SKIP_KEYS: 'latest' })
    const file = feedsIn(t)
    Object.assign(t.env, { FEEDS_FILE: file })
    await t.go()
    const state = t.state()
    state.sites.explore.manifest = 'c'.repeat(64)
    writeFileSync(join(t.dir, 'state', 'state.json'), JSON.stringify(state))
    await t.go()
    expect(read(file)).toBe(`${HEADER}\nexplore bzz://${'c'.repeat(64)}\n`)
  })

  it('writes nothing on a dry run or while Bee is not ready, and only the comment line while no site has a manifest', async () => {
    const t = fresh()
    const file = feedsIn(t)
    Object.assign(t.env, { FEEDS_FILE: file })
    expect((await t.go('sync', '--dry-run')).code).toBe(0)
    expect(existsSync(file)).toBe(false)
    t.world.ready = false
    expect((await t.go()).code).toBe(1)
    expect(existsSync(file)).toBe(false)
    const u = fresh({ SKIP_KEYS: 'latest' })
    Object.assign(u.env, { FEEDS_FILE: feedsIn(u) })
    u.world.keys.length = 0
    expect((await u.go()).code).toBe(1)
    expect(read(feedsIn(u))).toBe(`${HEADER}\n`)
  })

  it('records a file it cannot write as a run error, finishes the sites, and writes it on the next run', async () => {
    const t = fresh()
    const dir = join(t.dir, 'out')
    Object.assign(t.env, { FEEDS_FILE: join(dir, 'feeds.txt') })
    expect((await t.go()).code).toBe(1)
    expect(t.status()).toMatchObject({ ok: false })
    expect(t.status().errors).toHaveLength(1)
    expect(t.status().errors[0]).toMatch(/^the feeds file was not written: .*ENOENT/)
    expect(t.state().sites.explore).toMatchObject({ index: 0 })
    expect(t.state().sites.latest).toMatchObject({ index: 0 })
    expect(t.state().feedsFile).toBeNull()
    mkdirSync(dir)
    expect((await t.go()).code).toBe(0)
    expect(read(join(dir, 'feeds.txt'))).toContain('latest bzz://')
  })

  it('writes nothing when FEEDS_FILE is not set', async () => {
    const t = fresh()
    expect((await t.go()).code).toBe(0)
    expect(t.state().feedsFile).toBeNull()
  })
})
