import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { SlotAsk, SlotCloseReason } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { FormCommand } from '../form-message.js'
import type { FormSender } from '../form-watch-ipc.js'
import { KEEP_MS, QUIET_MS, SUCCESS_WINDOW_MS } from '../save-offer.js'
import { memoryVault } from '../vault.js'
import type { PasswordVault, VaultState } from '../vault.js'
import { createWindowForms, NO_LOGINS, SAVE_OVERLAY } from '../window-forms.js'
import type { WindowForms } from '../window-forms.js'

const ORIGIN = 'https://site.example'

interface Rig {
  forms: WindowForms
  vault: PasswordVault
  asks: SlotAsk[]
  cancelled: SlotAsk[]
  sent: Array<{ origin: string, command: FormCommand }>
  settings: { offer: boolean, autofill: boolean }
  advance: (ms: number) => void
  pushes: () => number
  sender: (over?: Partial<FormSender>) => FormSender
  /** Ends the most recent ask the way the slots do. */
  endAsk: (reason: SlotCloseReason) => void
  appTabs: Set<string>
  active: { id: string | null }
  suggests: string[]
  suggestCloses: { count: number }
}

function rig (over: { state?: VaultState, isPrivate?: boolean, refuseAsks?: boolean, contentsUrl?: string } = {}): Rig {
  const vault = memoryVault(over.state ?? 'ready')
  const settings = { offer: true, autofill: true }
  let now = 1000
  const timers: Array<{ at: number, run: () => void, off: boolean }> = []
  const asks: SlotAsk[] = []
  const cancelled: SlotAsk[] = []
  const sent: Rig['sent'] = []
  const appTabs = new Set<string>()
  const active = { id: 't1' as string | null }
  const suggests: string[] = []
  const suggestCloses = { count: 0 }
  const contents = { isDestroyed: () => false, mainFrame: { url: over.contentsUrl ?? `${ORIGIN}/login` } } as unknown as WebContents
  const forms = createWindowForms({} as ShellWindow, {
    vault,
    settings: { get: (key) => key === 'passwords.offerToSave' ? settings.offer : settings.autofill },
    isPrivate: over.isPrivate === true,
    isAppTab: (tabId) => appTabs.has(tabId),
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, off: false }
      timers.push(timer)
      return () => { timer.off = true }
    },
    requestSlot: (ask) => {
      asks.push(ask)
      if (over.refuseAsks === true) ask.closed('queue-full')
      return { cancel: () => { cancelled.push(ask); ask.closed('request') } }
    },
    anchor: () => undefined,
    send: (_contents, origin, command) => { sent.push({ origin, command }); return true },
    liveContents: () => contents,
    isActive: (tabId) => active.id === tabId,
    openSuggest: (tabId) => { suggests.push(tabId) },
    closeSuggest: () => { suggestCloses.count += 1 }
  })
  let pushes = 0
  forms.onChange(() => { pushes += 1 })
  return {
    forms, vault, asks, cancelled, sent, settings, appTabs, active, suggests, suggestCloses,
    advance: (ms) => {
      now += ms
      for (const timer of [...timers]) if (!timer.off && timer.at <= now) { timer.off = true; timer.run() }
    },
    pushes: () => pushes,
    sender: (extra = {}) => ({ window: {} as ShellWindow, tabId: 't1', contents, origin: ORIGIN, ...extra }),
    endAsk: (reason) => { asks.at(-1)?.closed(reason) }
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve() }

/** A sign-in submitted on the login page, then a full navigation to a page with no password field. */
async function signedIn (r: Rig, username = 'ada', password = 'pw-1'): Promise<void> {
  r.forms.hello(r.sender())
  r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: false })
  r.forms.submit(r.sender(), { type: 'submit', username, password })
  r.advance(200)
  r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
  r.advance(100)
  r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
  await flush()
}

