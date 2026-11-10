import { describe, expect, it } from 'vitest'
import { createCookieMirror } from '../cookie-mirror.js'
import type { MirrorRecord } from '../mirror-record.js'
import { FakeCookieStore, signIn } from './fake-cookie-store.test-helpers.js'

const NOW_MS = 1_800_000_000_000
const SITE = 'https://example.com/'
const NYM = 'tunnel-profile'
const DIRECT = 'direct-profile'

interface Rig {
  readonly main: FakeCookieStore
  readonly nym: FakeCookieStore
  readonly direct: FakeCookieStore
  readonly mirror: ReturnType<typeof createCookieMirror>
  readonly logs: string[]
  /** The record as it is on disk now, and every version written. */
  readonly disk: { current: MirrorRecord, readonly history: MirrorRecord[], failWrites: boolean }
}

interface RigOptions {
  /** The profiles that join; the default is both. */
  readonly join?: Array<'nym' | 'direct'>
  /** What an earlier run recorded. */
  readonly record?: MirrorRecord
  /** The stores of an earlier run, for a rig that starts again on them. */
  readonly stores?: Pick<Rig, 'main' | 'nym' | 'direct'>
}

function rig (options: RigOptions = {}): Rig {
  const main = options.stores?.main ?? new FakeCookieStore('default')
  const nym = options.stores?.nym ?? new FakeCookieStore(NYM)
  const direct = options.stores?.direct ?? new FakeCookieStore(DIRECT)
  const logs: string[] = []
  const disk = { current: options.record ?? { domains: {}, owed: false }, history: [] as MirrorRecord[], failWrites: false }
  const mirror = createCookieMirror({
    main: { label: 'default', store: main },
    record: {
      read: () => structuredClone(disk.current),
      write: (record) => {
        if (disk.failWrites) return false
        disk.current = structuredClone(record)
        disk.history.push(structuredClone(record))
        return true
      }
    },
    open: (label) => ({ [NYM]: nym, [DIRECT]: direct })[label],
    now: () => NOW_MS,
    log: (line) => { logs.push(line) }
  })
  const join = options.join ?? ['nym', 'direct']
  if (join.includes('nym')) void mirror.join({ label: NYM, store: nym })
  if (join.includes('direct')) void mirror.join({ label: DIRECT, store: direct })
  return { main, nym, direct, mirror, logs, disk }
}

const writes = (store: FakeCookieStore): number => store.writes.length
/** The first request of a navigation the person started (the address bar, a bookmark): the one load that may add a site before the page asks. */
const visit = async (r: Rig, label: string = NYM, address: string = SITE): Promise<void> => { await r.mirror.visit(label, address, true) }
/** A mirror that is started and has copied the site into the profiles named. */
async function watching (r: Rig, labels: string[] = [NYM, DIRECT]): Promise<void> {
  await r.mirror.start()
  for (const label of labels) await visit(r, label)
  await r.mirror.idle()
}

