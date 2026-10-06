import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { behaviorPath, clearOpenOnActionClick, createBehaviorStore, readOpenOnActionClick, writeOpenOnActionClick } from '../side-panel-behavior-file.js'
import { withTempDir } from './install-runner-fixtures.js'

describe('the saved toolbar behaviour', () => {
  it('is off until saved, then reads back what was saved', async () => {
    await withTempDir(async (dir) => {
      expect(readOpenOnActionClick(dir)).toBe(false)
      writeOpenOnActionClick(dir, true)
      expect(readOpenOnActionClick(dir)).toBe(true)
      writeOpenOnActionClick(dir, false)
      expect(readOpenOnActionClick(dir)).toBe(false)
    })
  })

  it('reads a damaged file as off, and clearing it is safe twice', async () => {
    await withTempDir(async (dir) => {
      writeFileSync(behaviorPath(dir), '{not json')
      expect(readOpenOnActionClick(dir)).toBe(false)
      clearOpenOnActionClick(dir)
      clearOpenOnActionClick(dir)
      expect(readOpenOnActionClick(dir)).toBe(false)
      expect(join(dir, 'side-panel-behavior.json')).toBe(behaviorPath(dir))
    })
  })
})

describe('the behaviour of a loaded extension', () => {
  it('is saved in the slot of the folder it is loaded from, with no registry entry for it yet', async () => {
    await withTempDir(async (dir) => {
      const loaded = join(dir, 'slot', 'version')
      mkdirSync(loaded, { recursive: true })
      const store = createBehaviorStore((id) => id === 'fresh' ? loaded : undefined)
      store.write('fresh', true)
      expect(readOpenOnActionClick(join(dir, 'slot'))).toBe(true)
      expect(store.read('fresh')).toBe(true)
    })
  })

  it('reads off and writes nothing for an extension that is not loaded', async () => {
    await withTempDir(async (dir) => {
      const store = createBehaviorStore(() => undefined)
      store.write('gone', true)
      expect(store.read('gone')).toBe(false)
      expect(readOpenOnActionClick(dir)).toBe(false)
    })
  })
})
