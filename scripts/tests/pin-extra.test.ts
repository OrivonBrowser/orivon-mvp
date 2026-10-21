import { describe, expect, it } from 'vitest'
import { parseExtra, planPins, pinningClient, releasePins, run, selectReleases } from '../pin-extra.mjs'

const CID_A = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_B = 'bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'
const CID_C = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'

const held = (name: string, cid: string, status = 'pinned', requestid = `${name}-${cid.slice(-4)}`): any => ({ requestid, status, pin: { cid, name } })

describe('selectReleases', () => {
  const release = (tag: string, published_at: string, extra: any = {}): any => ({ tag_name: tag, published_at, draft: false, assets: [{ name: 'ipfs.json' }], ...extra })
  it('keeps the newest releases that carry an ipfs.json, skipping drafts and releases without one', () => {
    const picked = selectReleases([
      release('v1', '2026-01-01T00:00:00Z'),
      release('v3', '2026-03-01T00:00:00Z'),
      release('v4', '2026-04-01T00:00:00Z', { draft: true }),
      release('v5', '2026-05-01T00:00:00Z', { assets: [{ name: 'app.deb' }] }),
      release('v2', '2026-02-01T00:00:00Z')
    ], 2)
    expect(picked.map((r: any) => r.tag_name)).toEqual(['v3', 'v2'])
  })
})

describe('parseExtra', () => {
  it('reads name=cid lines and ignores blanks and comments', () => {
    expect(parseExtra(`# apps\norivon-app-lounge=${CID_A}\n\norivon-site-docs = ${CID_C} # docs\n`, 'orivon-')).toEqual([
      { name: 'orivon-app-lounge', cid: CID_A },
      { name: 'orivon-site-docs', cid: CID_C }
    ])
  })
  it('refuses a malformed line, a bad CID, and a name outside the prefix', () => {
    expect(() => parseExtra('orivon-x', 'orivon-')).toThrow(/line 1/)
    expect(() => parseExtra(`orivon-x=notacid`, 'orivon-')).toThrow(/line 1/)
    expect(() => parseExtra(`\nother-x=${CID_A}`, 'orivon-')).toThrow(/line 2.*must start with/)
  })
})

describe('planPins', () => {
  const wanted = [{ name: 'orivon-a', cid: CID_A }, { name: 'orivon-b', cid: CID_B }]
  it('adds only what is missing and reports what is already held', () => {
    const plan = planPins(wanted, [held('orivon-a', CID_A)], { prefix: 'orivon-', prune: false })
    expect(plan.add).toEqual([{ name: 'orivon-b', cid: CID_B }])
    expect(plan.keep).toHaveLength(1)
    expect(plan.remove).toEqual([])
  })
  it('is idempotent: a second plan over the result adds nothing', () => {
    const plan = planPins(wanted, [held('orivon-a', CID_A), held('orivon-b', CID_B, 'queued')], { prefix: 'orivon-', prune: true })
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
  })
  it('prunes only unlisted pins under the prefix, and only with prune', () => {
    const pins = [held('orivon-a', CID_A), held('orivon-old', CID_C), held('someone-else', CID_C)]
    expect(planPins(wanted, pins, { prefix: 'orivon-', prune: false }).remove).toEqual([])
    const plan = planPins(wanted, pins, { prefix: 'orivon-', prune: true })
    expect(plan.remove.map((r) => r.pin.name)).toEqual(['orivon-old'])
  })
  it('treats a name now pointing at a new CID as an add, and prunes the old one', () => {
    const plan = planPins([{ name: 'orivon-a', cid: CID_B }], [held('orivon-a', CID_A)], { prefix: 'orivon-', prune: true })
    expect(plan.add).toEqual([{ name: 'orivon-a', cid: CID_B }])
    expect(plan.remove.map((r) => r.pin.cid)).toEqual([CID_A])
  })
  it('re-adds a failed pin and removes the failed request even without prune', () => {
    const plan = planPins(wanted, [held('orivon-a', CID_A, 'failed', 'r1'), held('orivon-b', CID_B)], { prefix: 'orivon-', prune: false })
    expect(plan.add).toEqual([{ name: 'orivon-a', cid: CID_A }])
    expect(plan.remove.map((r) => r.requestid)).toEqual(['r1'])
  })
  it('lists a repeated entry once', () => {
    expect(planPins([wanted[0]!, wanted[0]!], [], { prefix: 'orivon-', prune: false }).add).toHaveLength(1)
  })
})