describe('copying a site into a profile', () => {
  it('copies the default session\'s cookies of the site, the default winning, and removes what only the profile holds there: nothing goes the other way', async () => {
    const r = rig()
    r.main.seed(signIn({ name: 'sid', value: 'default-sid' })); r.main.seed(signIn({ name: 'only-default', value: 'd' }))
    r.nym.seed(signIn({ name: 'sid', value: 'nym-sid' })); r.nym.seed(signIn({ name: 'only-nym', value: 'n' }))
    await r.mirror.start()
    await visit(r)
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('default-sid')
    expect(r.nym.get('only-default')?.value).toBe('d')
    expect(r.nym.get('only-nym'), 'the profile\'s own cookie of the site is gone').toBeUndefined()
    expect(r.main.get('only-nym'), 'and was not given to the default session').toBeUndefined()
    expect(writes(r.main)).toBe(0)
  })

  it('copies the cookies of the site\'s subdomains and its registrable domain, and no other site\'s', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'wide', domain: '.example.com', hostOnly: false }))
    r.main.seed(signIn({ name: 'shop', domain: 'shop.example.com' }))
    r.main.seed(signIn({ name: 'lookalike', domain: 'notexample.com' }))
    r.main.seed(signIn({ name: 'tracker', domain: 'tracker.test', sameSite: 'no_restriction' }))
    await r.mirror.start()
    await visit(r, NYM, 'https://www.example.com/page')
    await r.mirror.idle()
    expect(r.nym.get('wide')).toBeDefined()
    expect(r.nym.get('shop')).toBeDefined()
    expect(r.nym.get('lookalike')).toBeUndefined()
    expect(r.nym.get('tracker')).toBeUndefined()
  })

  it('records the site before it writes anything, and a site that cannot be recorded is not mirrored', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    let recordedFirst: unknown
    const set = r.nym.set.bind(r.nym)
    r.nym.set = async (details) => { recordedFirst ??= structuredClone(r.disk.current.domains); await set(details) }
    await r.mirror.start()
    await visit(r)
    expect(recordedFirst).toEqual({ [NYM]: ['example.com'] })
    r.disk.failWrites = true
    r.main.seed(signIn({ name: 'other', domain: 'other.test' }))
    await visit(r, NYM, 'https://other.test/')
    await r.mirror.idle()
    expect(r.nym.get('other')).toBeUndefined()
    r.main.siteSets(signIn({ name: 'other', value: 'later', domain: 'other.test' }))
    await r.mirror.idle()
    expect(r.nym.get('other'), 'and nothing it changes later is carried').toBeUndefined()
  })

  it('asks the page to wait only for a site that is new to the profile, and for none while the mirror is off', async () => {
    const r = rig({ join: ['nym'] })
    expect(r.mirror.visit(NYM, SITE, true), 'off').toBeUndefined()
    await r.mirror.start()
    const first = r.mirror.visit(NYM, SITE, true)
    expect(first).toBeDefined()
    expect(r.mirror.visit(NYM, SITE, true), 'the same site while it is being copied waits for the same copy').toBe(first)
    await first
    expect(r.mirror.visit(NYM, 'https://www.example.com/other', true), 'a page of a site already copied').toBeUndefined()
    expect(r.mirror.visit(NYM, 'not an address', true), 'no site').toBeUndefined()
    expect(r.mirror.visit('unknown-profile', 'https://other.test/', true), 'a profile that did not join').toBeUndefined()
  })

  it('keeps host-only cookies host-only, domain cookies on their domain, and session cookies session cookies', async () => {
    const r = rig({ join: ['nym'] })
    const { expirationDate: _gone, ...rest } = signIn({ name: 'temp', value: 't' })
    r.main.seed(signIn({ name: 'host', value: 'h', expirationDate: 4_100_000_000, sameSite: 'strict' }))
    r.main.seed(signIn({ name: 'wide', value: 'w', domain: '.example.com', hostOnly: false, path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' }))
    r.main.seed({ ...rest, session: true })
    await watching(r, [NYM])
    expect(r.nym.get('host')).toMatchObject({ domain: 'example.com', hostOnly: true, secure: true, httpOnly: true, sameSite: 'strict', session: false, expirationDate: 4_100_000_000 })
    expect(r.nym.get('wide')).toMatchObject({ domain: '.example.com', hostOnly: false, path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' })
    expect(r.nym.get('temp')).toMatchObject({ session: true })
    expect(r.nym.get('temp')?.expirationDate).toBeUndefined()
  })

  it('does not carry a cookie that has already expired', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'old', expirationDate: NOW_MS / 1000 - 5 }))
    await watching(r, [NYM])
    expect(r.nym.get('old')).toBeUndefined()
  })

  it('writes nothing when the profile already holds the same cookies of the site', async () => {
    const r = rig()
    for (const store of [r.main, r.nym]) store.seed(signIn())
    await watching(r, [NYM])
    expect([r.main, r.nym].map(writes)).toEqual([0, 0])
  })

  it('does nothing before it is started, and starting twice changes nothing', async () => {
    const r = rig({ join: ['nym'], record: { domains: { [NYM]: ['example.com'] }, owed: false } })
    r.main.seed(signIn())
    await r.mirror.idle()
    expect(r.nym.contents()).toEqual([])
    expect(r.nym.listening).toBe(0)
    await r.mirror.start(); await r.mirror.start()
    await r.mirror.idle()
    expect(r.nym.contents()).toHaveLength(1)
    expect(r.nym.listening).toBe(1)
  })
})

describe('which loads add a site', () => {
  const TRACKER_HOP = 'https://tracker.test/r?u=https%3A%2F%2Fexample.com%2F'

  it('adds no site for a load the browser did not start, and copies nothing for it: a redirect hop or a page\'s own navigation', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'uid', value: 'normal-identity', domain: 'tracker.test', sameSite: 'no_restriction' }))
    await r.mirror.start()
    expect(r.mirror.visit(NYM, TRACKER_HOP, false), 'nothing to wait for').toBeUndefined()
    await r.mirror.idle()
    expect(r.nym.contents(), 'the tracker\'s cookie was not copied').toEqual([])
    expect(r.disk.current.domains, 'and the tracker is not in the scope').toEqual({})
    r.main.siteSets(signIn({ name: 'uid', value: 'changed-in-normal-browsing', domain: 'tracker.test', sameSite: 'no_restriction' }))
    await r.mirror.idle()
    expect(r.nym.contents(), 'nor is a later change of it followed').toEqual([])
  })

  it('still makes a page wait for the copy of a site that is being added, whatever started the load', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await r.mirror.start()
    const adding = r.mirror.visit(NYM, SITE, true)
    expect(adding).toBeDefined()
    expect(r.mirror.visit(NYM, SITE, false), 'a redirect hop to the same site waits for the same copy').toBe(adding)
    await adding
    expect(r.mirror.visit(NYM, SITE, false), 'and for nothing once it is copied').toBeUndefined()
  })

  it('adds a site when a navigation to it commits as the top-level page of a tab, copying the default session\'s cookies of it', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'sid', value: 'default-sid' }))
    await r.mirror.start()
    await r.mirror.committed(NYM, 'https://www.example.com/after-a-page-started-it')
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('default-sid')
    expect(r.disk.current.domains).toEqual({ [NYM]: ['example.com'] })
    r.main.siteSets(signIn({ name: 'sid', value: 'default-later' }))
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value, 'and it is followed from then on').toBe('default-later')
  })

  it('adds a site once, however often navigations to it commit, and none while the mirror is off or for a profile that did not join', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await r.mirror.committed(NYM, SITE)
    expect(r.disk.history, 'off: nothing recorded').toEqual([])
    await r.mirror.start()
    await r.mirror.committed('unknown-profile', SITE)
    await r.mirror.committed(NYM, 'not an address')
    expect(r.disk.history, 'nothing recorded for either').toEqual([])
    await Promise.all([r.mirror.committed(NYM, SITE), r.mirror.committed(NYM, SITE)])
    await r.mirror.committed(NYM, SITE)
    await r.mirror.idle()
    expect(r.disk.history.map((record) => record.domains)).toEqual([{ [NYM]: ['example.com'] }])
    expect(writes(r.nym)).toBe(1)
  })
})

