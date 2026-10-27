import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { datePins, filebaseClient, liveRelayPins, parseKeep, planSync, run } from '../filebase-sync.mjs'

const cid = (tag: string): string => `bafybei${tag.padEnd(52, 'a')}`
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-26T20:00:00Z')

describe('parseKeep', () => {
  it('reads one CID per line and ignores blanks and comments', () => {
    expect(parseKeep(`# the page node\n${cid('b')} # serve mode\n\n${cid('c')}\n`)).toEqual([cid('b'), cid('c')])
  })
  it('refuses a line that is not a CID', () => {
    expect(() => parseKeep(`${cid('b')}\nnot-a-cid`)).toThrow(/line 2/)
  })
})

describe('liveRelayPins', () => {
  it('keeps the CIDs whose last record is not expired, and never revives an expired one', () => {
    const text = [
      { cid: cid('b'), at: 1, bytes: 9, preexisting: false, expired: false },
      { cid: cid('c'), at: 2, bytes: 9, preexisting: false, expired: false },
      { cid: cid('c'), expired: true },
      { cid: cid('d'), at: 3, bytes: 9, preexisting: true, expired: false }
    ].map((r) => JSON.stringify(r)).join('\n')
    expect(liveRelayPins(`${text}\n`)).toEqual([cid('b'), cid('d')])
  })
  it('reads the file the way the relay does: skips a line cut short, forgets a dropped CID', () => {
    const text = [
      JSON.stringify({ cid: cid('b'), at: 1, bytes: 9, preexisting: false, expired: false }),
      '{"cid":"torn',
      JSON.stringify({ cid: cid('c'), at: 2, bytes: 9, preexisting: false, expired: false }),
      JSON.stringify({ cid: cid('c'), dropped: true })
    ].join('\n')
    expect(liveRelayPins(text)).toEqual([cid('b')])
    expect(liveRelayPins('')).toEqual([])
  })
})

describe('datePins', () => {
  it('dates an undated pin from its first sighting and forgets pins no longer listed', () => {
    const first = new Date(NOW - 5 * HOUR).toISOString()
    const { info, seen } = datePins(new Set([cid('b'), cid('c')]), new Map([[cid('b'), { size: 1, created: NOW - 9 * HOUR, name: null }]]), { [cid('c')]: first, [cid('gone')]: first }, NOW)
    expect(info.get(cid('b'))?.created).toBe(NOW - 9 * HOUR)
    expect(info.get(cid('c'))?.created).toBe(NOW - 5 * HOUR)
    expect(Object.keys(seen)).toEqual([cid('c')])
  })
  it('starts the grace period now for a pin it has not seen before', () => {
    const { info, seen } = datePins(new Set([cid('b')]), new Map(), {}, NOW)
    expect(info.get(cid('b'))?.created).toBe(NOW)
    expect(seen[cid('b')]).toBe(new Date(NOW).toISOString())
  })
})

