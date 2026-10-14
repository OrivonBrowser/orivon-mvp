import { describe, expect, it, vi } from 'vitest'
import { capabilityFailure, routeWords } from '../settings/apps-view.js'
import { AppsState } from '../settings/apps-state.js'
import type { OrivonInternal } from '../shared/bridge.js'

describe('routeWords', () => {
  it('says why the switch cannot be turned on, in words about the person\'s situation', () => {
    expect(routeWords({ state: 'off', blocked: 'no-proxy' })).toContain('Set a tunnel')
    expect(routeWords({ state: 'off', blocked: 'not-cached' })).toContain('holds on this computer')
    expect(routeWords({ state: 'off', blocked: undefined })).toContain('connects as you do')
  })

  it('says a routed app\'s traffic is stopped, never sent directly, when the proxy is missing or silent', () => {
    expect(routeWords({ state: 'down', blocked: undefined })).toContain('not sent directly')
    expect(routeWords({ state: 'no-proxy', blocked: undefined })).toContain('not sent directly')
  })

  it('says in one sentence that the list of routed apps could not be read, whatever the app\'s state', () => {
    for (const state of ['off', 'idle', 'down'] as const) {
      const words = routeWords({ state, blocked: undefined, unreadable: true })
      expect(words).toContain('could not read which apps you routed')
      expect(words).toContain('every app goes through it')
      expect(words).toContain('restart')
    }
  })

  it('says what a working route means, including that updates are not checked', () => {
    for (const state of ['idle', 'ok'] as const) {
      const words = routeWords({ state, blocked: undefined })
      expect(words).toContain('leaves through your tunnel')
      expect(words).toContain('updates are not checked')
    }
  })
})

describe('AppsState.setRoute when main refuses', () => {
  it('remembers the refusal for the card until the next press, and a failed request counts as one', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: false })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setRoute('https://app.example', true)
    expect(apps.routeRefused.has('https://app.example')).toBe(true)

    request.mockImplementation(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    await apps.setRoute('https://app.example', true)
    expect(apps.routeRefused.has('https://app.example')).toBe(false)

    request.mockImplementation(async (_domain: string, command: { type: string }) => { if (command.type === 'list') return { apps: [], identity: 'keychain' }; throw new Error('closed') })
    await apps.setRoute('https://app.example', false)
    expect(apps.routeRefused.has('https://app.example')).toBe(true)
  })
})

describe('AppsState.setRoute', () => {
  it('asks main to switch the route and reads the list again', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => command.type === 'list' ? { apps: [], identity: 'keychain' } : { ok: true })
    const apps = new AppsState({ request } as unknown as OrivonInternal, () => {})

    await apps.setRoute('https://app.example', true)

    expect(request.mock.calls.map(([domain, command]) => [domain, (command as { type: string }).type])).toEqual([['apps', 'setRoute'], ['apps', 'list']])
    expect(request).toHaveBeenCalledWith('apps', { type: 'setRoute', origin: 'https://app.example', routed: true })
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