describe('what is never mirrored', () => {
  it('leaves a tracker\'s cookie where it was minted: a third party the tab embeds is not a site the person opened', async () => {
    const r = rig()
    await watching(r)
    r.nym.siteSets(signIn({ name: 'uid', value: 'minted-in-the-tunnel', domain: 'tracker.test', sameSite: 'no_restriction' }))
    r.main.siteSets(signIn({ name: 'uid', value: 'minted-in-normal-browsing', domain: 'tracker.test', sameSite: 'no_restriction' }))
    await r.mirror.idle()
    expect(r.main.get('uid')?.value).toBe('minted-in-normal-browsing')
    expect(r.nym.get('uid')?.value).toBe('minted-in-the-tunnel')
    expect(r.direct.get('uid')).toBeUndefined()
  })

  it('mirrors a site only into the profiles a tab opened it in', async () => {
    const r = rig()
    await watching(r, [NYM])
    r.main.siteSets(signIn({ value: 'in-default' }))
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('in-default')
    expect(r.direct.get('sid')).toBeUndefined()
    r.direct.siteSets(signIn({ value: 'in-direct' }))
    await r.mirror.idle()
    expect(r.main.get('sid')?.value, 'the direct profile has not opened it').toBe('in-default')
  })

  it('does not copy a site that was opened while the mirror was off', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await visit(r)
    await r.mirror.start(); await r.mirror.idle()
    expect(r.nym.contents()).toEqual([])
  })
})

