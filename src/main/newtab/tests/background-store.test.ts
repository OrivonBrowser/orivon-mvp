import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PICTURE_BYTES } from '../background-image.js'
import { BackgroundStore, type BackgroundSettings } from '../background-store.js'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

type Choice = 'orivon' | 'custom' | 'none'

interface Fake extends BackgroundSettings {
  value: () => Choice
  /** What the settings file's state says: true when it could not be read. */
  unreadable: boolean
}

/** Just enough of the settings store: one value that tells its listeners. */
function fakeSettings (initial: Choice = 'orivon', locked = false): Fake {
  let value = initial
  const listeners = new Set<(change: { key: string, value: unknown }) => void>()
  const apply = (next: Choice): void => {
    if (next === value) return
    value = next
    for (const listener of listeners) listener({ key: 'appearance.newTabBackground', value })
  }
  const fake = {
    unreadable: false,
    get: () => value,
    set: (_key: string, next: unknown) => {
      if (locked) return { ok: false, reason: 'locked' }
      apply(next as Choice)
      return { ok: true }
    },
    onChange: (listener: (change: { key: string, value: unknown }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    fileUnreadable: () => fake.unreadable,
    value: () => value
  }
  return fake as unknown as Fake
}

let dir: string
let copy: string
let source: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-newtab-bg-'))
  copy = join(dir, 'new-tab-background')
  source = join(dir, 'picked.png')
  writeFileSync(source, PNG)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const bytesOf = async (store: BackgroundStore): Promise<Uint8Array> => ((await store.current()) as { bytes: Uint8Array }).bytes

describe('BackgroundStore: installing', () => {
  it('copies the chosen picture in, switches the setting to it and tells listeners', async () => {
    const settings = fakeSettings()
    const store = new BackgroundStore(copy, settings)
    let told = 0
    store.onChange(() => { told += 1 })
    expect(await store.install(source)).toEqual({ ok: true })
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
    expect(settings.value()).toBe('custom')
    expect(told).toBe(1)
    expect(await store.current()).toMatchObject({ kind: 'custom', mime: 'image/png' })
    expect(await store.hasUsableCopy()).toBe(true)
  })

  it('leaves no temporary file beside the copy', async () => {
    await new BackgroundStore(copy, fakeSettings()).install(source)
    expect(readdirSync(dir).sort()).toEqual(['new-tab-background', 'picked.png'])
  })

  it('tells listeners when a picture replaces one already in use', async () => {
    const store = new BackgroundStore(copy, fakeSettings('custom'))
    let told = 0
    store.onChange(() => { told += 1 })
    await store.install(source)
    expect(told).toBe(1)
  })

  it('goes on telling the other listeners when one fails', async () => {
    const store = new BackgroundStore(copy, fakeSettings('custom'))
    let told = 0
    store.onChange(() => { throw new Error('a disposed page') })
    store.onChange(() => { told += 1 })
    await store.install(source)
    expect(told).toBe(1)
  })

  it('refuses a file that is not a picture, and keeps the picture and the setting it had', async () => {
    const settings = fakeSettings()
    const store = new BackgroundStore(copy, settings)
    await store.install(source)
    const other = join(dir, 'notes.png')
    writeFileSync(other, 'not an image at all')
    expect((await store.install(other)).ok).toBe(false)
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
    expect(settings.value()).toBe('custom')
  })

  it('refuses a missing file, a folder, an empty file and a file over the cap', async () => {
    const store = new BackgroundStore(copy, fakeSettings())
    expect((await store.install(join(dir, 'gone.png'))).ok).toBe(false)
    expect((await store.install(dir)).ok).toBe(false)
    const empty = join(dir, 'empty.png')
    writeFileSync(empty, '')
    expect((await store.install(empty)).ok).toBe(false)
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_PICTURE_BYTES)]))
    const answer = await store.install(big)
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toMatch(/20 MB/)
    expect(existsSync(copy)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('refuses a pipe at once instead of waiting for a writer', async () => {
    const pipe = join(dir, 'pipe.png')
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0)
    const store = new BackgroundStore(copy, fakeSettings())
    expect((await store.install(pipe)).ok).toBe(false)
    expect(existsSync(copy)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('takes a link to a picture', async () => {
    const link = join(dir, 'link.png')
    symlinkSync(source, link)
    expect(await new BackgroundStore(copy, fakeSettings()).install(link)).toEqual({ ok: true })
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
  })

  it('takes the copy back and says so when the setting cannot be switched', async () => {
    const store = new BackgroundStore(copy, fakeSettings('orivon', true))
    expect((await store.install(source)).ok).toBe(false)
    expect(existsSync(copy)).toBe(false)
    expect(await store.hasUsableCopy()).toBe(false)
  })
})

describe('BackgroundStore: what the page draws', () => {
  it('removes the copy when the setting goes back to the Orivon picture or to none', async () => {
    for (const next of ['orivon', 'none'] as const) {
      const settings = fakeSettings()
      const store = new BackgroundStore(copy, settings)
      await store.install(source)
      let told = 0
      store.onChange(() => { told += 1 })
      settings.set('appearance.newTabBackground', next)
      expect(told).toBe(1)
      expect((await store.current()).kind).toBe(next)
      await store.reconcile()
      expect(existsSync(copy)).toBe(false)
    }
  })

  it('does not let a removal that was asked for first take a picture installed after it', async () => {
    const settings = fakeSettings()
    const store = new BackgroundStore(copy, settings)
    await store.install(source)
    settings.set('appearance.newTabBackground', 'none')
    expect((await store.install(source)).ok).toBe(true)
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
    expect(settings.value()).toBe('custom')
  })

  it('draws the Orivon picture when the setting says custom but no usable copy is there', async () => {
    const store = new BackgroundStore(copy, fakeSettings('custom'))
    expect(await store.current()).toEqual({ kind: 'orivon' })
    writeFileSync(copy, 'damaged')
    expect(await store.current()).toEqual({ kind: 'orivon' })
  })

  it('answers from the bytes it has checked until the picture changes', async () => {
    const store = new BackgroundStore(copy, fakeSettings())
    await store.install(source)
    const first = await store.current()
    expect(await store.current()).toBe(first)
    const other = join(dir, 'other.png')
    writeFileSync(other, Uint8Array.from([...PNG, 9, 9, 9]))
    await store.install(other)
    expect((await bytesOf(store)).length).toBe(PNG.length + 3)
  })

  it('answers with a buffer of exactly the picture, never a view into a larger one', async () => {
    const fresh = new BackgroundStore(copy, fakeSettings('custom'))
    writeFileSync(copy, PNG)
    for (const bytes of [await bytesOf(fresh), await bytesOf(await installed())]) {
      expect(bytes.byteOffset).toBe(0)
      expect(bytes.buffer.byteLength).toBe(PNG.length)
    }
  })

  async function installed (): Promise<BackgroundStore> {
    const store = new BackgroundStore(copy, fakeSettings())
    await store.install(source)
    return store
  }
})

describe('BackgroundStore: reconcile', () => {
  it('removes a copy left behind when the setting is not custom', async () => {
    writeFileSync(copy, PNG)
    await new BackgroundStore(copy, fakeSettings('orivon')).reconcile()
    expect(existsSync(copy)).toBe(false)
  })

  it('keeps the copy of a setting that is custom', async () => {
    writeFileSync(copy, PNG)
    await new BackgroundStore(copy, fakeSettings('custom')).reconcile()
    expect(existsSync(copy)).toBe(true)
  })

  it('keeps the copy when the settings file could not be read, since the setting then says nothing', async () => {
    writeFileSync(copy, PNG)
    const settings = fakeSettings('orivon')
    settings.unreadable = true
    await new BackgroundStore(copy, settings).reconcile()
    expect(existsSync(copy)).toBe(true)
  })

  it('does nothing when there is no copy', async () => {
    mkdirSync(join(dir, 'x'))
    await expect(new BackgroundStore(copy, fakeSettings()).reconcile()).resolves.toBeUndefined()
  })
})
