import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { claimTabSession } from '../install-spellcheck.js'
import { SpellcheckSessions } from '../spellcheck.js'

const session = (): { setSpellCheckerEnabled: Mock<(enabled: boolean) => void> } => ({ setSpellCheckerEnabled: vi.fn<(enabled: boolean) => void>() })

describe('SpellcheckSessions', () => {
  it('puts a session it is given in line with the setting at once', () => {
    const sessions = new SpellcheckSessions(() => false)
    const s = session()
    sessions.track(s)
    expect(s.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
  })

  it('switches every tracked session when the setting changes', () => {
    let on = true
    const sessions = new SpellcheckSessions(() => on)
    const a = session()
    const b = session()
    sessions.track(a)
    sessions.track(b)
    on = false
    sessions.refresh()
    expect(a.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false)
    expect(b.setSpellCheckerEnabled).toHaveBeenLastCalledWith(false)
  })

  it('tracks a session once', () => {
    const sessions = new SpellcheckSessions(() => true)
    const s = session()
    sessions.track(s)
    sessions.track(s)
    expect(s.setSpellCheckerEnabled).toHaveBeenCalledTimes(1)
  })

  it('leaves a session it never tracked alone (the shell\'s, an embed\'s, a child\'s)', () => {
    let on = true
    const sessions = new SpellcheckSessions(() => on)
    sessions.track(session())
    const untouched = session()
    on = false
    sessions.refresh()
    expect(untouched.setSpellCheckerEnabled).not.toHaveBeenCalled()
  })
})

describe('claimTabSession', () => {
  function contents (): EventEmitter & { session: ReturnType<typeof session>, isDestroyed: () => boolean } {
    return Object.assign(new EventEmitter(), { session: session(), isDestroyed: () => false })
  }

  it('claims the session at the first load event once the contents is a tab', () => {
    const sessions = new SpellcheckSessions(() => false)
    const wc = contents()
    let isTab = false
    claimTabSession(wc as never, () => isTab, sessions)
    wc.emit('did-start-loading')
    expect(wc.session.setSpellCheckerEnabled).not.toHaveBeenCalled()
    isTab = true
    wc.emit('dom-ready')
    expect(wc.session.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(wc.listenerCount('did-finish-load')).toBe(0)
  })

  it('never claims the session of a contents that is not a tab', () => {
    const wc = contents()
    claimTabSession(wc as never, () => false, new SpellcheckSessions(() => true))
    wc.emit('did-finish-load')
    expect(wc.session.setSpellCheckerEnabled).not.toHaveBeenCalled()
  })
})
