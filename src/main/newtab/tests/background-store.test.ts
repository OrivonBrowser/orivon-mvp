import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_PICTURE_BYTES } from '../background-image.js'
import { BackgroundStore, type BackgroundSettings } from '../background-store.js'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

type Choice = 'orivon' | 'custom' | 'none'

/** Just enough of the settings store: one value that tells its listeners. */
function fakeSettings (initial: Choice = 'orivon', locked = false): BackgroundSettings & { value: () => Choice } {
  let value = initial
  const listeners = new Set<(change: { key: string, value: unknown }) => void>()
  const apply = (next: Choice): void => {
    if (next === value) return
    value = next
    for (const listener of listeners) listener({ key: 'appearance.newTabBackground', value })
  }
  return {
    get: () => value,
    set: (_key: string, next: unknown) => {
      if (locked) return { ok: false, reason: 'locked' }
      apply(next as Choice)
      return { ok: true }
    },
    onChange: (listener: (change: { key: string, value: unknown }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    value: () => value
  } as never
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

describe('BackgroundStore', () => {
  it('copies the chosen picture in, switches the setting to it and tells listeners', () => {
    const settings = fakeSettings()
    const store = new BackgroundStore(copy, settings)
    let told = 0
    store.onChange(() => { told += 1 })
    expect(store.install(source)).toEqual({ ok: true })
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
    expect(settings.value()).toBe('custom')
    expect(told).toBe(1)
    const now = store.current()
    expect(now).toMatchObject({ kind: 'custom', mime: 'image/png' })
    expect(existsSync(copy)).toBe(true)
  })

  it('leaves no temporary file beside the copy', () => {
    new BackgroundStore(copy, fakeSettings()).install(source)
    expect(readdirSync(dir).sort()).toEqual(['new-tab-background', 'picked.png'])
  })

  it('tells listeners when a picture replaces one already in use', () => {
    const store = new BackgroundStore(copy, fakeSettings('custom'))
    let told = 0
    store.onChange(() => { told += 1 })
    store.install(source)
    expect(told).toBe(1)
  })

  it('refuses a file that is not a picture, and keeps the picture and the setting it had', () => {
    const settings = fakeSettings()
    const store = new BackgroundStore(copy, settings)
    store.install(source)
    const other = join(dir, 'notes.png')
    writeFileSync(other, 'not an image at all')
    const answer = store.install(other)
    expect(answer.ok).toBe(false)
    expect(readFileSync(copy)).toEqual(Buffer.from(PNG))
    expect(settings.value()).toBe('custom')
  })

  it('refuses a missing file, a folder and a file over the cap', () => {
    const store = new BackgroundStore(copy, fakeSettings())
    expect(store.install(join(dir, 'gone.png')).ok).toBe(false)
    expect(store.install(dir).ok).toBe(false)
    const big = join(dir, 'big.png')
    writeFileSync(big, Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_PICTURE_BYTES)]))
    const answer = store.install(big)
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toMatch(/20 MB/)
    expect(existsSync(copy)).toBe(false)
  })

  it('removes the copy when the setting goes back to the Orivon picture or to none', () => {
    for (const next of ['orivon', 'none'] as const) {
      const settings = fakeSettings()
      const store = new BackgroundStore(copy, settings)
      store.install(source)
      let told = 0
      store.onChange(() => { told += 1 })
      settings.set('appearance.newTabBackground', next)
      expect(existsSync(copy)).toBe(false)
      expect(told).toBe(1)
      expect(store.current().kind).toBe(next)
    }
  })

  it('draws the Orivon picture when the setting says custom but no usable copy is there', () => {
    const settings = fakeSettings('custom')
    const store = new BackgroundStore(copy, settings)
    expect(store.current()).toEqual({ kind: 'orivon' })
    writeFileSync(copy, 'damaged')
    expect(store.current()).toEqual({ kind: 'orivon' })
  })

  it('does not touch the copy on startup, before the settings are read', () => {
    writeFileSync(copy, PNG)
    new BackgroundStore(copy, fakeSettings('orivon'))
    expect(existsSync(copy)).toBe(true)
  })

  it('takes the copy back and says so when the setting cannot be switched', () => {
    const store = new BackgroundStore(copy, fakeSettings('orivon', true))
    expect(store.install(source).ok).toBe(false)
    expect(existsSync(copy)).toBe(false)
  })

  it('answers from the bytes it has checked until the picture changes', () => {
    const store = new BackgroundStore(copy, fakeSettings())
    store.install(source)
    const first = store.current()
    expect(store.current()).toBe(first)
    const other = join(dir, 'other.png')
    writeFileSync(other, Uint8Array.from([...PNG, 9, 9, 9]))
    store.install(other)
    expect(store.current()).not.toBe(first)
    expect((store.current() as { bytes: Uint8Array }).bytes.length).toBe(PNG.length + 3)
  })

  it('answers with a buffer of exactly the picture, never a view into a larger one', () => {
    const store = new BackgroundStore(copy, fakeSettings())
    store.install(source)
    const { bytes } = store.current() as { bytes: Uint8Array }
    expect(bytes.byteOffset).toBe(0)
    expect(bytes.buffer.byteLength).toBe(PNG.length)
  })
})