describe('the watcher\'s config', () => {
  it('turns it on for an ordinary tab when the vault is ready and a setting is on', () => {
    const r = rig()
    expect(r.forms.config('t1', ORIGIN)).toEqual({ enabled: true, save: true, autofill: true })
    r.settings.offer = false
    expect(r.forms.config('t1', ORIGIN)).toEqual({ enabled: true, save: false, autofill: true })
    r.settings.offer = true
    r.settings.autofill = false
    expect(r.forms.config('t1', ORIGIN)).toEqual({ enabled: true, save: true, autofill: false })
  })

  it('leaves it off when both settings are off, the vault cannot keep logins, the window is private or the tab is an app', () => {
    const both = rig()
    both.settings.offer = false
    both.settings.autofill = false
    expect(both.forms.config('t1', ORIGIN).enabled).toBe(false)
    expect(rig({ state: 'unavailable' }).forms.config('t1', ORIGIN)).toEqual({ enabled: false, save: false, autofill: false })
    expect(rig({ state: 'private' }).forms.config('t1', ORIGIN).enabled).toBe(false)
    expect(rig({ isPrivate: true }).forms.config('t1', ORIGIN).enabled).toBe(false)
    const app = rig()
    app.appTabs.add('t1')
    expect(app.forms.config('t1', ORIGIN)).toEqual({ enabled: false, save: false, autofill: false })
  })

  it('does not ask to save for an origin on the never list', () => {
    const r = rig()
    r.vault.never.add(ORIGIN)
    expect(r.forms.config('t1', ORIGIN)).toEqual({ enabled: true, save: false, autofill: true })
    expect(r.forms.config('t2', 'https://other.example').save).toBe(true)
  })

  it('answers a hello with the config, sent to that page at its own origin', () => {
    const r = rig()
    r.forms.hello(r.sender())
    expect(r.sent).toEqual([{ origin: ORIGIN, command: { type: 'config', enabled: true, save: true, autofill: true } }])
  })

  it('tells every tab again when a setting or the vault changed, and forgets what it was waiting on when saving is off', async () => {
    const r = rig()
    await signedIn(r)
    expect(r.forms.offerFor('t1')).toBeDefined()
    r.sent.length = 0
    r.settings.offer = false
    r.forms.configChanged()
    expect(r.sent.at(-1)).toEqual({ origin: ORIGIN, command: { type: 'config', enabled: true, save: false, autofill: true } })
    expect(r.forms.offerFor('t1')).toBeUndefined()
  })
})

describe('a sign-in the page reports', () => {
  it('is offered once the next page has no password field, in the address slot of its tab', async () => {
    const r = rig()
    await signedIn(r)
    expect(r.asks).toHaveLength(1)
    expect(r.asks[0]).toMatchObject({ tabId: 't1', slot: 'address', overlay: SAVE_OVERLAY, payload: { tabId: 't1' } })
    expect(r.forms.offerFor('t1')).toEqual({ kind: 'save', origin: ORIGIN, username: 'ada' })
    expect(r.forms.loginState('t1').offer).toBe(true)
  })

  it('is not offered when saving is off, for an origin on the never list, or with a vault that cannot keep it', async () => {
    const off = rig()
    off.settings.offer = false
    await signedIn(off)
    expect(off.asks).toEqual([])
    const never = rig()
    never.vault.never.add(ORIGIN)
    await signedIn(never)
    expect(never.asks).toEqual([])
    const unavailable = rig({ state: 'unavailable' })
    await signedIn(unavailable)
    expect(unavailable.asks).toEqual([])
  })

  it('is not offered when the next page asks for a password again: the sign-in failed', async () => {
    const r = rig()
    r.forms.hello(r.sender())
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'wrong' })
    r.advance(200)
    r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: false })
    await flush()
    expect(r.asks).toEqual([])
    expect(r.forms.offerFor('t1')).toBeUndefined()
    r.advance(SUCCESS_WINDOW_MS + 100)
    await flush()
    expect(r.asks).toEqual([])
  })

  it('is not offered when the page answered with an error status', async () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    r.advance(100)
    r.forms.navigated('t1', { inPage: false, status: 403, origin: ORIGIN })
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
    await flush()
    expect(r.asks).toEqual([])
  })

  it('is offered for a page that never navigates but loses its password field, once it has settled', async () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    r.advance(300)
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
    await flush()
    expect(r.asks).toEqual([])
    r.advance(QUIET_MS)
    await flush()
    expect(r.asks).toHaveLength(1)
  })

  it('is offered straight after a same-document navigation that leaves no password field', async () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    r.advance(300)
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
    r.forms.navigated('t1', { inPage: true, status: -1, origin: ORIGIN })
    await flush()
    expect(r.asks).toHaveLength(1)
  })

  it('is dropped when the tab goes to another origin before it is judged', async () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    r.advance(100)
    r.forms.navigated('t1', { inPage: false, status: 200, origin: 'https://other.example' })
    r.forms.fields(r.sender({ origin: 'https://other.example' }), { type: 'fields', hasPassword: false, signUp: false })
    await flush()
    expect(r.asks).toEqual([])
  })

  it('is not offered when the same login with the same password is already kept', async () => {
    const r = rig()
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'pw-1' })
    await signedIn(r)
    expect(r.asks).toEqual([])
    expect(r.forms.loginState('t1').offer).toBe(false)
  })

  it('is an update of the login that has the same username and another password', async () => {
    const r = rig()
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'old' })
    await signedIn(r)
    expect(r.forms.offerFor('t1')).toEqual({ kind: 'update', origin: ORIGIN, username: 'ada' })
  })

  it('a second submit replaces the first: one pending offer per tab', async () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'first' })
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'second' })
    r.advance(100)
    r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
    await flush()
    expect(r.asks).toHaveLength(1)
    expect(r.forms.reveal('t1')).toBe('second')
  })

  it('an offer does not exist for a page that is not offered yet', () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.forms.reveal('t1')).toBeUndefined()
    expect(r.forms.loginState('t1').offer).toBe(false)
  })

  it('forgets the credential when it was never judged worth offering and the time is up', () => {
    const r = rig()
    r.forms.submit(r.sender(), { type: 'submit', username: 'ada', password: 'pw' })
    r.advance(KEEP_MS + 100)
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.asks).toEqual([])
  })
})