describe('planSync', () => {
  const old = (size: number, hours = 24): any => ({ size, created: NOW - hours * HOUR, name: null })
  const base = { keep: [], protect: [], now: NOW, graceMs: 2 * HOUR, maxRemove: 100, complete: true }
  it('adds the version a key points at when Filebase lacks it, and removes the version it moved past', () => {
    const plan = planSync({ ...base, want: [{ key: 'site', cid: cid('new') }], have: new Set([cid('old')]), info: new Map([[cid('old'), old(10)]]) })
    expect(plan.add).toEqual([{ key: 'site', cid: cid('new') }])
    expect(plan.remove).toEqual([cid('old')])
  })
  it('does nothing when Filebase holds exactly the current versions', () => {
    const plan = planSync({ ...base, want: [{ key: 'a', cid: cid('b') }, { key: 'b', cid: cid('b') }], have: new Set([cid('b')]), info: new Map() })
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.kept).toEqual([cid('b')])
  })
  it('removes the per-file pins of an upload as well, largest first', () => {
    const have = new Set([cid('cur'), cid('big'), cid('small'), cid('mid')])
    const info = new Map([[cid('big'), old(900)], [cid('small'), old(1)], [cid('mid'), old(50)]])
    expect(planSync({ ...base, want: [{ key: 'site', cid: cid('cur') }], have, info }).remove).toEqual([cid('big'), cid('mid'), cid('small')])
  })
  it('spares kept and protected CIDs, and adds a kept CID that is missing', () => {
    const plan = planSync({ ...base, keep: [cid('node'), cid('later')], protect: [cid('wiki')], want: [{ key: 'site', cid: cid('cur') }], have: new Set([cid('cur'), cid('node'), cid('wiki'), cid('old')]), info: new Map() })
    expect(plan.remove).toEqual([cid('old')])
    expect(plan.add).toEqual([{ key: 'keep', cid: cid('later') }])
  })
  it('leaves a pin younger than the grace period, and counts it as deferred', () => {
    const plan = planSync({ ...base, want: [{ key: 'site', cid: cid('cur') }], have: new Set([cid('cur'), cid('fresh'), cid('stale')]), info: new Map([[cid('fresh'), old(1, 1)], [cid('stale'), old(1, 3)]]) })
    expect(plan.remove).toEqual([cid('stale')])
    expect(plan.deferred).toBe(1)
  })
  it('removes nothing when a key could not be read, or when no key points at anything', () => {
    const have = new Set([cid('old')])
    const unread = planSync({ ...base, complete: false, want: [{ key: 'site', cid: cid('cur') }], have, info: new Map() })
    expect(unread.remove).toEqual([])
    expect(unread.blocked).not.toBeNull()
    expect(unread.add).toEqual([{ key: 'site', cid: cid('cur') }])
    const empty = planSync({ ...base, want: [], have, info: new Map() })
    expect(empty.remove).toEqual([])
    expect(empty.blocked).toMatch(/no key/)
  })
  it('removes at most maxRemove a run and says how many wait', () => {
    const have = new Set([cid('cur'), cid('x'), cid('y'), cid('z')])
    const plan = planSync({ ...base, maxRemove: 2, want: [{ key: 'site', cid: cid('cur') }], have, info: new Map() })
    expect(plan.remove).toHaveLength(2)
    expect(plan.over).toBe(1)
  })
})

