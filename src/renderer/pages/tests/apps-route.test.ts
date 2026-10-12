import { describe, expect, it, vi } from 'vitest'
import { routeWords } from '../settings/apps-view.js'
import { AppsState } from '../settings/apps-state.js'
import type { OrivonInternal } from '../shared/bridge.js'

describe('routeWords', () => {
  it('says why the switch cannot be turned on, in words about the person\'s situation', () => {
    expect(routeWords({ state: 'off', blocked: 'no-proxy' })).toContain('Set a proxy')
    expect(routeWords({ state: 'off', blocked: 'not-cached' })).toContain('holds on this computer')
    expect(routeWords({ state: 'off', blocked: undefined })).toContain('connects as you do')
  })

  it('says a routed app\'s traffic is stopped, never sent directly, when the proxy is missing or silent', () => {
    expect(routeWords({ state: 'down', blocked: undefined })).toContain('not sent directly')
    expect(routeWords({ state: 'no-proxy', blocked: undefined })).toContain('not sent directly')
  })

  it('says what a working route means, including that updates are not checked', () => {
    for (const state of ['idle', 'ok'] as const) {
      const words = routeWords({ state, blocked: undefined })
      expect(words).toContain('leaves through your proxy')
      expect(words).toContain('updates are not checked')
    }
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
