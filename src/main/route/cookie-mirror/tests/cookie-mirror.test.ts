import { describe, expect, it } from 'vitest'
import { createCookieMirror } from '../cookie-mirror.js'
import { FakeCookieStore, signIn } from './fake-cookie-store.test-helpers.js'

const NOW_MS = 1_800_000_000_000

interface Rig { readonly main: FakeCookieStore, readonly nym: FakeCookieStore, readonly direct: FakeCookieStore, readonly mirror: ReturnType<typeof createCookieMirror>, readonly logs: string[] }

function rig (join: Array<'nym' | 'direct'> = ['nym', 'direct']): Rig {
  const main = new FakeCookieStore('default')
  const nym = new FakeCookieStore('tunnel-profile')
  const direct = new FakeCookieStore('direct-profile')
  const logs: string[] = []
  const mirror = createCookieMirror({ main: { label: 'default', store: main }, now: () => NOW_MS, log: (line) => { logs.push(line) } })
  if (join.includes('nym')) mirror.join({ label: 'tunnel-profile', store: nym })
  if (join.includes('direct')) mirror.join({ label: 'direct-profile', store: direct })
  return { main, nym, direct, mirror, logs }
}

const writes = (store: FakeCookieStore): number => store.writes.length

describe('turning the mirror on', () => {
  it('copies the default session\'s cookies into the profiles, default winning on the same name, domain and path, and gives the default what only a profile has', async () => {
    const { main, nym, direct, mirror } = rig()
    main.seed(signIn({ name: 'sid', value: 'default-sid' })); main.seed(signIn({ name: 'only-default', value: 'd' }))
    nym.seed(signIn({ name: 'sid', value: 'nym-sid' })); nym.seed(signIn({ name: 'only-nym', value: 'n', domain: 'tunnel.test' }))
    direct.seed(signIn({ name: 'only-direct', value: 'x', domain: 'direct.test' }))
    await mirror.start()
    await mirror.idle()
    for (const store of [main, nym, direct]) {
      expect(store.get('sid')?.value, `${store.label} holds the default's sid`).toBe('default-sid')
      expect(store.get('only-default')?.value).toBe('d')
      expect(store.get('only-nym')?.value).toBe('n')
      expect(store.get('only-direct')?.value).toBe('x')
    }
  })

  it('writes nothing when every store already holds the same cookies', async () => {
    const { main, nym, direct, mirror } = rig()
    for (const store of [main, nym, direct]) store.seed(signIn())
    await mirror.start()
    await mirror.idle()
    expect([main, nym, direct].map(writes)).toEqual([0, 0, 0])
  })

  it('keeps host-only cookies host-only, domain cookies on their domain, and session cookies session cookies', async () => {
    const { main, nym, mirror } = rig(['nym'])
    const { expirationDate: _gone, ...rest } = signIn({ name: 'temp', value: 't' })
    main.seed(signIn({ name: 'host', value: 'h', expirationDate: 4_100_000_000, sameSite: 'strict' }))
    main.seed(signIn({ name: 'wide', value: 'w', domain: '.example.com', hostOnly: false, path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' }))
    main.seed({ ...rest, session: true })
    await mirror.start()
    await mirror.idle()
    expect(nym.get('host')).toMatchObject({ domain: 'example.com', hostOnly: true, secure: true, httpOnly: true, sameSite: 'strict', session: false, expirationDate: 4_100_000_000 })
    expect(nym.get('wide')).toMatchObject({ domain: '.example.com', hostOnly: false, path: '/app', secure: false, httpOnly: false, sameSite: 'no_restriction' })
    expect(nym.get('temp')).toMatchObject({ session: true })
    expect(nym.get('temp')?.expirationDate).toBeUndefined()
  })

  it('does not carry a cookie that has already expired', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn({ name: 'old', expirationDate: NOW_MS / 1000 - 5 }))
    await mirror.start()
    await mirror.idle()
    expect(nym.get('old')).toBeUndefined()
  })

  it('does nothing before it is started, and starting twice changes nothing', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn())
    await mirror.idle()
    expect(nym.list()).toEqual([])
    expect(nym.listening).toBe(0)
    await mirror.start(); await mirror.start()
    await mirror.idle()
    expect(nym.list()).toHaveLength(1)
    expect(nym.listening).toBe(1)
  })
})