/** A Kubo node and a Filebase account in one fake `fetch`. */
function services (init: { keys: Record<string, string>, pinned: string[], sizes?: Record<string, number>, created?: Record<string, number>, importStatus?: number, resolveFails?: string[], hidden?: string[], unfinished?: { cid: string, status: string, created: number }[] }) {
  const pinned = new Set(init.pinned)
  const calls: string[] = []
  const dropped: string[] = []
  const fetchFn = (async (input: any, request: any = {}) => {
    const url = new URL(String(input))
    const path = url.pathname
    const arg = url.searchParams.get('arg') ?? ''
    const method = request.method ?? 'GET'
    calls.push(`${method} ${url.host}${path}${arg === '' ? '' : `?arg=${arg}`}`)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.host === 'kubo.test') {
      if (path.endsWith('/key/list')) return json({ Keys: [{ Name: 'self', Id: 'k0' }, ...Object.keys(init.keys).map((name) => ({ Name: name, Id: `id-${name}` }))] })
      if (path.endsWith('/name/resolve')) {
        const name = arg.replace('/ipns/id-', '')
        return init.resolveFails?.includes(name) === true ? new Response('no', { status: 500 }) : json({ Path: `/ipfs/${init.keys[name]}` })
      }
      if (path.endsWith('/dag/stat')) return json({ UniqueBlocks: 2, TotalSize: init.sizes?.[arg] ?? 100, Ratio: 1, DagStats: [{ Cid: arg, Size: init.sizes?.[arg] ?? 100, NumBlocks: 2 }] })
      if (path.endsWith('/dag/export')) return new Response('CARBYTES')
    }
    if (url.host === 'rpc.test') {
      if (path.endsWith('/pin/ls')) return json({ Keys: Object.fromEntries([...pinned].filter((c) => (arg === '' && init.hidden?.includes(c) !== true) || c === arg).map((c) => [c, { Type: 'recursive' }])) })
      if (path.endsWith('/pin/rm')) { pinned.delete(arg); return json({ Pins: [arg] }) }
      if (path.endsWith('/pin/add')) { pinned.add(arg); return json({ Pins: [arg] }) }
      if (path.endsWith('/dag/import')) {
        if (init.importStatus !== undefined && init.importStatus !== 200) return new Response('', { status: init.importStatus })
        const name = ((request.body as FormData).get('file') as File).name.replace('.car', '')
        pinned.add(name)
        return json({ Root: { Cid: { '/': name }, PinErrorMsg: '' } })
      }
    }
    if (url.host === 'psa.test') {
      if (method === 'DELETE') { dropped.push(path.split('/').pop() ?? ''); return new Response('', { status: 202 }) }
      if (url.searchParams.get('status') === 'pinned') {
        return json({ results: [...pinned].map((c) => ({ requestid: `r-${c}`, status: 'pinned', created: new Date(init.created?.[c] ?? NOW - 48 * HOUR).toISOString(), pin: { cid: c, name: c }, info: { size: String(init.sizes?.[c] ?? 1000) } })) })
      }
      return json({ results: (init.unfinished ?? []).map((r) => ({ requestid: `r-${r.cid}`, status: r.status, created: new Date(r.created).toISOString(), pin: { cid: r.cid, name: r.cid }, info: { size: '0' } })) })
    }
    return new Response('unexpected', { status: 404 })
  }) as typeof fetch
  return { fetchFn, pinned, calls, dropped }
}

const dir = () => mkdtempSync(join(tmpdir(), 'filebase-sync-'))
const envFor = (work: string, extra: Record<string, string> = {}): Record<string, string> => ({
  FILEBASE_KEY: 'secret-key', IPFS_API: 'http://kubo.test', FILEBASE_RPC: 'https://rpc.test', FILEBASE_PSA: 'https://psa.test/v1',
  WORK_DIR: join(work, 'work'), GRACE_HOURS: '2', ...extra
})

