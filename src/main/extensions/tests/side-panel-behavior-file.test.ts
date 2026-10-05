import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { behaviorPath, clearOpenOnActionClick, readOpenOnActionClick, writeOpenOnActionClick } from '../side-panel-behavior-file.js'
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
