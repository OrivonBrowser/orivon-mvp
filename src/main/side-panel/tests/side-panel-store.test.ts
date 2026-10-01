import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_VIEW, FileSidePanelStore, MemorySidePanelStore, parsePrefs } from '../side-panel-store.js'
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN } from '../side-panel-model.js'

describe('parsePrefs', () => {
  it('reads what this version wrote', () => {
    expect(parsePrefs({ version: 1, width: 420, view: 'history' })).toEqual({ width: 420, view: 'history' })
  })

  it('falls back to the defaults for anything else', () => {
    const defaults = { width: PANEL_DEFAULT, view: DEFAULT_VIEW }
    for (const bad of [null, 'text', 4, [], {}, { version: 2, width: 420, view: 'history' }]) expect(parsePrefs(bad)).toEqual(defaults)
  })

  it('keeps each field on its own: a bad width keeps the view, and the other way round', () => {
    expect(parsePrefs({ version: 1, width: 'wide', view: 'history' })).toEqual({ width: PANEL_DEFAULT, view: 'history' })
    expect(parsePrefs({ version: 1, width: 420, view: '../x' })).toEqual({ width: 420, view: DEFAULT_VIEW })
  })

  it('clamps a width to the panel limits', () => {
    expect(parsePrefs({ version: 1, width: 10, view: 'a' }).width).toBe(PANEL_MIN)
    expect(parsePrefs({ version: 1, width: 5000, view: 'a' }).width).toBe(PANEL_MAX)
  })
})

describe('the memory store', () => {
  it('remembers a change and writes nothing', async () => {
    const store = new MemorySidePanelStore()
    store.set({ width: 500 })
    store.set({ view: 'downloads' })
    expect(store.get()).toEqual({ width: 500, view: 'downloads' })
    await store.flush()
  })
})

describe('the file store', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-side-panel-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('starts from the defaults when there is no file', () => {
    expect(new FileSidePanelStore(join(dir, 'side-panel.json')).get()).toEqual({ width: PANEL_DEFAULT, view: DEFAULT_VIEW })
  })

  it('writes a change and reads it back in the next run', async () => {
    const file = join(dir, 'nested', 'side-panel.json')
    const store = new FileSidePanelStore(file)
    store.set({ width: 444, view: 'history' })
    await store.flush()

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, width: 444, view: 'history' })
    expect(new FileSidePanelStore(file).get()).toEqual({ width: 444, view: 'history' })
  })

  it('reads a corrupt file as the defaults', async () => {
    const file = join(dir, 'side-panel.json')
    await writeFile(file, '{ not json')
    expect(new FileSidePanelStore(file).get()).toEqual({ width: PANEL_DEFAULT, view: DEFAULT_VIEW })
  })

  it('writes nothing for a change that changes nothing', async () => {
    const file = join(dir, 'side-panel.json')
    const store = new FileSidePanelStore(file)
    store.set({ width: PANEL_DEFAULT })
    await store.flush()
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})