describe('following the sessions', () => {
  it('carries a cookie a site sets in a profile to the default and the other profiles, and writes each place once: it does not echo', async () => {
    const r = rig()
    await watching(r)
    r.nym.siteSets(signIn({ value: 'fresh' }))
    await r.mirror.idle()
    expect(r.main.get('sid')?.value).toBe('fresh')
    expect(r.direct.get('sid')?.value).toBe('fresh')
    expect([writes(r.main), writes(r.nym), writes(r.direct)]).toEqual([1, 0, 1])
    await r.mirror.idle()
    expect([writes(r.main), writes(r.nym), writes(r.direct)]).toEqual([1, 0, 1])
  })

  it('carries a cookie a site sets in the default session to every profile that opened the site', async () => {
    const r = rig()
    await watching(r)
    r.main.siteSets(signIn({ value: 'in-default' }))
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('in-default')
    expect(r.direct.get('sid')?.value).toBe('in-default')
    expect([writes(r.main), writes(r.nym), writes(r.direct)]).toEqual([0, 1, 1])
  })

  it('follows a changed value as a change and not as a removal', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'one' }))
    await watching(r, [NYM])
    r.main.siteSets(signIn({ value: 'two' }))
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('two')
    expect(r.nym.writes.filter((write) => write.kind === 'remove')).toEqual([])
  })

  it('signs out everywhere when a site deletes the cookie by sending it already expired, in either direction', async () => {
    const r = rig()
    r.main.seed(signIn())
    await watching(r)
    expect(r.direct.get('sid')).toBeDefined()
    r.nym.siteExpires('sid', 'example.com')
    await r.mirror.idle()
    expect([r.main.get('sid'), r.nym.get('sid'), r.direct.get('sid')]).toEqual([undefined, undefined, undefined])
    r.main.siteSets(signIn({ value: 'again' })); await r.mirror.idle()
    r.main.siteExpires('sid', 'example.com'); await r.mirror.idle()
    expect([r.nym.get('sid'), r.direct.get('sid')]).toEqual([undefined, undefined])
  })

  it('leaves a cookie in the other sessions when one session lets it lapse or evicts it', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'ran-out' })); r.main.seed(signIn({ name: 'evicted' }))
    await watching(r, [NYM])
    r.main.lapses('ran-out', 'example.com', 'expired'); r.main.lapses('evicted', 'example.com', 'evicted')
    await r.mirror.idle()
    expect(r.nym.get('ran-out')).toBeDefined()
    expect(r.nym.get('evicted')).toBeDefined()
  })

  it('puts back a cookie of the same name that a removal took with it', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'sid', value: 'host-only' }))
    r.main.seed(signIn({ name: 'sid', value: 'wide', domain: '.example.com', hostOnly: false }))
    await watching(r, [NYM])
    r.nym.siteExpires('sid', 'example.com')
    await r.mirror.idle()
    expect(r.main.get('sid', '.example.com')?.value, 'the domain cookie the removal swept up was put back').toBe('wide')
    expect(r.nym.get('sid', '.example.com')?.value).toBe('wide')
    expect(r.main.get('sid', 'example.com')).toBeUndefined()
    expect(r.nym.get('sid', 'example.com')).toBeUndefined()
  })

  it('does not put back a cookie of that name which the removal would not have sent, over a value that changed meanwhile', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'sid', value: 'old', domain: 'other.example.com' }))
    r.nym.seed(signIn({ name: 'sid', value: 'old', domain: 'other.example.com' }))
    r.main.seed(signIn({ name: 'sid', value: 'one' }))
    await watching(r, [NYM])
    r.nym.siteExpires('sid', 'example.com')
    r.main.siteSets(signIn({ name: 'sid', value: 'newer', domain: 'other.example.com' }))
    await r.mirror.idle()
    expect(r.main.get('sid', 'other.example.com')?.value).toBe('newer')
    expect(r.nym.get('sid', 'other.example.com')?.value, 'the newer value reached the profile, not overwritten by the older one').toBe('newer')
    expect(r.main.get('sid', 'example.com')).toBeUndefined()
  })

  it('writes no cookie of a name, domain and path that a listing shows twice (partitioned cookies do), and says so once without naming one', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'embed', value: 'under-site-a', sameSite: 'no_restriction' }))
    r.main.shadow(signIn({ name: 'embed', value: 'under-site-b', sameSite: 'no_restriction' }))
    r.main.seed(signIn({ name: 'plain', value: 'kept' }))
    r.nym.seed(signIn({ name: 'tunnelled-embed', value: 'x' }))
    r.nym.shadow(signIn({ name: 'tunnelled-embed', value: 'y' }))
    await watching(r, [NYM])
    expect(r.nym.get('embed'), 'not copied into the profile').toBeUndefined()
    expect(r.nym.get('plain')?.value).toBe('kept')
    r.main.siteSets(signIn({ name: 'embed', value: 'changed', sameSite: 'no_restriction' }))
    await r.mirror.idle()
    expect(r.nym.get('embed')).toBeUndefined()
    expect(r.logs.filter((line) => line.includes('share a name')).length).toBe(1)
    expect(r.logs.join('\n')).not.toContain('embed')
  })

  it('carries a cookie again once the look-alike that kept it from being written is gone', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'one' }))
    r.main.shadow(signIn({ value: 'partitioned', sameSite: 'no_restriction' }))
    await watching(r, [NYM])
    expect(r.nym.get('sid'), 'while a look-alike is listed it is not written').toBeUndefined()
    r.main.dropShadows()
    r.main.siteSets(signIn({ value: 'signed-in-again' }))
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value, 'a new sign-in on the same cookie is carried').toBe('signed-in-again')
  })

  it('reports a write that failed, names no cookie, and carries on with the next one', async () => {
    const r = rig({ join: ['nym'] })
    await watching(r, [NYM])
    r.nym.failNextSet = 'invalid cookie'
    r.main.siteSets(signIn({ name: 'first-cookie' })); await r.mirror.idle()
    r.main.siteSets(signIn({ name: 'second-cookie' })); await r.mirror.idle()
    expect(r.nym.get('first-cookie')).toBeUndefined()
    expect(r.nym.get('second-cookie')).toBeDefined()
    expect(r.mirror.status().failed).toBe(1)
    expect(r.logs.join('\n')).not.toContain('first-cookie')
  })

  it('stops after a bounded number of writes when two stores keep changing what they are given', async () => {
    const r = rig({ join: ['nym'] })
    await watching(r, [NYM])
    r.nym.corrupts = true
    r.main.corrupts = true
    r.main.siteSets(signIn({ value: 'a' }))
    await r.mirror.idle()
    expect(writes(r.nym)).toBeLessThanOrEqual(35)
    expect(writes(r.main)).toBeLessThanOrEqual(35)
    expect(r.mirror.status().suppressed).toBeGreaterThan(0)
    expect(r.logs.some((line) => line.includes('keeps changing'))).toBe(true)
  })
})