describe('run', () => {
  it('imports the new version, removes the old one and its per-file pins, and spares the relay and the kept CID', async () => {
    const work = dir()
    writeFileSync(join(work, 'relay.jsonl'), `${JSON.stringify({ cid: cid('wiki'), at: 1, bytes: 1, preexisting: false, expired: false })}\n`)
    writeFileSync(join(work, 'keep.txt'), `${cid('node')}\n`)
    const fake = services({ keys: { site: cid('v2'), docs: cid('docs') }, pinned: [cid('docs'), cid('v1'), cid('v1file'), cid('wiki'), cid('node')] })
    const lines: string[] = []
    const code = await run({ env: envFor(work, { PROTECT_FILE: join(work, 'relay.jsonl'), KEEP_FILE: join(work, 'keep.txt') }), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: (l) => lines.push(l) })
    expect(code).toBe(0)
    expect([...fake.pinned].sort()).toEqual([cid('docs'), cid('node'), cid('v2'), cid('wiki')].sort())
    expect(fake.calls).toContain(`POST kubo.test/api/v0/dag/export?arg=${cid('v2')}`)
    expect(fake.calls).not.toContain(`POST rpc.test/api/v0/pin/add?arg=${cid('v2')}`)
    expect(lines.join('\n')).not.toContain('secret-key')
  })
  it('changes nothing with --dry-run', async () => {
    const work = dir()
    const fake = services({ keys: { site: cid('v2') }, pinned: [cid('v1')] })
    const code = await run({ env: envFor(work), args: ['--dry-run'], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })
    expect(code).toBe(0)
    expect([...fake.pinned]).toEqual([cid('v1')])
    expect(fake.calls.filter((c) => /dag\/import|pin\/rm|pin\/add|DELETE/.test(c))).toEqual([])
  })
  it('adds a version too large for a CAR by CID, and refuses one over MAX_BYTES', async () => {
    const work = dir()
    const sizes = { [cid('big')]: 5_000, [cid('huge')]: 90_000 }
    const fake = services({ keys: { a: cid('big'), b: cid('huge') }, pinned: [], sizes })
    const lines: string[] = []
    const code = await run({ env: envFor(work, { CAR_MAX_BYTES: '1000', MAX_BYTES: '50000' }), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: (l) => lines.push(l) })
    expect(code).toBe(1)
    expect(fake.calls).toContain(`POST rpc.test/api/v0/pin/add?arg=${cid('big')}`)
    expect(fake.calls.filter((c) => c.includes('dag/export'))).toEqual([])
    expect(lines.join('\n')).toMatch(/larger than MAX_BYTES/)
  })
  it('removes nothing while a key cannot be read, and still adds what it can', async () => {
    const work = dir()
    const fake = services({ keys: { site: cid('v2'), docs: cid('docs') }, pinned: [cid('v1'), cid('docs')], resolveFails: ['docs'] })
    const code = await run({ env: envFor(work), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })
    expect(code).toBe(1)
    expect(fake.pinned.has(cid('v1'))).toBe(true)
    expect(fake.pinned.has(cid('docs'))).toBe(true)
    expect(fake.pinned.has(cid('v2'))).toBe(true)
  })
  it('reports a refused import once in the summary log, and still removes the version that was replaced', async () => {
    const work = dir()
    const env = envFor(work, { SUMMARY_LOG: join(work, 'SUMMARY.md'), STATE_FILE: join(work, 'state.json') })
    writeFileSync(join(work, 'SUMMARY.md'), '# summary\n')
    const first = services({ keys: { site: cid('v2') }, pinned: [cid('v1')], importStatus: 403 })
    expect(await run({ env, args: [], fetchFn: first.fetchFn, now: () => NOW, log: () => {} })).toBe(1)
    expect(first.pinned.has(cid('v1'))).toBe(false)
    const afterFirst = readFileSync(join(work, 'SUMMARY.md'), 'utf8')
    expect(afterFirst).toMatch(/Filebase sync: .*not done: site .*403/)
    const second = services({ keys: { site: cid('v2') }, pinned: [], importStatus: 403 })
    expect(await run({ env, args: [], fetchFn: second.fetchFn, now: () => NOW + HOUR, log: () => {} })).toBe(1)
    expect(readFileSync(join(work, 'SUMMARY.md'), 'utf8')).toBe(afterFirst)
  })
  it('starts the grace period for a pin Filebase has no date for, then removes it once the period is over', async () => {
    const work = dir()
    const env = envFor(work, { STATE_FILE: join(work, 'state.json') })
    const undated = (): any => {
      const fake = services({ keys: { site: cid('cur') }, pinned: [cid('cur'), cid('loose')] })
      const inner = fake.fetchFn
      fake.fetchFn = (async (input: any, request: any) => {
        const response = await inner(input, request)
        if (new URL(String(input)).host !== 'psa.test' || request?.method === 'DELETE') return response
        const body: any = await response.json()
        return new Response(JSON.stringify({ results: body.results.filter((r: any) => r.pin.cid !== cid('loose')) }))
      }) as typeof fetch
      return fake
    }
    const first = undated()
    await run({ env, args: [], fetchFn: first.fetchFn, now: () => NOW, log: () => {} })
    expect(first.pinned.has(cid('loose'))).toBe(true)
    const later = undated()
    await run({ env, args: [], fetchFn: later.fetchFn, now: () => NOW + 3 * HOUR, log: () => {} })
    expect(later.pinned.has(cid('loose'))).toBe(false)
  })
  it('does not upload a failing version again until its wait is over, then waits longer', async () => {
    const work = dir()
    const env = envFor(work, { STATE_FILE: join(work, 'state.json') })
    const attempt = async (at: number) => {
      const fake = services({ keys: { site: cid('v2') }, pinned: [], importStatus: 403 })
      const code = await run({ env, args: [], fetchFn: fake.fetchFn, now: () => at, log: () => {} })
      return { code, exported: fake.calls.filter((c) => c.includes('dag/export')).length }
    }
    expect(await attempt(NOW)).toEqual({ code: 1, exported: 1 })
    expect(await attempt(NOW + HOUR / 6)).toEqual({ code: 1, exported: 0 })
    expect(await attempt(NOW + HOUR + 1)).toEqual({ code: 1, exported: 1 })
    expect(await attempt(NOW + 2 * HOUR)).toEqual({ code: 1, exported: 0 })
    expect(await attempt(NOW + 3 * HOUR + 2)).toEqual({ code: 1, exported: 1 })
  })
  it('asks Filebase about a version before uploading it, in case the list of pins was cut short', async () => {
    const work = dir()
    const fake = services({ keys: { site: cid('v2') }, pinned: [cid('v2')], hidden: [cid('v2')] })
    expect(await run({ env: envFor(work), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })).toBe(0)
    expect(fake.calls.filter((c) => /dag\/export|dag\/import|pin\/add/.test(c))).toEqual([])
  })
  it('drops only the stale pin requests: not a protected, a wanted or a young one, and a failed one it replaces', async () => {
    const work = dir()
    writeFileSync(join(work, 'relay.jsonl'), `${JSON.stringify({ cid: cid('wiki'), at: 1, bytes: 1, preexisting: false, expired: false })}\n`)
    const unfinished = [
      { cid: cid('old'), status: 'pinning', created: NOW - 5 * HOUR },
      { cid: cid('wiki'), status: 'pinning', created: NOW - 5 * HOUR },
      { cid: cid('young'), status: 'pinning', created: NOW - HOUR },
      { cid: cid('v2'), status: 'failed', created: NOW - 5 * HOUR },
      { cid: cid('docs'), status: 'pinning', created: NOW - 5 * HOUR }
    ]
    const fake = services({ keys: { site: cid('v2'), docs: cid('docs') }, pinned: [cid('docs')], unfinished })
    await run({ env: envFor(work, { PROTECT_FILE: join(work, 'relay.jsonl') }), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })
    expect(fake.dropped.sort()).toEqual([`r-${cid('old')}`, `r-${cid('v2')}`].sort())
  })
  it('drops no pin request while removal is held back', async () => {
    const work = dir()
    const fake = services({ keys: { site: cid('v2'), docs: cid('docs') }, pinned: [cid('docs')], resolveFails: ['docs'], unfinished: [{ cid: cid('old'), status: 'pinning', created: NOW - 5 * HOUR }] })
    expect(await run({ env: envFor(work), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })).toBe(1)
    expect(fake.dropped).toEqual([])
  })
  it('treats a relay file that does not exist yet as empty, and an empty setting as unset', async () => {
    const work = dir()
    const fake = services({ keys: { site: cid('cur') }, pinned: [cid('cur'), cid('fresh')], created: { [cid('fresh')]: NOW - HOUR } })
    const code = await run({ env: envFor(work, { PROTECT_FILE: join(work, 'missing.jsonl'), GRACE_HOURS: '', MAX_BYTES: '' }), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })
    expect(code).toBe(0)
    expect(fake.pinned.has(cid('fresh'))).toBe(true)
  })
  it('holds removal back, and fails, when a node answers with no keys at all', async () => {
    const work = dir()
    const fake = services({ keys: {}, pinned: [cid('old')] })
    expect(await run({ env: envFor(work), args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })).toBe(1)
    expect(fake.pinned.has(cid('old'))).toBe(true)
  })
  it('holds removal back when most of the keys it saw last time are gone, until the state is cleared', async () => {
    const work = dir()
    const env = envFor(work, { STATE_FILE: join(work, 'state.json') })
    const keys = { a: cid('a'), b: cid('b'), c: cid('c'), d: cid('d') }
    const first = services({ keys, pinned: Object.values(keys) })
    expect(await run({ env, args: [], fetchFn: first.fetchFn, now: () => NOW, log: () => {} })).toBe(0)
    const second = services({ keys: { a: cid('a') }, pinned: [...Object.values(keys), cid('old')] })
    expect(await run({ env, args: [], fetchFn: second.fetchFn, now: () => NOW + 5 * HOUR, log: () => {} })).toBe(1)
    expect(second.pinned.size).toBe(5)
    writeFileSync(join(work, 'state.json'), JSON.stringify({ keys: [] }))
    expect(await run({ env, args: [], fetchFn: second.fetchFn, now: () => NOW + 6 * HOUR, log: () => {} })).toBe(0)
    expect([...second.pinned]).toEqual([cid('a')])
  })
  it('removes a CAR a killed run left behind, and never writes the key into the state or the summary', async () => {
    const work = dir()
    mkdirSync(join(work, 'work'), { recursive: true })
    writeFileSync(join(work, 'work', `${cid('left')}.car`), 'x')
    const env = envFor(work, { STATE_FILE: join(work, 'state.json'), SUMMARY_LOG: join(work, 'SUMMARY.md') })
    const fake = services({ keys: { site: cid('v2') }, pinned: [cid('v1')], importStatus: 403 })
    await run({ env, args: [], fetchFn: fake.fetchFn, now: () => NOW, log: () => {} })
    expect(existsSync(join(work, 'work', `${cid('left')}.car`))).toBe(false)
    expect(readFileSync(join(work, 'state.json'), 'utf8')).not.toContain('secret-key')
    expect(readFileSync(join(work, 'SUMMARY.md'), 'utf8')).not.toContain('secret-key')
  })
  it('refuses a missing key and an unknown argument', async () => {
    const silent = { fetchFn: services({ keys: {}, pinned: [] }).fetchFn, log: () => {} }
    expect(await run({ env: {}, args: [], ...silent })).toBe(2)
    expect(await run({ env: { FILEBASE_KEY: 'k' }, args: ['--prune'], ...silent })).toBe(2)
  })
})

