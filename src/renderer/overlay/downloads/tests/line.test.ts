import { describe, expect, it } from 'vitest'
import type { DownloadEntry } from '../../../../main/downloads/download-types.js'
import { isRemovable, lineFor, primaryAction, rowActions, showsFolderBadge } from '../line.js'

const entry = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 'a', url: 'https://example.org/f.bin', referrer: '', fileName: 'f.bin', savePath: '', mime: '', total: 80 * 1024 * 1024, received: 12.4 * 1024 * 1024,
  state: 'completed', startedAt: 1, danger: false, ...over
})
const ids = (over: Partial<DownloadEntry>): string[] => rowActions(entry(over)).map((action) => action.id)

describe('lineFor', () => {
  it('says how far a running download is and how long it has left, without the speed, so it fits the bubble', () => {
    expect(lineFor(entry({ state: 'progressing', speed: 1024 * 1024 }))).toBe('12 MB / 80 MB · 2 min left')
    expect(lineFor(entry({ state: 'paused' }))).toBe('Paused · 12 MB of 80 MB')
  })

  it('gives a finished file its size and its host', () => {
    expect(lineFor(entry())).toBe('80 MB · example.org')
    expect(lineFor(entry({ total: 0, received: 2048 }))).toBe('2 KB · example.org')
  })

  it('says why a download failed, and that a file is gone', () => {
    expect(lineFor(entry({ state: 'interrupted', reason: 'network' }))).toBe('Failed: network error')
    expect(lineFor(entry({ state: 'interrupted', reason: 'disk' }))).toBe('Failed: disk full or no permission')
    expect(lineFor(entry({ state: 'interrupted' }))).toBe('Failed: network error')
    expect(lineFor(entry({ state: 'cancelled' }))).toBe('Cancelled')
    expect(lineFor(entry({ missing: true }))).toBe('Moved or deleted')
  })

  it('warns about a held file', () => {
    expect(lineFor(entry({ state: 'held', danger: true }))).toBe('This type of file can harm your computer.')
  })
})

describe('rowActions', () => {
  it('offers Pause and Cancel while running, Resume and Cancel when paused', () => {
    expect(ids({ state: 'progressing' })).toEqual(['pause', 'cancel'])
    expect(ids({ state: 'paused' })).toEqual(['resume', 'cancel'])
  })

  it('offers Show in folder for a finished file, and Retry for a failed, cancelled or vanished one', () => {
    expect(ids({})).toEqual(['showInFolder'])
    expect(ids({ missing: true })).toEqual(['retry'])
    expect(ids({ state: 'interrupted' })).toEqual(['retry'])
    expect(ids({ state: 'cancelled' })).toEqual(['retry'])
  })

  it('offers Discard first and Keep second for a held file, as labelled buttons', () => {
    expect(rowActions(entry({ state: 'held' }))).toEqual([
      { id: 'discard', label: 'Discard', text: true },
      { id: 'keep', label: 'Keep', text: true }
    ])
  })

  it('reveals only the quiet actions on aim', () => {
    expect(rowActions(entry())[0]?.reveal).toBe(true)
    expect(rowActions(entry({ state: 'progressing' })).some((action) => action.reveal === true)).toBe(false)
  })
})

describe('primaryAction', () => {
  it('opens a finished file, but shows a type that runs code in its folder', () => {
    expect(primaryAction(entry())).toBe('open')
    expect(primaryAction(entry({ danger: true }))).toBe('showInFolder')
  })

  it('resumes a paused download and retries a failed one', () => {
    expect(primaryAction(entry({ state: 'paused' }))).toBe('resume')
    expect(primaryAction(entry({ state: 'interrupted' }))).toBe('retry')
    expect(primaryAction(entry({ state: 'cancelled' }))).toBe('retry')
  })

  it('does nothing for a running download, a held file or a file that is gone', () => {
    expect(primaryAction(entry({ state: 'progressing' }))).toBeNull()
    expect(primaryAction(entry({ state: 'held' }))).toBeNull()
    expect(primaryAction(entry({ missing: true }))).toBeNull()
  })
})

describe('isRemovable and showsFolderBadge', () => {
  it('lets Delete take a finished row off, never a running or held one', () => {
    expect(isRemovable(entry())).toBe(true)
    expect(isRemovable(entry({ state: 'interrupted' }))).toBe(true)
    expect(isRemovable(entry({ state: 'progressing' }))).toBe(false)
    expect(isRemovable(entry({ state: 'held' }))).toBe(false)
  })

  it('shows the badge on a kept dangerous file only while it is there', () => {
    expect(showsFolderBadge(entry({ danger: true }))).toBe(true)
    expect(showsFolderBadge(entry({ danger: true, missing: true }))).toBe(false)
    expect(showsFolderBadge(entry({ danger: true, state: 'held' }))).toBe(false)
    expect(showsFolderBadge(entry())).toBe(false)
  })
})