describe('two sessions that disagree', () => {
  it('lets the later of two conflicting changes win, whichever session it was made in', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'old' }))
    await watching(r, [NYM])
    r.main.siteSets(signIn({ value: 'a' }))
    r.nym.siteSets(signIn({ value: 'b' }))
    await r.mirror.idle()
    expect([r.main.get('sid')?.value, r.nym.get('sid')?.value]).toEqual(['b', 'b'])
    r.nym.siteSets(signIn({ value: 'c' }))
    r.main.siteSets(signIn({ value: 'd' }))
    await r.mirror.idle()
    expect([r.main.get('sid')?.value, r.nym.get('sid')?.value]).toEqual(['d', 'd'])
  })

  it('lets a later change win over an earlier removal, and a later removal over an earlier change', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'old' }))
    await watching(r, [NYM])
    r.main.siteExpires('sid', 'example.com')
    r.nym.siteSets(signIn({ value: 'signed-in-again' }))
    await r.mirror.idle()
    expect([r.main.get('sid')?.value, r.nym.get('sid')?.value]).toEqual(['signed-in-again', 'signed-in-again'])
    r.nym.siteSets(signIn({ value: 'changed' }))
    r.main.siteExpires('sid', 'example.com')
    await r.mirror.idle()
    expect([r.main.get('sid'), r.nym.get('sid')]).toEqual([undefined, undefined])
  })

  it('signs the other session out when the cookie was removed while a partitioned twin of it is listed, and does not turn the twin into an ordinary cookie', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'one' }))
    await watching(r, [NYM])
    r.main.shadow(signIn({ value: 'partitioned', sameSite: 'no_restriction' }))
    r.main.siteExpires('sid', 'example.com')
    await r.mirror.idle()
    expect(r.nym.contents().filter((cookie) => cookie.name === 'sid'), 'signed out in the profile too, and the twin was not carried').toEqual([])
  })

  it('removes the other session\'s cookie only while it still holds the value last mirrored', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ value: 'one' }))
    await watching(r, [NYM])
    r.main.siteExpires('sid', 'example.com')
    r.nym.siteSets(signIn({ value: 'changed-in-the-tunnel' }))
    await r.mirror.idle()
    expect(r.main.get('sid')?.value, 'the later change in the profile is kept and given back').toBe('changed-in-the-tunnel')
  })

  it('does not turn a removal it made itself into a removal everywhere when a cookie it swept up cannot be written back', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'sid', value: 'host-only' }))
    r.main.seed(signIn({ name: 'sid', value: 'wide', domain: '.example.com', hostOnly: false }))
    await watching(r, [NYM])
    const set = r.nym.set.bind(r.nym)
    let refused = 0
    r.nym.set = async (details) => { if (details.domain === '.example.com' && refused < 1) { refused += 1; throw new Error('refused') } await set(details) }
    r.main.siteExpires('sid', 'example.com')
    await r.mirror.idle()
    expect(r.main.get('sid', '.example.com')?.value, 'the domain cookie is still in the default session').toBe('wide')
    expect(r.nym.get('sid', '.example.com')?.value, 'and the profile got it back from there').toBe('wide')
  })
})

describe('how much it reads', () => {
  it('copies a site of 2,000 cookies with a handful of reads of the jar and none for each cookie', async () => {
    const r = rig({ join: ['nym'] })
    for (let i = 0; i < 2000; i++) r.main.seed(signIn({ name: `c${String(i)}`, value: 'v' }))
    for (let i = 0; i < 1000; i++) r.main.seed(signIn({ name: `other${String(i)}`, value: 'v', domain: `site${String(i)}.test` }))
    await watching(r, [NYM])
    expect(r.nym.contents()).toHaveLength(2000)
    expect(r.main.scans + r.nym.scans, 'reads of the whole jar').toBeLessThanOrEqual(4)
    expect(r.main.lookups + r.nym.lookups, 'reads for one cookie').toBeLessThanOrEqual(20)
  })

  it('makes a profile equal to the default session at start with a handful of reads as well', async () => {
    const earlier = rig({ join: ['nym'] })
    const record = { domains: { [NYM]: ['example.com'] }, owed: false }
    for (let i = 0; i < 2000; i++) { earlier.main.seed(signIn({ name: `c${String(i)}`, value: 'v' })); earlier.nym.seed(signIn({ name: `c${String(i)}`, value: i % 2 === 0 ? 'v' : 'stale' })) }
    const r = rig({ join: ['nym'], record, stores: earlier })
    await r.mirror.start(); await r.mirror.idle()
    expect(r.nym.contents().every((cookie) => cookie.value === 'v')).toBe(true)
    expect(r.main.scans + r.nym.scans).toBeLessThanOrEqual(4)
    expect(r.main.lookups + r.nym.lookups).toBeLessThanOrEqual(20)
  })

  it('reads a bounded number of times for a change in a large site', async () => {
    const r = rig({ join: ['nym'] })
    for (let i = 0; i < 2000; i++) r.main.seed(signIn({ name: `c${String(i)}`, value: 'v' }))
    await watching(r, [NYM])
    const before = r.main.scans + r.nym.scans + r.main.lookups + r.nym.lookups
    r.main.siteSets(signIn({ name: 'c7', value: 'changed' }))
    await r.mirror.idle()
    expect(r.nym.get('c7')?.value).toBe('changed')
    expect(r.main.scans + r.nym.scans, 'no read of the jar for a change').toBe(r.main.scans + r.nym.scans)
    expect(r.main.scans + r.nym.scans + r.main.lookups + r.nym.lookups - before).toBeLessThanOrEqual(6)
  })

  it('copies a profile that joins during an endless stream of changes before it carries more of them', async () => {
    const r = rig({ join: ['nym'], record: { domains: { [NYM]: ['example.com'], late: ['example.com'] }, owed: false } })
    r.main.seed(signIn({ name: 'seen-by-late', value: 'v' }))
    await r.mirror.start(); await r.mirror.idle()
    let reads = 0
    const find = r.nym.find.bind(r.nym)
    r.nym.find = async (address, name) => { reads += 1; if (reads < 400) r.main.siteSets(signIn({ name: `n${String(reads)}`, value: 'v' })); return await find(address, name) }
    r.main.siteSets(signIn({ name: 'first' }))
    const late = new FakeCookieStore('late')
    while (reads < 5) await Promise.resolve()
    const readsWhenJoined = reads
    await r.mirror.join({ label: 'late', store: late })
    expect(late.get('seen-by-late')?.value).toBe('v')
    expect(reads - readsWhenJoined, 'the join did not wait for the whole stream').toBeLessThan(60)
    await r.mirror.idle()
    expect(late.contents().length, 'and it was followed afterwards').toBeGreaterThan(50)
  })
})

