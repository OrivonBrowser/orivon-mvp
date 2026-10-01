import { describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import type { PasswordVault } from '../../passwords/vault.js'
import { AuthChallenges } from '../auth-queue.js'
import type { AuthServer } from '../auth-queue.js'
import { authSheetOverlayFor, MAX_FIELD } from '../auth-sheet-overlay.js'
import type { AuthView } from '../auth-text.js'

const SERVER: AuthServer = { scheme: 'http', host: '127.0.0.1', port: 8080, isProxy: false, realm: 'Staging' }

interface Login { id: string, origin: string, username: string, created: number, used: number }

function setup (over: { vault?: 'ready' | 'unavailable' | 'private', logins?: Login[], autofill?: boolean, offerToSave?: boolean, active?: string } = {}): {
  handler: OverlayHandler
  challenges: AuthChallenges
  window: object
  close: ReturnType<typeof vi.fn>
  submitted: ReturnType<typeof vi.fn>
  answers: unknown[]
  add: (patch?: { mismatch?: boolean, first?: boolean, server?: AuthServer, tabId?: string }) => string
  state: { active: string }
} {
  let n = 0
  const challenges = new AuthChallenges({ schedule: () => () => undefined, newId: () => `c${String(++n)}` })
  const state = { active: over.active ?? 't1' }
  const window = { tabs: { getState: () => ({ activeTabId: state.active }) } }
  const close = vi.fn()
  const submitted = vi.fn()
  const logins = over.logins ?? []
  const vault = {
    state: () => over.vault ?? 'ready',
    list: (origin?: string) => logins.filter((login) => origin === undefined || login.origin === origin),
    reveal: vi.fn(async (id: string) => id === 'l1' ? 'saved-secret' : undefined)
  } as unknown as PasswordVault
  const services = { passwords: vault, settings: { get: (key: string) => key === 'passwords.autofill' ? over.autofill ?? true : key === 'passwords.offerToSave' ? over.offerToSave ?? true : undefined } }
  const def = authSheetOverlayFor({ challenges, submitted })
  const handler = def.attach({ window, services, send: vi.fn(), close } as unknown as OverlayWindow)
  const answers: unknown[] = []
  const add = (patch: { mismatch?: boolean, first?: boolean, server?: AuthServer, tabId?: string } = {}): string => {
    const challenge = challenges.add({
      owner: window, tabId: patch.tabId ?? 't1', load: 1, server: patch.server ?? SERVER, first: patch.first ?? true, insecure: true, mismatch: patch.mismatch ?? false
    }, (answer) => { answers.push(answer) }, () => undefined)
    return challenge?.id as string
  }
  return { handler, challenges, window, close, submitted, answers, add, state }
}

describe('the sign-in overlay', () => {
  it('is a centred sheet that a tab switch hides and a click elsewhere does not', () => {
    const def = authSheetOverlayFor({ challenges: new AuthChallenges({ schedule: () => () => undefined, newId: () => 'x' }), submitted: vi.fn() })
    expect(def).toMatchObject({ name: 'auth-sheet', placement: { kind: 'area', at: 'center', width: 400 }, focus: 'take', layer: 'bar', keep: 'fresh' })
    expect(def.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: true, layout: false })
  })

  it('tells the page what to draw from the server that asked', () => {
    const s = setup()
    const view = s.handler.show?.({ id: s.add() }) as AuthView
    expect(view).toMatchObject({
      id: 'c1', title: 'Sign in', origin: 'http://127.0.0.1:8080', realm: 'Staging', retry: false, username: '', saved: null,
      insecure: 'Your password will be sent without encryption.', mismatch: null, canRemember: true
    })
  })

  it('shows the mismatch, the retry and the kept username', () => {
    const s = setup()
    const first = s.add()
    s.challenges.answer(first, { username: 'alice', password: 'x' })
    const view = s.handler.show?.({ id: s.add({ first: false, mismatch: true }) }) as AuthView
    expect(view.retry).toBe(true)
    expect(view.username).toBe('alice')
    expect(view.mismatch).toBe('This request comes from 127.0.0.1:8080, not from the page you are on.')
  })

  it('shows nothing for an id it does not know, another window\'s, or a tab that is not in front', () => {
    const s = setup()
    const id = s.add()
    expect(s.handler.show?.({ id: 'nope' })).toBeUndefined()
    expect(s.handler.show?.(undefined)).toBeUndefined()
    expect(s.handler.show?.({ id: 7 })).toBeUndefined()
    s.state.active = 't9'
    expect(s.handler.show?.({ id })).toBeUndefined()
  })

  it('offers a saved login for the server\'s own origin only, and never hands over its password', () => {
    const s = setup({ logins: [
      { id: 'l0', origin: 'http://127.0.0.1:8080', username: 'old', created: 1, used: 5 },
      { id: 'l1', origin: 'http://127.0.0.1:8080', username: 'alice', created: 2, used: 9 }
    ] })
    const view = s.handler.show?.({ id: s.add() }) as AuthView
    expect(view.saved).toBe('alice')
    expect(view.username).toBe('alice')
    expect(JSON.stringify(view)).not.toContain('saved-secret')
  })

  it('offers no saved login to a part of a page, a retry, a setting turned off or a vault that cannot keep one', () => {
    const logins = [{ id: 'l1', origin: 'http://127.0.0.1:8080', username: 'alice', created: 1, used: 1 }]
    const mismatch = setup({ logins })
    expect((mismatch.handler.show?.({ id: mismatch.add({ mismatch: true }) }) as AuthView).saved).toBeNull()
    const retry = setup({ logins })
    expect((retry.handler.show?.({ id: retry.add({ first: false }) }) as AuthView).saved).toBeNull()
    const off = setup({ logins, autofill: false })
    expect((off.handler.show?.({ id: off.add() }) as AuthView).saved).toBeNull()
    const priv = setup({ logins, vault: 'private' })
    const view = priv.handler.show?.({ id: priv.add() }) as AuthView
    expect(view).toMatchObject({ saved: null, canRemember: false })
  })

  it('offers no remember box for a proxy', () => {
    const s = setup()
    const view = s.handler.show?.({ id: s.add({ server: { ...SERVER, isProxy: true } }) }) as AuthView
    expect(view.canRemember).toBe(false)
  })

  it('passes a submitted answer to the challenge and closes', async () => {
    const s = setup()
    const id = s.add()
    s.handler.show?.({ id })
    await s.handler.request({ type: 'submit', id, username: 'u', password: 'p' })
    expect(s.answers).toEqual([{ username: 'u', password: 'p' }])
    expect(s.close).toHaveBeenCalledOnce()
    expect(s.submitted).not.toHaveBeenCalled()
  })

  it('cancels on request', async () => {
    const s = setup()
    const id = s.add()
    s.handler.show?.({ id })
    await s.handler.request({ type: 'cancel', id })
    expect(s.answers).toEqual([null])
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('ignores a stale id, an id that is not on screen, and a tab that is not in front', async () => {
    const s = setup()
    const id = s.add()
    const other = s.add({ server: { ...SERVER, realm: 'B' } })
    s.handler.show?.({ id })
    await s.handler.request({ type: 'submit', id: other, username: 'u', password: 'p' })
    await s.handler.request({ type: 'submit', id: 'old', username: 'u', password: 'p' })
    s.state.active = 't2'
    await s.handler.request({ type: 'submit', id, username: 'u', password: 'p' })
    expect(s.answers).toEqual([])
    expect(s.close).not.toHaveBeenCalled()
  })

  it('refuses oversize strings, wrong types, extra fields and empty answers', async () => {
    const s = setup()
    const id = s.add()
    s.handler.show?.({ id })
    const big = 'x'.repeat(MAX_FIELD + 1)
    for (const bad of [
      undefined, null, 'submit', { type: 'submit' }, { type: 'submit', id, username: big, password: 'p' }, { type: 'submit', id, username: 'u', password: big },
      { type: 'submit', id, username: 1, password: 'p' }, { type: 'submit', id, username: 'u', password: 'p', extra: 1 },
      { type: 'submit', id, username: 'u', password: 'p', remember: 'yes' }, { type: 'submit', id, username: '', password: '' },
      { type: 'cancel', id, username: 'u' }, { type: 'open', id }
    ]) await s.handler.request(bad)
    expect(s.answers).toEqual([])
    expect(s.close).not.toHaveBeenCalled()
    await s.handler.request({ type: 'submit', id, username: 'u', password: 'x'.repeat(MAX_FIELD) })
    expect(s.answers).toHaveLength(1)
  })

  it('answers with the saved password when the username is the saved one and the password box is empty', async () => {
    const s = setup({ logins: [{ id: 'l1', origin: 'http://127.0.0.1:8080', username: 'alice', created: 1, used: 1 }] })
    const id = s.add()
    s.handler.show?.({ id })
    await s.handler.request({ type: 'submit', id, username: 'bob', password: '', useSaved: true })
    expect(s.answers).toEqual([])
    await s.handler.request({ type: 'submit', id, username: 'alice', password: '', useSaved: true })
    expect(s.answers).toEqual([{ username: 'alice', password: 'saved-secret' }])
  })

  it('keeps a typed password over the saved one', async () => {
    const s = setup({ logins: [{ id: 'l1', origin: 'http://127.0.0.1:8080', username: 'alice', created: 1, used: 1 }] })
    const id = s.add()
    s.handler.show?.({ id })
    await s.handler.request({ type: 'submit', id, username: 'alice', password: 'typed', useSaved: true })
    expect(s.answers).toEqual([{ username: 'alice', password: 'typed' }])
  })

  it('remembers only when asked and only where a vault can keep it', async () => {
    const s = setup()
    const id = s.add()
    s.handler.show?.({ id })
    await s.handler.request({ type: 'submit', id, username: 'u', password: 'p', remember: true })
    expect(s.submitted).toHaveBeenCalledWith(s.window, expect.anything(), 't1')
    expect(s.challenges.takeRemember(s.window, 't1')).toEqual({ origin: 'http://127.0.0.1:8080', username: 'u', password: 'p' })

    const priv = setup({ vault: 'private' })
    const privId = priv.add()
    priv.handler.show?.({ id: privId })
    await priv.handler.request({ type: 'submit', id: privId, username: 'u', password: 'p', remember: true })
    expect(priv.submitted).not.toHaveBeenCalled()
    expect(priv.challenges.takeRemember(priv.window, 't1')).toBeUndefined()
  })

  it('offers and keeps nothing when the person turned the offer to save passwords off', async () => {
    const s = setup({ offerToSave: false })
    const id = s.add()
    expect((s.handler.show?.({ id }) as AuthView).canRemember).toBe(false)
    await s.handler.request({ type: 'submit', id, username: 'u', password: 'p', remember: true })
    expect(s.submitted).not.toHaveBeenCalled()
    expect(s.challenges.takeRemember(s.window, 't1')).toBeUndefined()
  })

  it('starts the clock again when its tab goes to the background, and cancels nothing itself', () => {
    const s = setup()
    const id = s.add()
    s.handler.show?.({ id })
    s.handler.closed?.('tab-switch')
    expect(s.answers).toEqual([])
    expect(s.challenges.get(id)).toBeDefined()
  })
})
