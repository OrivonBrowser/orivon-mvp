import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearRestartMarker, MARKER_MAX_AGE_MS, takeRestartMarker, writeRestartMarker } from '../restart-marker.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-marker-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the restart marker', () => {
  it('is there for the start after an update, once', () => {
    writeRestartMarker(dir, 1000)
    expect(takeRestartMarker(dir, 2000)).toBe(true)
    expect(takeRestartMarker(dir, 2000)).toBe(false)
  })

  it('is not there when nothing wrote it', () => {
    expect(takeRestartMarker(dir)).toBe(false)
  })

  it('is removed and ignored when it belongs to an install that never finished', () => {
    writeRestartMarker(dir, 1000)
    expect(takeRestartMarker(dir, 1000 + MARKER_MAX_AGE_MS + 1)).toBe(false)
    expect(existsSync(join(dir, 'restore-after-update'))).toBe(false)
  })

  it('is ignored when its content is not a time, or is a time to come', () => {
    writeFileSync(join(dir, 'restore-after-update'), 'junk')
    expect(takeRestartMarker(dir)).toBe(false)
    writeRestartMarker(dir, 5000)
    expect(takeRestartMarker(dir, 1000)).toBe(false)
  })

  it('can be taken back when the install fails', () => {
    writeRestartMarker(dir, 1000)
    clearRestartMarker(dir)
    expect(takeRestartMarker(dir, 1500)).toBe(false)
  })
})
