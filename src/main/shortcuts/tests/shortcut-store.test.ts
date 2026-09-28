import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
let file: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-shortcuts-')); file = join(dir, 'nested', 'shortcuts.json') })
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })

const onDisk = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'))

describe('ShortcutStore', () => {
  it('has changed nothing when there is no file', async () => {
    const store = new ShortcutStore(file, 'linux')
    await store.load()

    expect(store.get('tab.new')).toBeUndefined()
  })

  it('remembers a changed binding and a cleared one across a restart, and forgets a change put back to the default', async () => {
    const store = new ShortcutStore(file, 'linux')
    await store.load()
    store.setMany(new Map([['tab.new', 'Mod+Alt+T'], ['tab.close', null], ['nav.reload', 'Mod+Shift+F']]))
    store.setMany(new Map([['nav.reload', undefined]]))
    await store.flush()

    expect(await onDisk()).toEqual({ version: 1, bindings: { 'tab.new': 'Mod+Alt+T', 'tab.close': null } })
    const next = new ShortcutStore(file, 'linux')
    await next.load()
    expect(next.get('tab.new')).toBe('Mod+Alt+T')
    expect(next.get('tab.close')).toBeNull()
    expect(next.get('nav.reload')).toBeUndefined()
  })

  it('puts everything back with resetAll', async () => {
    const store = new ShortcutStore(file, 'linux')
    await store.load()
    store.setMany(new Map([['tab.new', 'Mod+Alt+T']]))

    store.resetAll()
    await store.flush()

    expect(await onDisk()).toEqual({ version: 1, bindings: {} })
  })

  it('drops an entry for no command, an unreadable binding, a reserved one and a wrong kind, and keeps the rest', async () => {
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, JSON.stringify({ version: 1, bindings: {
      'tab.new': 'Mod+Alt+T',
      'made.up': 'Mod+T',
      'tab.close': 'nonsense',
      'nav.reload': 'Mod+C',
      'nav.back': 5,
      'window.new': 'T'
    } }))
    const store = new ShortcutStore(file, 'linux')
    await store.load()

    expect(store.get('tab.new')).toBe('Mod+Alt+T')
    for (const id of ['tab.close', 'nav.reload', 'nav.back', 'window.new'] as const) expect(store.get(id)).toBeUndefined()
  })

  it.each([['not json'], ['[]'], [JSON.stringify({ version: 9, bindings: { 'tab.new': 'Mod+Alt+T' } })], [JSON.stringify({ version: 1, bindings: 'x' })]])('starts from the defaults for a file that is %s', async (content) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(join(dir, 'nested'), { recursive: true })
    await writeFile(file, content)
    const store = new ShortcutStore(file, 'linux')

    await expect(store.load()).resolves.toBeUndefined()
    expect(store.get('tab.new')).toBeUndefined()
  })
})
