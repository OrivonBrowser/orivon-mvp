import { describe, expect, it, vi } from 'vitest'
import { CLOSE_LIKE_POPUP } from '../../overlays/overlay-types.js'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { shortcutOverlayFor } from '../shortcut-overlay.js'
import type { ShortcutHost } from '../site-shortcut-runner.js'

const PROFILE = '0123456789ab'

function setup (over: { isPrivate?: boolean, profiles?: Array<{ id: string, name: string, current: boolean }> } = {}): { handler: OverlayHandler, files: Map<string, string> } {
  const files = new Map<string, string>()
  const host: ShortcutHost = {
    platform: 'linux', isPackaged: true, appPath: '/a', execPath: '/opt/orivon', env: () => ({ XDG_DATA_HOME: '/d' }), home: () => '/h', desktop: () => '/desk',
    makeDirectory: async () => {}, writeFile: async (path, text) => { files.set(path, text) }, writeLink: () => true
  }
  const services = { isPrivate: over.isPrivate ?? false, profiles: { list: () => over.profiles ?? [{ id: 'default', name: 'Default', current: true }] } }
  const handler = shortcutOverlayFor(host).attach({ window: {}, services, send: vi.fn(), close: vi.fn() } as unknown as OverlayWindow)
  return { handler, files }
}

const FIRST = (files: Map<string, string>): string => [...files.values()][0] ?? ''

describe('the shortcut sheet', () => {
  it('is a centred sheet that goes with the tab or the navigation', () => {
    const def = shortcutOverlayFor({} as ShortcutHost)
    expect(def).toMatchObject({ name: 'shortcut-sheet', placement: { kind: 'area', at: 'center', width: 400 }, focus: 'take', layer: 'popup', keep: 'fresh' })
    expect(def.closeOn).toEqual({ ...CLOSE_LIKE_POPUP, navigation: true })
  })

  it('tells the page the site, the suggested name and whether another profile is in use', () => {
    const { handler } = setup()
    expect(handler.show?.({ url: 'https://example.com/a', title: '  Example\nDomain ' })).toEqual({ origin: 'https://example.com', name: 'Example Domain', maxName: 60 })
    const other = setup({ profiles: [{ id: PROFILE, name: 'Work', current: true }] })
    expect(other.handler.show?.({ url: 'https://example.com/a', title: 'T' })).toMatchObject({ profileName: 'Work' })
  })

  it('refuses to show for anything but an http or https address', () => {
    const { handler } = setup()
    for (const bad of [undefined, null, 'x', {}, { url: 3, title: 't' }, { url: 'https://example.com/' }, { url: 'file:///etc/passwd', title: 't' }, { url: 'javascript:alert(1)', title: 't' }, { url: 'https://example.com/' + 'x'.repeat(40000), title: 't' }]) {
      expect(handler.show?.(bad), JSON.stringify(bad)?.slice(0, 40)).toBeUndefined()
    }
  })

  it('creates the shortcut for the address it was shown, under the name the person typed', async () => {
    const { handler, files } = setup()
    handler.show?.({ url: 'https://example.com/a', title: 'T' })
    expect(await handler.request({ type: 'create', name: 'My site', thisProfile: false })).toEqual({ ok: true, where: 'applications' })
    expect(FIRST(files)).toContain('Name=My site\n')
    expect(FIRST(files)).toContain('"https://example.com/a"')
    expect(FIRST(files)).not.toContain('--orivon-profile')
  })

  it('cleans what the person typed, and falls back to the host for an empty name', async () => {
    const { handler, files } = setup()
    handler.show?.({ url: 'https://example.com/a', title: 'T' })
    await handler.request({ type: 'create', name: 'A\nExec=/bin/sh', thisProfile: false })
    expect(FIRST(files).split('\n').filter((line) => line.startsWith('Exec='))).toHaveLength(1)
    files.clear()
    await handler.request({ type: 'create', name: ' \n ', thisProfile: false })
    expect(FIRST(files)).toContain('Name=example.com\n')
  })

  it('names the profile only when asked to and only when it is another than the default', async () => {
    const work = setup({ profiles: [{ id: PROFILE, name: 'Work', current: true }] })
    work.handler.show?.({ url: 'https://example.com/a', title: 'T' })
    await work.handler.request({ type: 'create', name: 'n', thisProfile: true })
    expect(FIRST(work.files)).toContain(`--orivon-profile=${PROFILE}`)
    work.files.clear()
    await work.handler.request({ type: 'create', name: 'n', thisProfile: false })
    expect(FIRST(work.files)).not.toContain('--orivon-profile')
    const plain = setup()
    plain.handler.show?.({ url: 'https://example.com/a', title: 'T' })
    await plain.handler.request({ type: 'create', name: 'n', thisProfile: true })
    expect(FIRST(plain.files)).not.toContain('--orivon-profile')
  })

  it('never writes a profile id that is not one this browser made', async () => {
    const { handler, files } = setup({ profiles: [{ id: 'x --evil', name: 'Odd', current: true }] })
    handler.show?.({ url: 'https://example.com/a', title: 'T' })
    await handler.request({ type: 'create', name: 'n', thisProfile: true })
    expect(FIRST(files)).not.toContain('evil')
  })

  it('validates every request: no address, path or extra field is taken from the page', async () => {
    const { handler, files } = setup()
    handler.show?.({ url: 'https://example.com/a', title: 'T' })
    for (const bad of [undefined, null, 'create', {}, { type: 'create' }, { type: 'create', name: 3, thisProfile: false }, { type: 'create', name: 'n', thisProfile: 'yes' },
      { type: 'create', name: 'n', thisProfile: false, url: 'https://evil.example/' }, { type: 'create', name: 'n', thisProfile: false, path: '/etc/cron.d/x' },
      { type: 'create', name: 'x'.repeat(2000), thisProfile: false }, { type: 'delete', name: 'n', thisProfile: false }]) {
      expect(await handler.request(bad), JSON.stringify(bad)?.slice(0, 40)).toBeUndefined()
    }
    expect(files.size).toBe(0)
  })

  it('does nothing before it was shown, and nothing at all in a private session', async () => {
    const { handler, files } = setup()
    expect(await handler.request({ type: 'create', name: 'n', thisProfile: false })).toBeUndefined()
    const priv = setup({ isPrivate: true })
    priv.handler.show?.({ url: 'https://example.com/a', title: 'T' })
    expect(await priv.handler.request({ type: 'create', name: 'n', thisProfile: false })).toBeUndefined()
    expect(files.size + priv.files.size).toBe(0)
  })
})
