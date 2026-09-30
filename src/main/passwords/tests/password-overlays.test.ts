import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { FORM_FILL_CHANNEL } from '../../channels.js'
import { formsFor } from '../forms-registry.js'
import { passwordFillOverlay, passwordSuggestOverlay } from '../chooser-overlays.js'
import { passwordSaveOverlay, PROMPT_IDLE_MS } from '../password-overlays.js'
import { FILL_OVERLAY, SUGGEST_OVERLAY } from '../window-forms.js'
import { memoryVault } from '../vault.js'
import type { PasswordVault } from '../vault.js'

const ORIGIN = 'https://site.example'

interface Rig {
  window: ShellWindow
  services: ShellServices
  vault: PasswordVault
  frame: { url: string }
  sends: unknown[]
  shows: Array<{ name: string, payload: unknown }>
  closes: string[]
  overlaySends: unknown[]
  active: { id: string | null }
  run: ReturnType<typeof vi.fn>
}

function rig (): Rig {
  const vault = memoryVault()
  const frame = { url: `${ORIGIN}/login` }
  const sends: unknown[] = []
  const shows: Rig['shows'] = []
  const closes: string[] = []
  const overlaySends: unknown[] = []
  const active = { id: 't1' as string | null }
  const contents = {
    id: 5,
    isDestroyed: () => false,
    mainFrame: { get url () { return frame.url }, send: (channel: string, command: unknown) => { expect(channel).toBe(FORM_FILL_CHANNEL); sends.push(command) } }
  } as unknown as WebContents
  const window = {
    tabs: {
      getState: () => ({ activeTabId: active.id }),
      liveWebContents: () => contents,
      partitionOf: () => undefined
    },
    overlays: {
      show: (name: string, _anchor: unknown, payload: unknown) => { shows.push({ name, payload }) },
      close: (name: string) => { closes.push(name) },
      send: (_name: string, event: unknown) => { overlaySends.push(event) },
      toggle: () => {}
    }
  } as unknown as ShellWindow
  const run = vi.fn()
  const services = { passwords: vault, settings: { get: () => true }, isPrivate: false, commands: { run } } as unknown as ShellServices
  return { window, services, vault, frame, sends, shows, closes, overlaySends, active, run }
}

function attach (def: typeof passwordSaveOverlay, r: Rig): { handler: OverlayHandler, close: ReturnType<typeof vi.fn>, takeFocus: ReturnType<typeof vi.fn>, sent: unknown[] } {
  const close = vi.fn()
  const takeFocus = vi.fn()
  const sent: unknown[] = []
  let handler: OverlayHandler | undefined
  const win = { window: r.window, services: r.services, send: (event: unknown) => { sent.push(event) }, close: () => { close(); handler?.closed?.('request') }, takeFocus } as unknown as OverlayWindow
  handler = def.attach(win)
  return { handler, close, takeFocus, sent }
}

const sender = (r: Rig): Parameters<ReturnType<typeof formsFor>['hello']>[0] => ({
  window: r.window, tabId: 't1', origin: ORIGIN,
  contents: { isDestroyed: () => false, mainFrame: { get url () { return r.frame.url }, send: () => {} } } as unknown as WebContents
})

/** The page submits a sign-in and then shows a page with no password field. */
async function offer (r: Rig, username = 'ada', password = 'pw-1'): Promise<void> {
  const forms = formsFor(r.window, r.services)
  forms.hello(sender(r))
  forms.submit(sender(r), { type: 'submit', username, password })
  await vi.advanceTimersByTimeAsync(100)
  forms.navigated('t1', { inPage: false, status: 200, origin: ORIGIN })
  forms.fields(sender(r), { type: 'fields', hasPassword: false, signUp: false })
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the overlay declarations', () => {
  it('the prompt sits under the address pill, right aligned, never takes the keyboard by itself and outlives navigation', () => {
    expect(passwordSaveOverlay).toMatchObject({ name: 'password-save', focus: 'never', layer: 'bar', keep: 'fresh', placement: { kind: 'anchor', width: 340, align: 'right' } })
    expect(passwordSaveOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
  })

  it('the chooser is a popup that takes focus and closes like one', () => {
    expect(passwordFillOverlay).toMatchObject({ name: 'password-fill', focus: 'take', layer: 'popup', surface: 'menu', placement: { kind: 'anchor', width: 320 } })
    expect(passwordFillOverlay.closeOn).toEqual({ blur: true, tabSwitch: true, navigation: false, layout: true })
  })
})