describe('following the sessions', () => {
  it('carries a cookie a site sets in a profile to the default and the other profiles, and writes each place once: it does not echo', async () => {
    const { main, nym, direct, mirror } = rig()
    await mirror.start(); await mirror.idle()
    nym.siteSets(signIn({ value: 'fresh' }))
    await mirror.idle()
    expect(main.get('sid')?.value).toBe('fresh')
    expect(direct.get('sid')?.value).toBe('fresh')
    expect([writes(main), writes(nym), writes(direct)]).toEqual([1, 0, 1])
    await mirror.idle()
    expect([writes(main), writes(nym), writes(direct)]).toEqual([1, 0, 1])
  })

  it('carries a cookie a site sets in the default session to every profile', async () => {
    const { main, nym, direct, mirror } = rig()
    await mirror.start(); await mirror.idle()
    main.siteSets(signIn({ value: 'in-default' }))
    await mirror.idle()
    expect(nym.get('sid')?.value).toBe('in-default')
    expect(direct.get('sid')?.value).toBe('in-default')
    expect([writes(main), writes(nym), writes(direct)]).toEqual([0, 1, 1])
  })

  it('follows a changed value as a change and not as a removal', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn({ value: 'one' }))
    await mirror.start(); await mirror.idle()
    main.siteSets(signIn({ value: 'two' }))
    await mirror.idle()
    expect(nym.get('sid')?.value).toBe('two')
    expect(nym.writes.filter((write) => write.kind === 'remove')).toEqual([])
  })

  it('signs out everywhere when a site deletes the cookie by sending it already expired, in either direction', async () => {
    const { main, nym, direct, mirror } = rig()
    main.seed(signIn())
    await mirror.start(); await mirror.idle()
    expect(direct.get('sid')).toBeDefined()
    nym.siteExpires('sid', 'example.com')
    await mirror.idle()
    expect([main.get('sid'), nym.get('sid'), direct.get('sid')]).toEqual([undefined, undefined, undefined])
    main.siteSets(signIn({ value: 'again' })); await mirror.idle()
    main.siteExpires('sid', 'example.com'); await mirror.idle()
    expect([nym.get('sid'), direct.get('sid')]).toEqual([undefined, undefined])
  })

  it('leaves a cookie in the other sessions when one session lets it lapse or evicts it', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn({ name: 'ran-out' })); main.seed(signIn({ name: 'evicted' }))
    await mirror.start(); await mirror.idle()
    main.lapses('ran-out', 'example.com', 'expired'); main.lapses('evicted', 'example.com', 'evicted')
    await mirror.idle()
    expect(nym.get('ran-out')).toBeDefined()
    expect(nym.get('evicted')).toBeDefined()
  })

  it('puts back a cookie of the same name that a removal took with it', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn({ name: 'sid', value: 'host-only' }))
    main.seed(signIn({ name: 'sid', value: 'wide', domain: '.example.com', hostOnly: false }))
    await mirror.start(); await mirror.idle()
    // The removal by address and name takes both of the host's cookies of that name in the default session, as Chromium's does.
    nym.siteExpires('sid', 'example.com')
    await mirror.idle()
    expect(main.get('sid', '.example.com')?.value, 'the domain cookie the removal swept up was put back').toBe('wide')
    expect(nym.get('sid', '.example.com')?.value).toBe('wide')
    expect(main.get('sid', 'example.com')).toBeUndefined()
    expect(nym.get('sid', 'example.com')).toBeUndefined()
  })

  it('does not put back a cookie of that name which the removal would not have sent, over a value that changed meanwhile', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn({ name: 'sid', value: 'old', domain: 'other.test' }))
    nym.seed(signIn({ name: 'sid', value: 'old', domain: 'other.test' }))
    main.seed(signIn({ name: 'sid', value: 'one' }))
    nym.seed(signIn({ name: 'sid', value: 'one' }))
    await mirror.start(); await mirror.idle()
    nym.siteExpires('sid', 'example.com')
    main.siteSets(signIn({ name: 'sid', value: 'newer', domain: 'other.test' }))
    await mirror.idle()
    expect(main.get('sid', 'other.test')?.value).toBe('newer')
    expect(nym.get('sid', 'other.test')?.value, 'the newer value reached the profile, not overwritten by the older one').toBe('newer')
    expect(main.get('sid', 'example.com')).toBeUndefined()
  })

  it('leaves alone cookies that share a name, domain and path, which only partitioned cookies do, and says so once without naming one', async () => {
    const { main, nym, mirror, logs } = rig(['nym'])
    main.seed(signIn({ name: 'embed', value: 'under-site-a', domain: 'widget.test', sameSite: 'no_restriction' }))
    main.shadow(signIn({ name: 'embed', value: 'under-site-b', domain: 'widget.test', sameSite: 'no_restriction' }))
    main.seed(signIn({ name: 'plain', value: 'kept' }))
    nym.seed(signIn({ name: 'tunnelled-embed', value: 'x', domain: 'widget.test' }))
    nym.shadow(signIn({ name: 'tunnelled-embed', value: 'y', domain: 'widget.test' }))
    await mirror.start(); await mirror.idle()
    expect(nym.get('embed'), 'not copied into the profile').toBeUndefined()
    expect(main.get('tunnelled-embed'), 'not copied into the default session').toBeUndefined()
    expect(nym.get('plain')?.value).toBe('kept')
    main.siteSets(signIn({ name: 'embed', value: 'changed', domain: 'widget.test', sameSite: 'no_restriction' }))
    await mirror.idle()
    expect(nym.get('embed')).toBeUndefined()
    expect(logs.filter((line) => line.includes('share a name')).length).toBe(1)
    expect(logs.join('\n')).not.toContain('embed')
  })

  it('says why a clearing failed even after an earlier write already failed on that session', async () => {
    const { main, nym, mirror, logs } = rig(['nym'])
    await mirror.start(); await mirror.idle()
    nym.failNextSet = 'invalid cookie'
    main.siteSets(signIn({ name: 'first-cookie' })); await mirror.idle()
    nym.failNextClear = true
    await mirror.stop()
    expect(logs.filter((line) => line.includes('could not be cleared')).length).toBe(1)
  })

  it('reports a write that failed, names no cookie, and carries on with the next one', async () => {
    const { main, nym, mirror, logs } = rig(['nym'])
    await mirror.start(); await mirror.idle()
    nym.failNextSet = 'invalid cookie'
    main.siteSets(signIn({ name: 'first-cookie' })); await mirror.idle()
    main.siteSets(signIn({ name: 'second-cookie' })); await mirror.idle()
    expect(nym.get('first-cookie')).toBeUndefined()
    expect(nym.get('second-cookie')).toBeDefined()
    expect(mirror.status().failed).toBe(1)
    expect(logs.join('\n')).not.toContain('first-cookie')
  })

  it('stops after a bounded number of writes when two stores keep changing what they are given', async () => {
    const { main, nym, mirror, logs } = rig(['nym'])
    await mirror.start(); await mirror.idle()
    nym.corrupts = true
    main.corrupts = true
    main.siteSets(signIn({ value: 'a' }))
    await mirror.idle()
    expect(writes(nym)).toBeLessThanOrEqual(35)
    expect(writes(main)).toBeLessThanOrEqual(35)
    expect(mirror.status().suppressed).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes('keeps changing'))).toBe(true)
  })
})