describe('a session that joins after the mirror started', () => {
  it('takes the default\'s cookies of the sites already recorded for it, and gives the default nothing', async () => {
    const r = rig({ join: ['nym'], record: { domains: { [DIRECT]: ['example.com'] }, owed: false } })
    r.main.seed(signIn({ name: 'sid', value: 'default-sid' }))
    await r.mirror.start(); await r.mirror.idle()
    r.direct.seed(signIn({ name: 'sid', value: 'direct-sid' })); r.direct.seed(signIn({ name: 'late', value: 'l' }))
    await r.mirror.join({ label: DIRECT, store: r.direct })
    expect(r.direct.get('sid')?.value).toBe('default-sid')
    expect(r.direct.get('late'), 'what only it held is gone').toBeUndefined()
    expect(r.main.get('late')).toBeUndefined()
    expect(r.direct.listening).toBe(1)
  })

  it('resolves a join made while the mirror is off at once, and one made as it starts when the first copy is done', async () => {
    const r = rig({ join: ['nym'], record: { domains: { [NYM]: ['example.com'], late: ['example.com'] }, owed: false } })
    r.main.seed(signIn({ value: 'default-sid' }))
    await r.mirror.join({ label: DIRECT, store: r.direct })
    expect(r.direct.contents()).toEqual([])
    const late = new FakeCookieStore('late')
    void r.mirror.start()
    await r.mirror.join({ label: 'late', store: late })
    expect(r.nym.get('sid')?.value).toBe('default-sid')
    expect(late.get('sid')?.value).toBe('default-sid')
  })

  it('is followed from then on, and joined once however often it is announced', async () => {
    const r = rig({ join: ['nym'] })
    await watching(r, [NYM])
    void r.mirror.join({ label: DIRECT, store: r.direct })
    void r.mirror.join({ label: DIRECT, store: r.direct })
    void r.mirror.join({ label: DIRECT, store: new FakeCookieStore('same session, new handle') })
    await visit(r, DIRECT)
    r.main.siteSets(signIn({ value: 'after' })); await r.mirror.idle()
    expect(r.direct.get('sid')?.value).toBe('after')
    expect(r.direct.listening).toBe(1)
    expect(r.mirror.status().sessions).toBe(2)
  })
})