interface Call { method: string, url: string, auth: string | null, body: any }

/** A fake pinning service plus GitHub, keeping the pins it was told about. */
function fakeWorld (initial: any[] = [], releaseList: any[] = []) {
  const pins = [...initial]
  const calls: Call[] = []
  const fetchFn = (async (input: string, init: any = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    calls.push({ method, url, auth: init.headers?.authorization ?? null, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
    if (url.startsWith('https://github.test/releases')) return json(releaseList)
    if (url.startsWith('https://dl.test/')) return json({ cid: url.endsWith('v2/ipfs.json') ? CID_B : CID_A })
    if (url.startsWith('https://psa.test/pins') && method === 'GET') return json({ count: pins.length, results: pins })
    if (url.startsWith('https://psa.test/pins') && method === 'POST') {
      const body = JSON.parse(init.body)
      pins.push(held(body.name, body.cid, 'queued', `r${String(pins.length + 1)}`))
      return json({}, 202)
    }
    if (url.startsWith('https://psa.test/pins/') && method === 'DELETE') {
      const id = decodeURIComponent(url.split('/pins/')[1]!)
      pins.splice(pins.findIndex((p) => p.requestid === id), 1)
      return json({}, 202)
    }
    return json({}, 404)
  }) as unknown as typeof fetch
  return { pins, calls, fetchFn }
}

const releases = [
  { tag_name: 'v1', published_at: '2026-01-01T00:00:00Z', draft: false, assets: [{ name: 'ipfs.json', browser_download_url: 'https://dl.test/v1/ipfs.json' }] },
  { tag_name: 'v2', published_at: '2026-02-01T00:00:00Z', draft: false, assets: [{ name: 'ipfs.json', browser_download_url: 'https://dl.test/v2/ipfs.json' }] }
]
const env = { PINNING_ENDPOINT: 'https://psa.test', PINNING_TOKEN: 'secret-token', RELEASES_URL: 'https://github.test/releases', KEEP: '2' }

describe('run', () => {
  it('pins the releases and the extra file, then does nothing on a second run', async () => {
    const world = fakeWorld([], releases)
    const lines: string[] = []
    const args = ['--extra', 'extra.txt']
    const readFile = (): string => `orivon-app-lounge=${CID_C}\n`
    expect(await run({ env, args, fetchFn: world.fetchFn, readFile, log: (l) => lines.push(l) })).toBe(0)
    expect(world.pins.map((p) => `${p.pin.name}=${p.pin.cid}`).sort()).toEqual([
      `orivon-app-lounge=${CID_C}`, `orivon-release-v1=${CID_A}`, `orivon-release-v2=${CID_B}`
    ])
    const before = world.calls.filter((c) => c.method === 'POST').length
    expect(before).toBe(3)
    expect(await run({ env, args, fetchFn: world.fetchFn, readFile, log: () => {} })).toBe(0)
    expect(world.calls.filter((c) => c.method === 'POST')).toHaveLength(3)
    expect(lines.every((l) => !l.includes('secret-token'))).toBe(true)
  })

  it('sends the token only as a bearer header', async () => {
    const world = fakeWorld([], releases)
    await run({ env, args: [], fetchFn: world.fetchFn, log: () => {} })
    const service = world.calls.filter((c) => c.url.startsWith('https://psa.test'))
    expect(service.length).toBeGreaterThan(0)
    expect(service.every((c) => c.auth === 'Bearer secret-token' && !c.url.includes('secret-token'))).toBe(true)
  })

  it('--dry-run reads but never writes, and says what it would do', async () => {
    const world = fakeWorld([held('orivon-old', CID_C)], releases)
    const lines: string[] = []
    expect(await run({ env, args: ['--dry-run', '--prune'], fetchFn: world.fetchFn, log: (l) => lines.push(l) })).toBe(0)
    expect(world.calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(lines.filter((l) => l.startsWith('would add'))).toHaveLength(2)
    expect(lines).toContain(`would remove orivon-old ${CID_C}`)
  })

  it('--prune removes a pin that is no longer listed and leaves foreign pins', async () => {
    const world = fakeWorld([held('orivon-release-v0', CID_C), held('mine', CID_C)], releases)
    expect(await run({ env, args: ['--prune'], fetchFn: world.fetchFn, log: () => {} })).toBe(0)
    expect(world.pins.map((p) => p.pin.name).sort()).toEqual(['mine', 'orivon-release-v1', 'orivon-release-v2'])
  })

  it('never prunes when a release could not be read, and exits 1', async () => {
    const world = fakeWorld([held('orivon-release-v0', CID_C)], [{ ...releases[1], assets: [{ name: 'ipfs.json', browser_download_url: 'https://dl.test/gone/ipfs.json' }] }])
    const failing = (async (input: string, init: any) => String(input).startsWith('https://dl.test/gone') ? new Response('', { status: 500 }) : await world.fetchFn(input, init)) as unknown as typeof fetch
    expect(await run({ env, args: ['--prune'], fetchFn: failing, log: () => {} })).toBe(1)
    expect(world.pins.map((p) => p.pin.name)).toEqual(['orivon-release-v0'])
  })

  it('exits 2 without credentials, with a bad flag, or with a bad extra file', async () => {
    const quiet = silenceErrors()
    expect(await run({ env: {}, args: [], log: () => {} })).toBe(2)
    expect(await run({ env, args: ['--nope'], log: () => {} })).toBe(2)
    expect(await run({ env, args: ['--extra', 'x'], readFile: () => 'bad line', fetchFn: fakeWorld().fetchFn, log: () => {} })).toBe(2)
    expect(await run({ env: { ...env, PINNING_ENDPOINT: 'http://insecure.test' }, args: [], log: () => {} })).toBe(2)
    quiet()
  })

  it('exits 1 when the service refuses a pin', async () => {
    const world = fakeWorld([], releases)
    const refusing = (async (input: string, init: any) => init?.method === 'POST' ? new Response('', { status: 402 }) : await world.fetchFn(input, init)) as unknown as typeof fetch
    expect(await run({ env, args: [], fetchFn: refusing, log: () => {} })).toBe(1)
  })
})

describe('pinningClient', () => {
  it('waits and retries on 429, and pages with before', async () => {
    const answers = [429, 200]
    let sleeps = 0
    const client = pinningClient({
      endpoint: 'https://psa.test/', token: 't',
      sleep: async () => { sleeps++ },
      fetchFn: (async () => {
        const status = answers.shift() ?? 200
        return status === 429 ? new Response('', { status, headers: { 'retry-after': '1' } }) : new Response(JSON.stringify({ results: [] }), { status })
      }) as unknown as typeof fetch
    })
    expect(await client.list('orivon-')).toEqual([])
    expect(sleeps).toBe(1)
  })

  it('treats 409 on add as already pinned', async () => {
    const client = pinningClient({ endpoint: 'https://psa.test', token: 't', fetchFn: (async () => new Response('', { status: 409 })) as unknown as typeof fetch })
    await expect(client.add({ name: 'orivon-a', cid: CID_A })).resolves.toBeUndefined()
  })
})

describe('releasePins', () => {
  it('names each release pin orivon-release-<tag>', async () => {
    const world = fakeWorld([], releases)
    const got = await releasePins({ releasesUrl: 'https://github.test/releases', keep: 1, prefix: 'orivon-', fetchFn: world.fetchFn, log: () => {} })
    expect(got).toEqual({ wanted: [{ name: 'orivon-release-v2', cid: CID_B }], complete: true })
  })
})

function silenceErrors (): () => void {
  const original = console.error
  console.error = () => {}
  return () => { console.error = original }
}