describe('a session that joins after the mirror started', () => {
  it('takes the default\'s cookies, the default winning, and gives the default and the others what only it holds', async () => {
    const { main, nym, direct, mirror } = rig(['nym'])
    main.seed(signIn({ name: 'sid', value: 'default-sid' }))
    await mirror.start(); await mirror.idle()
    direct.seed(signIn({ name: 'sid', value: 'direct-sid' })); direct.seed(signIn({ name: 'late', value: 'l', domain: 'late.test' }))
    mirror.join({ label: 'direct-profile', store: direct })
    await mirror.idle()
    expect(direct.get('sid')?.value).toBe('default-sid')
    expect(main.get('late')?.value).toBe('l')
    expect(nym.get('late')?.value).toBe('l')
    expect(direct.listening).toBe(1)
  })

  it('resolves its join once it holds what the default session does, so a request can wait for that', async () => {
    const { main, direct, mirror } = rig(['nym'])
    main.seed(signIn({ value: 'default-sid' }))
    await mirror.start(); await mirror.idle()
    await mirror.join({ label: 'direct-profile', store: direct })
    expect(direct.get('sid')?.value).toBe('default-sid')
  })

  it('resolves a join made while the mirror is off at once, and one made as it starts when the first merge is done', async () => {
    const { main, nym, direct, mirror } = rig(['nym'])
    main.seed(signIn({ value: 'default-sid' }))
    await mirror.join({ label: 'direct-profile', store: direct })
    expect(direct.list()).toEqual([])
    void mirror.start()
    await mirror.join({ label: 'late', store: new FakeCookieStore('late') })
    expect(nym.get('sid')?.value).toBe('default-sid')
  })

  it('is followed from then on', async () => {
    const { main, direct, mirror } = rig(['nym'])
    await mirror.start(); await mirror.idle()
    mirror.join({ label: 'direct-profile', store: direct }); await mirror.idle()
    main.siteSets(signIn({ value: 'after' })); await mirror.idle()
    expect(direct.get('sid')?.value).toBe('after')
  })

  it('is left alone while the mirror is off, and joined when it starts', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn())
    await mirror.idle()
    expect(nym.list()).toEqual([])
    await mirror.start(); await mirror.idle()
    expect(nym.list()).toHaveLength(1)
  })

  it('is joined once for a session announced again with a store of its own', async () => {
    const { mirror } = rig(['nym'])
    mirror.join({ label: 'tunnel-profile', store: new FakeCookieStore('same session, new handle') })
    expect(mirror.status().sessions).toBe(1)
  })

  it('is joined once however often it is announced', async () => {
    const { nym, mirror } = rig(['nym'])
    mirror.join({ label: 'tunnel-profile', store: nym })
    await mirror.start(); await mirror.idle()
    expect(nym.listening).toBe(1)
    expect(mirror.status().sessions).toBe(1)
  })
})