describe('an offer that is showing', () => {
  it('saves the login with the username the person left in the box, and is then over', async () => {
    const r = rig()
    await signedIn(r, 'ada', 'pw-1')
    expect(await r.forms.save('t1', 'ada.l')).toBe(true)
    const saved = r.vault.list(ORIGIN)
    expect(saved.map((login) => login.username)).toEqual(['ada.l'])
    expect(await r.vault.reveal(saved[0]?.id ?? '')).toBe('pw-1')
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.forms.loginState('t1').offer).toBe(false)
  })

  it('updates the login it belongs to whatever username the page sends: the username of an update is not editable', async () => {
    const r = rig()
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'old' })
    await signedIn(r, 'ada', 'new')
    expect(await r.forms.save('t1', 'somebody-else')).toBe(true)
    expect(r.vault.list(ORIGIN).map((login) => login.username)).toEqual(['ada'])
    expect(await r.vault.reveal(r.vault.list(ORIGIN)[0]?.id ?? '')).toBe('new')
  })

  it('reports a save the vault refused, and keeps the offer', async () => {
    const r = rig()
    await signedIn(r)
    const save = vi.spyOn(r.vault, 'save').mockResolvedValue(null)
    expect(await r.forms.save('t1', 'ada')).toBe(false)
    expect(save).toHaveBeenCalled()
    expect(r.forms.offerFor('t1')).toBeDefined()
  })

  it('refuses to save when nothing is offered', async () => {
    expect(await rig().forms.save('t1', 'ada')).toBe(false)
  })

  it('"Never for this site" puts the origin on the list, drops the offer and tells the pages saving is off', async () => {
    const r = rig()
    await signedIn(r)
    r.sent.length = 0
    r.forms.never('t1')
    expect(r.vault.never.has(ORIGIN)).toBe(true)
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.cancelled).toHaveLength(1)
    expect(r.sent.at(-1)?.command).toEqual({ type: 'config', enabled: true, save: false, autofill: true })
  })

  it('"Not now" ends the offer and closes the prompt', async () => {
    const r = rig()
    await signedIn(r)
    r.forms.decline('t1')
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.cancelled).toHaveLength(1)
    expect(r.forms.reopenOffer('t1')).toBe(false)
  })

  it('gives the password to Orivon\'s own prompt to reveal, and to nobody else', async () => {
    const r = rig()
    await signedIn(r, 'ada', 'pw-secret')
    expect(r.forms.reveal('t1')).toBe('pw-secret')
    expect(r.forms.reveal('t2')).toBeUndefined()
    expect(JSON.stringify(r.forms.offerFor('t1'))).not.toContain('pw-secret')
    expect(JSON.stringify(r.forms.loginState('t1'))).not.toContain('pw-secret')
  })

  it('stays for the password button when the prompt went away, and shows it again on demand', async () => {
    const r = rig()
    await signedIn(r)
    r.endAsk('request')
    expect(r.forms.loginState('t1').offer).toBe(true)
    expect(r.forms.reopenOffer('t1')).toBe(true)
    expect(r.asks).toHaveLength(2)
    // Asked again while it shows: no second ask.
    expect(r.forms.reopenOffer('t1')).toBe(true)
    expect(r.asks).toHaveLength(2)
  })

  it('can be shown again after the slot refused it outright', async () => {
    const r = rig({ refuseAsks: true })
    await signedIn(r)
    expect(r.forms.loginState('t1').offer).toBe(true)
    expect(r.forms.reopenOffer('t1')).toBe(true)
    expect(r.asks).toHaveLength(2)
  })

  it('is forgotten after five minutes', async () => {
    const r = rig()
    await signedIn(r)
    r.advance(KEEP_MS + 100)
    expect(r.forms.loginState('t1').offer).toBe(false)
    expect(r.forms.offerFor('t1')).toBeUndefined()
  })

  it('goes when the tab leaves the site, and stays across a same-site navigation', async () => {
    const r = rig()
    await signedIn(r)
    r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
    expect(r.forms.offerFor('t1')).toBeDefined()
    r.forms.navigated('t1', { inPage: false, status: 200, origin: 'https://other.example' })
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.cancelled).toHaveLength(1)
  })

  it('goes with its tab', async () => {
    const r = rig()
    await signedIn(r)
    r.forms.tabGone('t1')
    expect(r.forms.offerFor('t1')).toBeUndefined()
    expect(r.forms.loginState('t1')).toEqual(NO_LOGINS)
  })
})