describe('turning the mirror off again', () => {
  it('clears the cookies of the recorded sites from the profiles, leaves their other cookies and the default\'s, stops following, and empties the record', async () => {
    const r = rig()
    r.main.seed(signIn())
    r.nym.seed(signIn({ name: 'unrelated', domain: 'elsewhere.test' }))
    await watching(r)
    expect(r.nym.get('sid')).toBeDefined()
    await r.mirror.stop()
    expect(r.nym.get('sid')).toBeUndefined()
    expect(r.direct.contents()).toEqual([])
    expect(r.nym.get('unrelated'), 'a cookie of a site that was never mirrored stays').toBeDefined()
    expect(r.main.contents()).toHaveLength(1)
    expect([r.main.listening, r.nym.listening, r.direct.listening]).toEqual([0, 0, 0])
    expect(r.disk.current).toEqual({ domains: {}, owed: false })
    r.main.siteSets(signIn({ name: 'later' })); r.nym.siteSets(signIn({ name: 'tunnelled' }))
    await r.mirror.idle()
    expect(r.nym.get('later')).toBeUndefined()
    expect(r.main.get('tunnelled')).toBeUndefined()
  })

  it('records that a clear is owed before it clears anything', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await watching(r, [NYM])
    let owedWhenCleared: boolean | undefined
    const remove = r.nym.remove.bind(r.nym)
    r.nym.remove = async (url, name) => { owedWhenCleared ??= r.disk.current.owed; await remove(url, name) }
    await r.mirror.stop()
    expect(owedWhenCleared).toBe(true)
  })

  it('keeps the clear owed when a profile cannot be cleared, and a restart finishes it before anything else', async () => {
    const r = rig()
    r.main.seed(signIn())
    await watching(r)
    r.nym.failRemoves = true
    await r.mirror.stop()
    expect(r.direct.contents(), 'the other profile was cleared').toEqual([])
    expect(r.nym.get('sid'), 'this one was not').toBeDefined()
    expect(r.disk.current.owed).toBe(true)
    expect(r.disk.current.domains).toEqual({ [NYM]: ['example.com'], [DIRECT]: ['example.com'] })
    expect(r.mirror.status().failed).toBe(1)
    expect(r.logs.some((line) => line.includes('tunnel-profile'))).toBe(true)
    // The next run: the switch is on, so nothing starts, and the profiles are cleared at launch.
    r.nym.failRemoves = false
    const next = rig({ join: [], record: r.disk.current, stores: r })
    await next.mirror.settle()
    expect(next.nym.contents(), 'cleared at launch, in a session that has not joined').toEqual([])
    expect(next.disk.current).toEqual({ domains: {}, owed: false })
  })

  it('clears first when the switch is turned off again before an owed clear was done', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await watching(r, [NYM])
    r.nym.failRemoves = true
    await r.mirror.stop()
    r.nym.failRemoves = false
    await r.mirror.start(); await r.mirror.idle()
    expect(r.nym.contents(), 'what the profile held of the site was cleared, and the site starts again from nothing').toEqual([])
    expect(r.disk.current).toEqual({ domains: {}, owed: false })
    await visit(r)
    await r.mirror.idle()
    expect(r.nym.get('sid')).toBeDefined()
  })

  it('clears nothing when nothing was mirrored', async () => {
    const r = rig({ join: ['nym'] })
    r.nym.seed(signIn())
    await r.mirror.stop()
    await r.mirror.settle()
    expect(r.nym.contents()).toHaveLength(1)
    expect(r.disk.history).toEqual([])
  })

  it('ends up as the last call left it when it is switched back and forth, keeping the sites it had', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await watching(r, [NYM])
    const calls = [r.mirror.start(), r.mirror.stop(), r.mirror.start()]
    await Promise.all(calls); await r.mirror.idle()
    expect(r.mirror.status().state).toBe('mirroring')
    expect(r.nym.get('sid')).toBeDefined()
    expect(r.disk.current.domains).toEqual({ [NYM]: ['example.com'] })
    await r.mirror.stop()
    expect(r.mirror.status().state).toBe('separate')
    expect(r.nym.contents()).toEqual([])
  })

  it('counts a profile it could not clear and still clears the others', async () => {
    const r = rig()
    r.main.seed(signIn())
    await watching(r)
    r.nym.failRemoves = true
    await r.mirror.stop()
    expect(r.direct.contents()).toEqual([])
    expect(r.mirror.status().failed).toBe(1)
  })
})

describe('a restart with the switch off', () => {
  it('makes each profile equal to the default session for the recorded sites, and gives the default session nothing the profile alone holds', async () => {
    const first = rig({ join: ['nym'] })
    first.main.seed(signIn({ name: 'sid', value: 'in-default' }))
    await watching(first, [NYM])
    // The tunnelled tab signed in to something while the app was closing; the default session did not hear of it.
    first.nym.seed(signIn({ name: 'profile-only', value: 'p' }))
    first.nym.seed(signIn({ name: 'sid', value: 'stale' }))
    first.main.seed(signIn({ name: 'sid-removed-meanwhile', value: 'x' }))
    const second = rig({ join: ['nym'], record: first.disk.current, stores: first })
    await second.mirror.start(); await second.mirror.idle()
    expect(second.main.get('profile-only'), 'not copied into the default session').toBeUndefined()
    expect(second.main.get('sid')?.value).toBe('in-default')
    expect(second.nym.get('profile-only'), 'and gone from the profile').toBeUndefined()
    expect(second.nym.get('sid')?.value).toBe('in-default')
    expect(writes(second.main)).toBe(0)
    expect(second.nym.get('sid-removed-meanwhile')?.value, 'what the default holds reached the profile').toBe('x')
  })

  it('keeps following the recorded sites, and nothing else', async () => {
    const first = rig({ join: ['nym'] })
    await watching(first, [NYM])
    const second = rig({ join: ['nym'], record: first.disk.current, stores: first })
    await second.mirror.start(); await second.mirror.idle()
    second.main.siteSets(signIn({ value: 'now' }))
    second.main.siteSets(signIn({ name: 'uid', domain: 'tracker.test' }))
    await second.mirror.idle()
    expect(second.nym.get('sid')?.value).toBe('now')
    expect(second.nym.get('uid')).toBeUndefined()
  })
})