describe('the save prompt', () => {
  it('shows what is offered, without the password, and closes itself when nothing is waiting', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSaveOverlay, r)
    expect(handler.show?.({ tabId: 't1' })).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
    await offer(r, 'ada', 'pw-secret')
    expect(r.shows).toEqual([{ name: 'password-save', payload: { tabId: 't1' } }])
    const view = handler.show?.({ tabId: 't1' })
    expect(view).toEqual({ kind: 'save', origin: ORIGIN, username: 'ada' })
    expect(JSON.stringify(view)).not.toContain('pw-secret')
  })

  it('refuses a payload that is not a tab id', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSaveOverlay, r)
    await offer(r)
    for (const payload of [undefined, null, 'x', { tabId: 7 }, { tabId: 'nope' }]) expect(handler.show?.(payload)).toBeUndefined()
    expect(close).toHaveBeenCalledTimes(5)
  })

  it('saves the login with the username it is sent, and answers whether it was kept', async () => {
    const r = rig()
    const { handler } = attach(passwordSaveOverlay, r)
    await offer(r, 'ada', 'pw-1')
    handler.show?.({ tabId: 't1' })
    expect(await handler.request({ type: 'save', username: 'ada.l' })).toEqual({ ok: true })
    expect(r.vault.list(ORIGIN).map((login) => login.username)).toEqual(['ada.l'])
  })

  it('refuses a save whose username is not a short string', async () => {
    const r = rig()
    const { handler } = attach(passwordSaveOverlay, r)
    await offer(r)
    handler.show?.({ tabId: 't1' })
    for (const username of [undefined, 7, null, {}, 'a'.repeat(257)]) expect(await handler.request({ type: 'save', username })).toBeUndefined()
    expect(r.vault.list(ORIGIN)).toEqual([])
  })

  it('does nothing before it has been shown an offer, and for commands it does not know', async () => {
    const r = rig()
    const { handler } = attach(passwordSaveOverlay, r)
    expect(await handler.request({ type: 'save', username: 'ada' })).toBeUndefined()
    await offer(r)
    handler.show?.({ tabId: 't1' })
    for (const command of [undefined, null, 'save', 7, {}, { type: 'delete' }, { type: 'fill', id: 'x' }]) expect(await handler.request(command)).toBeUndefined()
  })

  it('"never" puts the site on the list and closes; "dismiss" closes and forgets the offer', async () => {
    const r = rig()
    const first = attach(passwordSaveOverlay, r)
    await offer(r)
    first.handler.show?.({ tabId: 't1' })
    await first.handler.request({ type: 'never' })
    expect(r.vault.never.has(ORIGIN)).toBe(true)
    expect(first.close).toHaveBeenCalled()

    const r2 = rig()
    const second = attach(passwordSaveOverlay, r2)
    await offer(r2)
    second.handler.show?.({ tabId: 't1' })
    await second.handler.request({ type: 'dismiss' })
    expect(r2.vault.never.has(ORIGIN)).toBe(false)
    expect(formsFor(r2.window, r2.services).offerFor('t1')).toBeUndefined()
    expect(second.close).toHaveBeenCalled()
  })

  it('reveals the password to its own page on request, and only while it is showing an offer', async () => {
    const r = rig()
    const { handler } = attach(passwordSaveOverlay, r)
    await offer(r, 'ada', 'pw-secret')
    expect(await handler.request({ type: 'reveal' })).toBeUndefined()
    handler.show?.({ tabId: 't1' })
    expect(await handler.request({ type: 'reveal' })).toEqual({ password: 'pw-secret' })
    handler.closed?.('request')
    expect(await handler.request({ type: 'reveal' })).toBeUndefined()
  })

  it('takes the keyboard only when the page asks', async () => {
    const r = rig()
    const { handler, takeFocus } = attach(passwordSaveOverlay, r)
    await offer(r)
    handler.show?.({ tabId: 't1' })
    expect(takeFocus).not.toHaveBeenCalled()
    await handler.request({ type: 'focus' })
    expect(takeFocus).toHaveBeenCalledTimes(1)
  })

  it('closes after twenty seconds without a touch, and a touch starts the time again', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSaveOverlay, r)
    await offer(r)
    handler.show?.({ tabId: 't1' })
    await vi.advanceTimersByTimeAsync(PROMPT_IDLE_MS - 1000)
    await handler.request({ type: 'interact' })
    await vi.advanceTimersByTimeAsync(PROMPT_IDLE_MS - 1000)
    expect(close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('keeps the offer for the password button when it closes by itself, and stops its clock on close', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSaveOverlay, r)
    await offer(r)
    handler.show?.({ tabId: 't1' })
    await vi.advanceTimersByTimeAsync(PROMPT_IDLE_MS)
    expect(formsFor(r.window, r.services).loginState('t1').offer).toBe(true)
    handler.closed?.('request')
    await vi.advanceTimersByTimeAsync(PROMPT_IDLE_MS * 2)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('the chooser', () => {
  async function onLoginPage (r: Rig, signUp = false): Promise<void> {
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'pw-ada' })
    await r.vault.save({ origin: ORIGIN, username: 'grace', password: 'pw-grace' })
    await r.vault.save({ origin: 'https://other.example', username: 'other', password: 'pw-other' })
    const forms = formsFor(r.window, r.services)
    forms.hello(sender(r))
    forms.fields(sender(r), { type: 'fields', hasPassword: true, signUp })
  }

  it('lists the usernames of the page\'s origin and never a password', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string, username: string }>, generated: string | null }
    expect(view.logins.map((row) => row.username).sort()).toEqual(['ada', 'grace'])
    expect(view.generated).toBeNull()
    expect(JSON.stringify(view)).not.toMatch(/pw-/)
  })

  it('offers a strong password for a sign-up form, with or without saved logins', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r, true)
    const view = handler.show?.(undefined) as { generated: string | null }
    expect(view.generated).toMatch(/^.{20}$/)
    const bare = rig()
    const other = attach(passwordFillOverlay, bare)
    const forms = formsFor(bare.window, bare.services)
    forms.fields(sender(bare), { type: 'fields', hasPassword: true, signUp: true })
    expect((other.handler.show?.(undefined) as { logins: unknown[], generated: string }).logins).toEqual([])
  })

  it('is never shown with nothing to choose from', () => {
    const r = rig()
    const { handler, close } = attach(passwordFillOverlay, r)
    formsFor(r.window, r.services).fields(sender(r), { type: 'fields', hasPassword: true, signUp: false })
    expect(handler.show?.(undefined)).toBeUndefined()
    expect(close).toHaveBeenCalled()
    r.active.id = null
    expect(handler.show?.(undefined)).toBeUndefined()
  })

  it('fills the chosen login into the page and closes', async () => {
    const r = rig()
    const { handler, close } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string, username: string }> }
    const ada = view.logins.find((row) => row.username === 'ada')
    expect(await handler.request({ type: 'fill', id: ada?.id })).toEqual({ ok: true })
    expect(r.sends).toContainEqual({ type: 'fill', username: 'ada', password: 'pw-ada', both: false })
    expect(close).toHaveBeenCalled()
  })

  it('refuses the id of a login of another origin, or no login at all', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    handler.show?.(undefined)
    const foreign = r.vault.list('https://other.example')[0]
    for (const id of [foreign?.id, 'memory-999', '', 7, null, undefined, {}]) {
      const reply = await handler.request({ type: 'fill', id })
      expect(reply === undefined || (reply as { ok: boolean }).ok === false).toBe(true)
    }
    expect(r.sends.filter((command) => (command as { type?: string }).type === 'fill')).toEqual([])
  })

  it('sends nothing to a page that moved to another origin between the choice and the fill', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string }> }
    const reveal = r.vault.reveal.bind(r.vault)
    // The page navigates while the password is being read.
    r.vault.reveal = async (id) => { const password = await reveal(id); r.frame.url = 'https://evil.example/phish'; return password }
    const reply = await handler.request({ type: 'fill', id: view.logins[0]?.id })
    expect(reply).toEqual({ ok: false })
    expect(r.sends).toEqual([])
  })

  it('sends nothing once the page is at another origin when the choice arrives', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string }> }
    r.frame.url = 'https://evil.example/'
    const reply = await handler.request({ type: 'fill', id: view.logins[0]?.id })
    expect(reply).toEqual({ ok: false })
    expect(r.sends).toEqual([])
  })

  it('ignores a command when the tab it was shown for is no longer the one in front', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string }> }
    r.active.id = 't2'
    expect(await handler.request({ type: 'fill', id: view.logins[0]?.id })).toEqual({ ok: false })
    expect(r.sends).toEqual([])
  })

  it('does not fill once the vault cannot keep logins', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    const view = handler.show?.(undefined) as { logins: Array<{ id: string }> }
    vi.spyOn(r.vault, 'state').mockReturnValue('unavailable')
    expect(await handler.request({ type: 'fill', id: view.logins[0]?.id })).toEqual({ ok: false })
    expect(r.sends).toEqual([])
    expect(handler.show?.(undefined)).toBeUndefined()
  })

  it('fills the generated password into every password field, the one it showed', async () => {
    const r = rig()
    const { handler, close } = attach(passwordFillOverlay, r)
    await onLoginPage(r, true)
    const view = handler.show?.(undefined) as { generated: string }
    expect(await handler.request({ type: 'generate' })).toEqual({ ok: true })
    expect(r.sends).toEqual([{ type: 'fill', username: null, password: view.generated, both: true }])
    expect(close).toHaveBeenCalled()
  })

  it('refuses to generate for a form that is not a sign-up', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r, false)
    handler.show?.(undefined)
    expect(await handler.request({ type: 'generate' })).toBeUndefined()
    expect(r.sends).toEqual([])
  })

  it('opens the manager for "Manage passwords"', async () => {
    const r = rig()
    const { handler, close } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    handler.show?.(undefined)
    await handler.request({ type: 'manage' })
    expect(close).toHaveBeenCalled()
    expect(r.run).toHaveBeenCalledWith('passwords.open', r.window)
  })

  it('does not reopen by itself for the page after Escape', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    handler.show?.(undefined)
    expect(formsFor(r.window, r.services).chooserWanted('t1')).toBe(true)
    handler.closed?.('escape')
    expect(formsFor(r.window, r.services).chooserWanted('t1')).toBe(false)
  })

  it('a click elsewhere does not count as a no', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await onLoginPage(r)
    handler.show?.(undefined)
    handler.closed?.('blur')
    expect(formsFor(r.window, r.services).chooserWanted('t1')).toBe(true)
  })
})