describe('turning the mirror off again', () => {
  it('clears the profiles\' cookies, leaves the default\'s, and stops following', async () => {
    const { main, nym, direct, mirror } = rig()
    main.seed(signIn())
    await mirror.start(); await mirror.idle()
    expect(nym.list()).toHaveLength(1)
    await mirror.stop()
    expect(nym.list()).toEqual([])
    expect(direct.list()).toEqual([])
    expect(main.list()).toHaveLength(1)
    expect([main.listening, nym.listening, direct.listening]).toEqual([0, 0, 0])
    main.siteSets(signIn({ name: 'later' })); nym.siteSets(signIn({ name: 'tunnelled' }))
    await mirror.idle()
    expect(nym.get('later')).toBeUndefined()
    expect(main.get('tunnelled')).toBeUndefined()
  })

  it('does not let the clearing reach the default', async () => {
    const { main, mirror } = rig()
    main.seed(signIn())
    await mirror.start(); await mirror.idle()
    await mirror.stop(); await mirror.idle()
    expect(main.get('sid')).toBeDefined()
    expect(writes(main)).toBe(0)
  })

  it('clears nothing when it was never started', async () => {
    const { nym, mirror } = rig(['nym'])
    nym.seed(signIn())
    await mirror.stop()
    expect(nym.list()).toHaveLength(1)
  })

  it('ends up as the last call left it when it is switched back and forth', async () => {
    const { main, nym, mirror } = rig(['nym'])
    main.seed(signIn())
    const calls = [mirror.start(), mirror.stop(), mirror.start()]
    await Promise.all(calls); await mirror.idle()
    expect(mirror.status().state).toBe('mirroring')
    expect(nym.get('sid')).toBeDefined()
    await mirror.stop()
    expect(mirror.status().state).toBe('separate')
    expect(nym.list()).toEqual([])
  })

  it('can be started again, and merges what the profiles then hold', async () => {
    const { main, nym, mirror } = rig(['nym'])
    await mirror.start(); await mirror.stop()
    nym.seed(signIn({ name: 'tunnelled' }))
    main.seed(signIn({ name: 'normal' }))
    await mirror.start(); await mirror.idle()
    expect(main.get('tunnelled')).toBeDefined()
    expect(nym.get('normal')).toBeDefined()
  })

  it('counts a profile it could not clear and still clears the others', async () => {
    const { main, nym, direct, mirror, logs } = rig()
    main.seed(signIn())
    await mirror.start(); await mirror.idle()
    nym.clear = async () => { throw new Error('busy') }
    await mirror.stop()
    expect(direct.list()).toEqual([])
    expect(mirror.status().failed).toBe(1)
    expect(logs.some((line) => line.includes('tunnel-profile'))).toBe(true)
  })
})

describe('what it says of itself', () => {
  it('counts sessions and writes, and never a name, a value or a site', async () => {
    const { main, mirror, logs } = rig()
    main.seed(signIn({ name: 'secret-name', value: 'secret-value', domain: 'secret.test' }))
    expect(mirror.status()).toEqual({ state: 'separate', sessions: 2, copied: 0, removed: 0, failed: 0, suppressed: 0 })
    await mirror.start(); await mirror.idle()
    expect(mirror.status()).toEqual({ state: 'mirroring', sessions: 2, copied: 2, removed: 0, failed: 0, suppressed: 0 })
    expect(JSON.stringify(mirror.status()) + logs.join('\n')).not.toMatch(/secret/)
  })
})
