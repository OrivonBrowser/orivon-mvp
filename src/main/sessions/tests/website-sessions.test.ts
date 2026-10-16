import { beforeEach, describe, expect, it, vi } from 'vitest'

const defaultSession = { name: 'default' }
vi.mock('electron', () => ({ session: { defaultSession } }))

let sessions: typeof import('../website-sessions.js')
beforeEach(async () => {
  vi.resetModules()
  sessions = await import('../website-sessions.js')
})

const site = (name: string): import('electron').Session => ({ name }) as unknown as import('electron').Session

describe('the sessions a website runs in', () => {
  it('installs on the default session at once', () => {
    const install = vi.fn()
    sessions.forEachWebsiteSession(install)
    expect(install.mock.calls).toEqual([[defaultSession, undefined]])
  })

  it('installs on a website session announced afterwards, and on one announced before', () => {
    const early = site('early')
    sessions.announceWebsiteSession(early)
    const install = vi.fn()
    sessions.forEachWebsiteSession(install)
    const late = site('late')
    sessions.announceWebsiteSession(late)
    expect(install.mock.calls.map(([target]) => (target as { name: string }).name)).toEqual(['default', 'early', 'late'])
  })

  it('tells an installer which tunnel a session is the profile of, whether it was announced before the installer or after', () => {
    const profile = site('tunnel-profile')
    sessions.announceWebsiteSession(profile, 'nym')
    const install = vi.fn()
    sessions.forEachWebsiteSession(install)
    sessions.announceWebsiteSession(site('other'))
    sessions.announceWebsiteSession(site('another-profile-session'), 'socks5')
    expect(install.mock.calls.map(([target, tunnel]) => [(target as { name: string }).name, tunnel])).toEqual([['default', undefined], ['tunnel-profile', 'nym'], ['other', undefined], ['another-profile-session', 'socks5']])
  })

  it('installs once on a session however many times it is announced', () => {
    const install = vi.fn()
    sessions.forEachWebsiteSession(install)
    const one = site('one')
    sessions.announceWebsiteSession(one)
    sessions.announceWebsiteSession(one)
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('runs every installer when one throws, and then throws, so the session is refused', () => {
    const first = vi.fn(() => { throw new Error('first broke') })
    const second = vi.fn()
    sessions.forEachWebsiteSession((target) => { if (target !== defaultSession as never) first() })
    sessions.forEachWebsiteSession((target) => { if (target !== defaultSession as never) second() })
    expect(() => { sessions.announceWebsiteSession(site('one')) }).toThrow(/could not be fitted/)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps refusing a session an installer failed on, without running the installers on it again', () => {
    const install = vi.fn((target: unknown) => { if (target !== defaultSession) throw new Error('broke') })
    sessions.forEachWebsiteSession(install as never)
    const one = site('one')
    expect(() => { sessions.announceWebsiteSession(one) }).toThrow(/could not be fitted/)
    expect(() => { sessions.announceWebsiteSession(one) }).toThrow(/could not be fitted/)
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('lists the default session and every website session announced', () => {
    const one = site('one')
    sessions.announceWebsiteSession(one)
    expect(sessions.websiteSessions()).toEqual([defaultSession, one])
  })
})
