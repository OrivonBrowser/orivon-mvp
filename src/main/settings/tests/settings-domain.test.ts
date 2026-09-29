import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { settingsDomain } from '../settings-domain.js'
import { SettingsStore } from '../settings-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-domain-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const caller = { page: 'settings' as const, contents: {} as WebContents }

async function domain (): Promise<{ store: SettingsStore, ask: (command: unknown) => unknown }> {
  const store = new SettingsStore(join(dir, 'settings.json'))
  await store.load()
  const { handle } = settingsDomain(store)
  return { store, ask: (command) => handle(command, caller) }
}

describe('settingsDomain', () => {
  it('is for the Settings and Extensions pages, and no other', async () => {
    expect(settingsDomain(new SettingsStore(join(dir, 'x.json'))).pages).toEqual(['settings', 'extensions'])
  })

  it('tells the page what every setting is, and what each is set to', async () => {
    const { store, ask } = await domain()
    store.set('appearance.theme', 'dark')

    const reply = ask({ type: 'get' }) as { descriptions: Array<{ key: string }>, values: Record<string, unknown>, changed: string[] }

    expect(reply.descriptions.map((d) => d.key)).toContain('appearance.theme')
    expect(reply.values['appearance.theme']).toBe('dark')
    expect(reply.changed).toEqual(['appearance.theme'])
  })

  it('sets, resets and resets everything, through the store\'s own checks', async () => {
    const { store, ask } = await domain()

    expect(ask({ type: 'set', key: 'search.engine', value: 'brave' })).toEqual({ ok: true })
    expect(store.get('search.engine')).toBe('brave')
    expect(ask({ type: 'set', key: 'search.engine', value: 'nope' })).toEqual({ ok: false, reason: 'invalid-value' })
    expect(ask({ type: 'reset', key: 'search.engine' })).toEqual({ ok: true })
    expect(store.get('search.engine')).toBe('duckduckgo')
    store.set('appearance.theme', 'light')
    expect(ask({ type: 'resetAll' })).toEqual({ ok: true })
    expect(store.snapshot().changed).toEqual([])
  })

  it.each([
    [undefined], [null], ['get'], [5], [{}], [{ type: 'delete' }], [{ type: 'set' }], [{ type: 'set', key: 5, value: 'x' }],
    [{ type: 'set', key: '__proto__', value: 'x' }], [{ type: 'reset', key: {} }]
  ])('answers nothing harmful to the malformed request %j', async (command) => {
    const { store, ask } = await domain()

    expect(() => ask(command)).not.toThrow()
    expect(store.snapshot().changed).toEqual([])
  })
})