describe('the password button and the chooser', () => {
  async function withLogins (r: Rig): Promise<void> {
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'a' })
    await r.vault.save({ origin: ORIGIN, username: 'grace', password: 'g' })
    await r.vault.save({ origin: 'https://other.example', username: 'other', password: 'o' })
  }

  it('counts the logins of the page\'s origin once the page shows a password field', async () => {
    const r = rig()
    await withLogins(r)
    r.forms.hello(r.sender())
    expect(r.forms.loginState('t1')).toEqual({ count: 0, offer: false, signUp: false })
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: false })
    expect(r.forms.loginState('t1')).toEqual({ count: 2, offer: false, signUp: false })
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: false, signUp: false })
    expect(r.forms.loginState('t1').count).toBe(0)
  })

  it('flags a sign-up form', () => {
    const r = rig()
    r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: true })
    expect(r.forms.loginState('t1')).toEqual({ count: 0, offer: false, signUp: true })
  })

  it('shows nothing with autofill off, in a private window, without a ready vault, or for an app', async () => {
    for (const setup of [
      (r: Rig) => { r.settings.autofill = false },
      (r: Rig) => { r.appTabs.add('t1') }
    ]) {
      const r = rig()
      await withLogins(r)
      setup(r)
      r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: true })
      expect(r.forms.loginState('t1')).toEqual({ count: 0, offer: false, signUp: false })
    }
    for (const over of [{ isPrivate: true }, { state: 'unavailable' as const }]) {
      const r = rig(over)
      r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: true })
      expect(r.forms.loginState('t1')).toEqual(NO_LOGINS)
    }
  })

  it('knows no tab it has not heard from', () => {
    expect(rig().forms.loginState('nope')).toEqual(NO_LOGINS)
    expect(rig().forms.loginState(null)).toEqual(NO_LOGINS)
    expect(rig().forms.logins('nope')).toEqual([])
  })

  it('lists the logins of the page\'s origin, the most recently used first, then the newest', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      vi.setSystemTime(1000)
      await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'a' })
      vi.setSystemTime(2000)
      await r.vault.save({ origin: ORIGIN, username: 'grace', password: 'g' })
      await r.vault.save({ origin: 'https://other.example', username: 'other', password: 'o' })
      r.forms.fields(r.sender(), { type: 'fields', hasPassword: true, signUp: false })
      expect(r.forms.logins('t1').map((login) => login.username)).toEqual(['grace', 'ada'])
      vi.setSystemTime(3000)
      r.vault.touch?.(r.vault.list(ORIGIN).find((login) => login.username === 'ada')?.id ?? '')
      expect(r.forms.logins('t1').map((login) => login.username)).toEqual(['ada', 'grace'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers the focused field and tells the chrome', () => {
    const r = rig()
    const before = r.pushes()
    r.forms.focus(r.sender(), { type: 'focus', rect: { x: 1, y: 2, width: 3, height: 4 }, viewWidth: 1000, signUp: false })
    expect(r.forms.focusedField('t1')).toEqual({ rect: { x: 1, y: 2, width: 3, height: 4 }, viewWidth: 1000, signUp: false })
    expect(r.pushes()).toBeGreaterThan(before)
  })

  it('opens the chooser by itself until Escape, and again after the page loads anew', () => {
    const r = rig()
    r.forms.hello(r.sender())
    expect(r.forms.chooserWanted('t1')).toBe(true)
    r.forms.dismissChooser('t1')
    expect(r.forms.chooserWanted('t1')).toBe(false)
    r.forms.navigated('t1', { inPage: true, status: -1, origin: ORIGIN })
    expect(r.forms.chooserWanted('t1')).toBe(false)
    r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
    expect(r.forms.chooserWanted('t1')).toBe(true)
    r.settings.autofill = false
    expect(r.forms.chooserWanted('t1')).toBe(false)
  })
})

