import { describe, expect, it, vi } from 'vitest'
import { capabilityFailure, routeOptions, routeWords } from '../settings/apps-view.js'
import { AppsState } from '../settings/apps-state.js'
import type { OrivonInternal } from '../shared/bridge.js'

const free = { state: 'off', via: null, blocked: {} } as const

describe('routeWords', () => {
  it('says an app with no tunnel connects as the person does, and why a tunnel cannot be chosen, in words about the person\'s situation', () => {
    expect(routeWords(free)).toBe('Off: this app connects as you do.')
    expect(routeWords({ ...free, blocked: { socks5: 'no-proxy' } })).toContain('Your proxy has no address yet')
    expect(routeWords({ ...free, blocked: { nym: 'nym-off' } })).toContain('Nym is switched off')
    expect(routeWords({ ...free, blocked: { nym: 'not-cached', socks5: 'not-cached' } })).toContain('holds on this computer')
    expect(routeWords({ ...free, blocked: { nym: 'not-cached', socks5: 'not-cached' } }).match(/holds on this computer/g)).toHaveLength(1)
  })

  it('says a routed app\'s traffic is stopped, never sent directly, when its tunnel is missing or silent, naming the tunnel', () => {
    expect(routeWords({ state: 'down', via: 'nym', blocked: {} })).toBe('Nym is not answering. This app\'s traffic is stopped, not sent directly.')
    expect(routeWords({ state: 'down', via: 'socks5', blocked: {} })).toBe('Your proxy is not answering. This app\'s traffic is stopped, not sent directly.')
    expect(routeWords({ state: 'no-proxy', via: 'socks5', blocked: {} })).toContain('not sent directly')
  })

  it('says in one sentence that the list of routed apps could not be read, whatever the app\'s state', () => {
    for (const state of ['off', 'idle', 'down'] as const) {
      const words = routeWords({ state, via: null, blocked: {}, unreadable: true })
      expect(words).toContain('could not read which apps you sent through a tunnel')
      expect(words).toContain('every app goes through your default tunnel')
      expect(words).toContain('restart')
    }
  })

  it('says what a working route means, naming the tunnel and saying that updates are not checked', () => {
    for (const state of ['idle', 'ok'] as const) {
      const nym = routeWords({ state, via: 'nym', blocked: {} })
      expect(nym).toContain('leaves through Nym')
      expect(nym).toContain('updates are not checked')
      expect(routeWords({ state, via: 'socks5', blocked: {} })).toContain('leaves through your proxy')
    }
  })
})

describe('the options of the choice', () => {
  it('offers Off, Nym and Your proxy, and holds back a tunnel that cannot be chosen unless the app is on it already', () => {
    expect(routeOptions(free).map((option) => [option.value, option.label, option.disabled])).toEqual([['', 'Off', false], ['nym', 'Nym', false], ['socks5', 'Your proxy', false]])
    expect(routeOptions({ ...free, blocked: { socks5: 'no-proxy', nym: 'nym-off' } }).map((option) => option.disabled)).toEqual([false, true, true])
    expect(routeOptions({ state: 'no-proxy', via: 'socks5', blocked: { socks5: 'no-proxy' } }).map((option) => option.disabled), 'it can always be left or kept').toEqual([false, false, false])
  })
})

describe('AppsState.setRoute when main refuses', () => {
  it('remembers the refusal for the card until the next press, and a failed request counts as one', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: false })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setRoute('https://app.example', 'nym')
    expect(apps.routeRefused.has('https://app.example')).toBe(true)

    request.mockImplementation(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    await apps.setRoute('https://app.example', 'nym')
    expect(apps.routeRefused.has('https://app.example')).toBe(false)

    request.mockImplementation(async (_domain: string, command: { type: string }) => { if (command.type === 'list') return { apps: [], identity: 'keychain' }; throw new Error('closed') })
    await apps.setRoute('https://app.example', null)
    expect(apps.routeRefused.has('https://app.example')).toBe(true)
  })
})

describe('AppsState.setRoute', () => {
  it('asks main to switch the route and reads the list again', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setRoute('https://app.example', 'nym')

    expect(request.mock.calls.map(([domain, command]) => [domain, (command as { type: string }).type])).toEqual([['apps', 'setRoute'], ['apps', 'list']])
    expect(request).toHaveBeenCalledWith('apps', { type: 'setRoute', origin: 'https://app.example', kind: 'nym' })
  })
})

describe('AppsState.setCapability', () => {
  const ROW = { capability: 'https.connect', on: true, canTurnOn: true, warning: false, message: 'Connect to a.example', patterns: ['a.example:443'] }

  it('sends the switch with the patterns its row offered, and reads the list again', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setCapability('https://app.example', ROW, false)
    expect(request).toHaveBeenCalledWith('apps', { type: 'setCapability', origin: 'https://app.example', capability: 'https.connect', on: false, patterns: ['a.example:443'] })
    expect(request).toHaveBeenLastCalledWith('apps', { type: 'list' })
    expect(apps.capabilityRefused.size).toBe(0)
  })

  it('remembers a turn-on that main refused, or that failed, until the next press', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }): Promise<unknown> => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: false, reason: 'stale' })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setCapability('https://app.example', ROW, true)
    expect(apps.capabilityRefused.get('https://app.example|https.connect')).toBe(true)

    request.mockImplementation(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    await apps.setCapability('https://app.example', ROW, true)
    expect(apps.capabilityRefused.size).toBe(0)
  })

  it('holds the switch while its request is in flight, and sends a second press of it nowhere', async () => {
    let release: () => void = () => {}
    const request = vi.fn(async (_domain: string, command: { type: string }): Promise<unknown> => {
      if (command.type === 'list') return { apps: [], identity: 'keychain' }
      await new Promise<void>((resolve) => { release = resolve })
      return { ok: true }
    })
    const changed = vi.fn()
    const apps = new AppsState({ request } as unknown as OrivonInternal, changed)
    const key = 'https://app.example|https.connect'

    const first = apps.setCapability('https://app.example', ROW, false)
    expect(apps.capabilityBusy.has(key)).toBe(true)
    expect(changed).toHaveBeenCalled()
    await apps.setCapability('https://app.example', ROW, true)
    expect(request.mock.calls.filter(([, command]) => (command as { type: string }).type === 'setCapability')).toHaveLength(1)

    release()
    await first
    expect(apps.capabilityBusy.has(key)).toBe(false)
  })

  it('frees the switch when its request failed', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }): Promise<unknown> => {
      if (command.type === 'list') return { apps: [], identity: 'keychain' }
      throw new Error('gone')
    })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})
    await apps.setCapability('https://app.example', ROW, false)
    expect(apps.capabilityBusy.size).toBe(0)
  })

  it('remembers which way the switch was moved, so the row can say what could not be done', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }): Promise<unknown> => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: false })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setCapability('https://app.example', ROW, false)
    expect(apps.capabilityRefused.get('https://app.example|https.connect')).toBe(false)
    expect(capabilityFailure(false)).toMatch(/turn that off/)
    expect(capabilityFailure(true)).toMatch(/turn that on/)
  })
})
