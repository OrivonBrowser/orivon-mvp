import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPageKeyListener, defaultKeyStillBound } from '../page-key-ipc.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'
import type { PageKeyTab } from '../page-key-ipc.js'

const FRAME = { url: 'https://app.example/' }
const sender = { id: 7, mainFrame: FRAME }

function setup (tab: Partial<PageKeyTab> | null = {}, allow: (id: number) => boolean = () => true, stillBound: () => boolean = () => true): { send: (payload: unknown, frame?: unknown) => void, run: ReturnType<typeof vi.fn> } {
  const run = vi.fn()
  const listener = createPageKeyListener({
    tabOf: () => (tab === null ? null : { active: true, isAppTab: true, suspended: false, run, ...tab }),
    stillBound
  }, allow)
  return { run, send: (payload, frame = FRAME) => { listener({ sender, senderFrame: frame } as never, payload) } }
}

describe('a registered app asking for the browser\'s find bar', () => {
  it('opens find for the tab in front', () => {
    const { send, run } = setup()
    send({ command: 'find.open' })
    expect(run).toHaveBeenCalledWith('find.open')
  })

  it.each([
    ['a command that is not on the list', { command: 'tab.close' }],
    ['no command', {}],
    ['a payload that is not an object', 'find.open']
  ])('ignores %s', (_label, payload) => {
    const { send, run } = setup()
    send(payload)
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores a message from a subframe', () => {
    const { send, run } = setup()
    send({ command: 'find.open' }, { url: 'https://other.example/' })
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['a view in no window', null],
    ['a tab behind the one in front', { active: false }],
    ['an ordinary website, whose key the browser already took', { isAppTab: false }],
    ['a window whose page holds the screen', { suspended: true }]
  ])('ignores %s', (_label, tab) => {
    const { send, run } = setup(tab)
    send({ command: 'find.open' })
    expect(run).not.toHaveBeenCalled()
  })

  it('does nothing once the person rebound or cleared the key the page reports', () => {
    const { send, run } = setup({}, () => true, () => false)
    send({ command: 'find.open' })
    expect(run).not.toHaveBeenCalled()
  })

  it('drops what a page sends faster than the limit allows', () => {
    const { send, run } = setup({}, () => false)
    send({ command: 'find.open' })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the default find key, as the person has bound it', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-page-key-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
  const serviceFor = async (platform: NodeJS.Platform): Promise<ShortcutService> => {
    const store = new ShortcutStore(join(dir, 'shortcuts.json'), platform)
    await store.load()
    return new ShortcutService(store, platform)
  }

  it.each(['linux', 'darwin'] as const)('is bound on %s until it is rebound or cleared', async (platform) => {
    const service = await serviceFor(platform)
    expect(defaultKeyStillBound(service, 'find.open')).toBe(true)
    service.set('find.open', 'Mod+Shift+Y')
    expect(defaultKeyStillBound(service, 'find.open')).toBe(false)
    service.reset('find.open')
    expect(defaultKeyStillBound(service, 'find.open')).toBe(true)
    service.clear('find.open')
    expect(defaultKeyStillBound(service, 'find.open')).toBe(false)
  })
})