describe('the chooser under a focused box', () => {
  const box = { type: 'focus', rect: { x: 1, y: 2, width: 3, height: 4 }, viewWidth: 1000, signUp: false } as const

  it('opens when a box of a site with saved logins is focused, handing it the box', async () => {
    const r = rig()
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'x' })
    r.forms.focus(r.sender(), box)
    expect(r.suggests).toEqual(['t1'])
  })

  it('does not open for a site with no saved logins, unless the form is a sign-up', () => {
    const r = rig()
    r.forms.focus(r.sender(), box)
    expect(r.suggests).toEqual([])
    r.forms.focus(r.sender(), { ...box, signUp: true })
    expect(r.suggests).toEqual(['t1'])
  })

  it('does not open for a tab that is not in front, with autofill off, for an app or without a ready vault', async () => {
    for (const setup of [
      (r: Rig) => { r.active.id = 't2' },
      (r: Rig) => { r.settings.autofill = false },
      (r: Rig) => { r.appTabs.add('t1') }
    ]) {
      const r = rig()
      await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'x' })
      setup(r)
      r.forms.focus(r.sender(), box)
      expect(r.suggests).toEqual([])
    }
    const unavailable = rig({ state: 'unavailable' })
    unavailable.forms.focus(unavailable.sender(), { ...box, signUp: true })
    expect(unavailable.suggests).toEqual([])
  })

  it('does not open again after Escape, until the page loads anew', async () => {
    const r = rig()
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'x' })
    r.forms.hello(r.sender())
    r.forms.dismissChooser('t1')
    r.forms.focus(r.sender(), box)
    expect(r.suggests).toEqual([])
    r.forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
    r.forms.focus(r.sender(), box)
    expect(r.suggests).toEqual(['t1'])
  })

  it('closes when the box loses focus', () => {
    const r = rig()
    r.forms.blur(r.sender())
    expect(r.suggestCloses.count).toBe(1)
  })

  it('offers a key to the chooser that is open for that tab, and to no other', () => {
    const r = rig()
    const handle = vi.fn(() => true)
    r.forms.setKeys({ tabId: 't1', handle })
    expect(r.forms.keyFor('t1', 'ArrowDown')).toBe(true)
    expect(handle).toHaveBeenCalledWith('ArrowDown')
    expect(r.forms.keyFor('t2', 'ArrowDown')).toBe(false)
    r.forms.setKeys(null)
    expect(r.forms.keyFor('t1', 'ArrowDown')).toBe(false)
  })
})