describe('forgetting the sites when history is cleared', () => {
  it('empties the list of sites on disk, clears the profiles\' copies, keeps the default session\'s cookies, and carries nothing to the default session', async () => {
    const r = rig()
    r.main.seed(signIn({ name: 'sid', value: 'normal' }))
    r.main.seed(signIn({ name: 'other', domain: 'other.test' }))
    await watching(r)
    r.nym.siteSets(signIn({ name: 'unrelated', domain: 'elsewhere.test' }))
    await r.mirror.idle()
    await r.mirror.forget()
    expect(r.disk.current, 'no site is listed and nothing is owed').toEqual({ domains: {}, owed: false })
    expect(r.nym.get('sid'), 'the copy in the profile is gone').toBeUndefined()
    expect(r.direct.get('sid')).toBeUndefined()
    expect(r.nym.get('unrelated'), 'a cookie of a site that was never mirrored stays').toBeDefined()
    expect(r.main.get('sid')?.value, 'normal browsing keeps its own').toBe('normal')
    await r.mirror.idle()
    expect(r.main.get('sid')?.value).toBe('normal')
    expect(r.main.get('unrelated'), 'the clear is not a sign-out that reaches normal browsing').toBeUndefined()
  })

  it('goes on mirroring afterwards: a site is added again by the next load that may add it, and a site no longer listed is not followed', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn({ name: 'sid', value: 'normal' }))
    await watching(r, [NYM])
    await r.mirror.forget()
    r.main.siteSets(signIn({ name: 'sid', value: 'changed' }))
    await r.mirror.idle()
    expect(r.nym.get('sid'), 'no longer followed').toBeUndefined()
    expect(r.mirror.status().state).toBe('mirroring')
    await visit(r)
    await r.mirror.idle()
    expect(r.nym.get('sid')?.value).toBe('changed')
    expect(r.disk.current.domains).toEqual({ [NYM]: ['example.com'] })
  })

  it('keeps the list and says a clear is owed when a profile cannot be cleared, and finishes at the next start', async () => {
    const r = rig({ join: ['nym'] })
    r.main.seed(signIn())
    await watching(r, [NYM])
    r.nym.failRemoves = true
    await r.mirror.forget()
    expect(r.disk.current).toEqual({ domains: { [NYM]: ['example.com'] }, owed: true })
    r.nym.failRemoves = false
    const next = rig({ join: ['nym'], record: r.disk.current, stores: r })
    await next.mirror.start(); await next.mirror.idle()
    expect(next.nym.contents()).toEqual([])
    expect(next.disk.current).toEqual({ domains: {}, owed: false })
  })

  it('empties the list while the mirror is off too, and does nothing when it holds nothing', async () => {
    const r = rig({ join: ['nym'], record: { domains: { [NYM]: ['example.com'] }, owed: false } })
    r.nym.seed(signIn())
    await r.mirror.forget()
    expect(r.disk.current).toEqual({ domains: {}, owed: false })
    expect(r.nym.contents(), 'and the copies the record named').toEqual([])
    const empty = rig({ join: ['nym'] })
    await empty.mirror.forget()
    expect(empty.disk.history).toEqual([])
  })
})

describe('what it says of itself', () => {
  it('counts sessions and writes, and never a name, a value or a site', async () => {
    const r = rig()
    r.main.seed(signIn({ name: 'secret-name', value: 'secret-value', domain: 'secret.test' }))
    expect(r.mirror.status()).toEqual({ state: 'separate', sessions: 0, copied: 0, removed: 0, failed: 0, suppressed: 0 })
    await r.mirror.start()
    await visit(r, NYM, 'https://secret.test/')
    await r.mirror.idle()
    expect(r.mirror.status()).toEqual({ state: 'mirroring', sessions: 2, copied: 1, removed: 0, failed: 0, suppressed: 0 })
    expect(JSON.stringify(r.mirror.status()) + r.logs.join('\n') + JSON.stringify(r.disk.current.owed)).not.toMatch(/secret/)
  })

  it('counts no sessions while the profiles are apart', async () => {
    const r = rig()
    expect(r.mirror.status()).toMatchObject({ state: 'separate', sessions: 0 })
    await r.mirror.start()
    expect(r.mirror.status()).toMatchObject({ state: 'mirroring', sessions: 2 })
    await r.mirror.stop()
    expect(r.mirror.status()).toMatchObject({ state: 'separate', sessions: 0 })
  })
})