describe('filebaseClient.info', () => {
  const item = (n: number, created: string) => ({ requestid: `r${String(n)}`, status: 'pinned', created, pin: { cid: cid(`x${String(n).padStart(4, '0').replace(/\d/g, (d) => 'abcdefghij'[Number(d)] ?? 'a')}`), name: null }, info: { size: '7' } })
  const client = (fetchFn: typeof fetch) => filebaseClient({ key: 'secret-key', rpc: 'https://rpc.test', psa: 'https://psa.test/v1', fetchFn, sleep: async () => {} })
  it('reads every page, newest first, by the oldest date of the page before', async () => {
    const all = Array.from({ length: 1005 }, (_, n) => item(n, new Date(NOW - n * 1000).toISOString()))
    const fetchFn = (async (input: any) => {
      const before = new URL(String(input)).searchParams.get('before')
      const rest = before === null ? all : all.filter((r) => Date.parse(r.created) < Date.parse(before))
      return new Response(JSON.stringify({ results: rest.slice(0, 1000) }))
    }) as typeof fetch
    expect((await client(fetchFn).info()).size).toBe(1005)
  })
  it('stops when a page makes no progress, instead of asking for ever', async () => {
    const same = Array.from({ length: 1000 }, (_, n) => item(n, new Date(NOW).toISOString()))
    let asked = 0
    const fetchFn = (async () => { asked++; return new Response(JSON.stringify({ results: same })) }) as typeof fetch
    expect((await client(fetchFn).info()).size).toBe(1000)
    expect(asked).toBe(2)
  })
})