describe('the chooser under a focused box', () => {
  async function ready (r: Rig, signUp = false): Promise<void> {
    await r.vault.save({ origin: ORIGIN, username: 'ada', password: 'pw-ada' })
    await r.vault.save({ origin: ORIGIN, username: 'grace', password: 'pw-grace' })
    const forms = formsFor(r.window, r.services)
    forms.hello(sender(r))
    forms.fields(sender(r), { type: 'fields', hasPassword: true, signUp })
  }

  it('never takes the keyboard, closes on a tab switch, navigation and layout, but not on blur', () => {
    expect(passwordSuggestOverlay).toMatchObject({ name: 'password-suggest', focus: 'never', layer: 'popup', placement: { kind: 'anchor', width: 320, align: 'left' } })
    expect(passwordSuggestOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: true, layout: true })
  })

  it('shows the same rows as the button\'s, marked as the one under a box, with nothing chosen', async () => {
    const r = rig()
    const { handler } = attach(passwordSuggestOverlay, r)
    await ready(r)
    const view = handler.show?.(undefined) as { logins: unknown[], mode: string }
    expect(view.mode).toBe('field')
    expect(view.logins).toHaveLength(2)
    const button = attach(passwordFillOverlay, r).handler.show?.(undefined) as { mode: string }
    expect(button.mode).toBe('button')
  })

  it('takes the arrow keys, tells the page which row is chosen, and leaves every other key to the page', async () => {
    const r = rig()
    const { handler, sent } = attach(passwordSuggestOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    const forms = formsFor(r.window, r.services)
    expect(forms.keyFor('t1', 'a')).toBe(false)
    expect(forms.keyFor('t1', 'Tab')).toBe(false)
    expect(forms.keyFor('t1', 'ArrowDown')).toBe(true)
    expect(forms.keyFor('t1', 'ArrowDown')).toBe(true)
    expect(forms.keyFor('t1', 'ArrowDown')).toBe(true)
    expect(forms.keyFor('t1', 'ArrowUp')).toBe(true)
    expect(sent).toEqual([{ type: 'select', index: 0 }, { type: 'select', index: 1 }, { type: 'select', index: 1 }, { type: 'select', index: 0 }])
  })

  it('leaves the keys of another tab to its page', async () => {
    const r = rig()
    const { handler } = attach(passwordSuggestOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    expect(formsFor(r.window, r.services).keyFor('t2', 'ArrowDown')).toBe(false)
  })

  it('leaves Enter to the page until a row is chosen, then fills that row and closes', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSuggestOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    const forms = formsFor(r.window, r.services)
    expect(forms.keyFor('t1', 'Enter')).toBe(false)
    forms.keyFor('t1', 'ArrowDown')
    expect(forms.keyFor('t1', 'Enter')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sends).toHaveLength(1)
    expect(r.sends[0]).toMatchObject({ type: 'fill', both: false })
    expect(close).toHaveBeenCalled()
    // It was answered: the next box on this page does not open it again by itself.
    expect(forms.chooserWanted('t1')).toBe(false)
  })

  it('Escape closes it and is the person saying no for this page', async () => {
    const r = rig()
    const { handler, close } = attach(passwordSuggestOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    const forms = formsFor(r.window, r.services)
    expect(forms.keyFor('t1', 'Escape')).toBe(true)
    expect(close).toHaveBeenCalled()
    expect(forms.chooserWanted('t1')).toBe(false)
  })

  it('takes no key once it is closed', async () => {
    const r = rig()
    const { handler } = attach(passwordSuggestOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    handler.closed?.('request')
    expect(formsFor(r.window, r.services).keyFor('t1', 'ArrowDown')).toBe(false)
  })

  it('a sign-up box offers the strong password first, and choosing it fills every password box', async () => {
    const r = rig()
    const { handler } = attach(passwordSuggestOverlay, r)
    await ready(r, true)
    const view = handler.show?.(undefined) as { generated: string }
    const forms = formsFor(r.window, r.services)
    forms.keyFor('t1', 'ArrowDown')
    forms.keyFor('t1', 'Enter')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sends).toEqual([{ type: 'fill', username: null, password: view.generated, both: true }])
  })

  it('the button\'s chooser takes no keys through main: it has the keyboard itself', async () => {
    const r = rig()
    const { handler } = attach(passwordFillOverlay, r)
    await ready(r)
    handler.show?.(undefined)
    expect(formsFor(r.window, r.services).keyFor('t1', 'ArrowDown')).toBe(false)
  })
})

describe('the overlay name', () => {
  it('is the one the chrome action toggles', () => {
    expect(FILL_OVERLAY).toBe(passwordFillOverlay.name)
    expect(SUGGEST_OVERLAY).toBe(passwordSuggestOverlay.name)
  })
})
